#!/usr/bin/env python3
"""App con login y un botón para generar el Reporte de Vendedores de CargoLink.

Backend de datos: Postgres (Supabase), vía DATABASE_URL. Pensada para correr
tanto local como en una plataforma serverless (Vercel): no depende de disco
persistente ni de subprocesos — la descarga de CargoLink corre inline y los
resultados se guardan directo en la base de datos.
"""

import csv
import io
import json
import os
import re
import secrets
from datetime import datetime
from functools import wraps
from zoneinfo import ZoneInfo

import openpyxl
import psycopg
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from flask import Flask, flash, redirect, render_template, request, send_file, session, url_for
from psycopg.rows import dict_row

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
TZ_LOCAL = ZoneInfo(os.environ.get("TZ_LOCAL", "America/Mexico_City"))
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

CARGOLINK_LOGIN_URL = "https://fwd.cargolink.mx/seguridad/control.php?loginfrom=usuario"
CARGOLINK_REPORT_URL = "https://fwd.cargolink.mx/templates/pdfs/excel_vendedores.php"
CARGOLINK_REPORTE_CLIENTES_URL = "https://fwd.cargolink.mx/templates/pdfs/ReporteClientesExcel.php"


def get_secret_key():
    env_key = (os.environ.get("SECRET_KEY") or "").strip()
    if env_key:
        return env_key
    # Sin SECRET_KEY fija, las sesiones no sobreviven un reinicio del proceso
    # (normal en serverless). Sirve para correr rápido en local sin configurar nada.
    return secrets.token_hex(32)


def get_db():
    if not DATABASE_URL:
        raise RuntimeError("Falta la variable de entorno DATABASE_URL.")
    return psycopg.connect(DATABASE_URL, row_factory=dict_row)


def init_db():
    """Crea las tablas si no existen (primer arranque en una base vacía).

    El login usa el catálogo de accesos de Seguimiento de Importaciones
    (auth.users + public.app_user_permissions, mismo proyecto Supabase) en
    vez de una tabla de usuarios propia."""
    db = get_db()
    db.execute("""
        CREATE TABLE IF NOT EXISTS catalogo_vendedores (
            id bigint generated always as identity primary key,
            vendedor text not null unique,
            plaza text not null,
            ocultar_detalle boolean not null default false
        );
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS catalogo_desarrolladores (
            id bigint generated always as identity primary key,
            desarrollador text not null unique,
            plaza text not null
        );
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS catalogo_presupuesto (
            id bigint generated always as identity primary key,
            mes text not null,
            vendedor text,
            desarrollador text,
            presupuesto numeric not null,
            CONSTRAINT chk_catalogo_presupuesto_vendedor_o_desarrollador
                CHECK (vendedor IS NOT NULL OR desarrollador IS NOT NULL)
        );
    """)
    db.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogo_presupuesto_mes_vendedor_dev
            ON catalogo_presupuesto (mes, coalesce(vendedor, ''), coalesce(desarrollador, ''));
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS reporte_bookings (
            id bigint generated always as identity primary key,
            mes text not null,
            vendedor text not null,
            referencia text,
            fecha timestamptz,
            ejecutivo text,
            venta_por text,
            cliente_servicio text,
            venta numeric not null default 0,
            profit numeric not null default 0,
            margen numeric not null default 0
        );
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_reporte_bookings_mes_vendedor ON reporte_bookings (mes, vendedor);")
    db.execute("""
        CREATE TABLE IF NOT EXISTS reporte_generaciones (
            id bigint generated always as identity primary key,
            fecha_inicio date not null,
            fecha_fin date not null,
            generado_en timestamptz not null default now()
        );
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS asignacion_de_clientes (
            id bigint generated always as identity primary key,
            folio integer,
            razon_social text not null,
            vendedor text,
            desarrollador text,
            tipo_cliente text,
            fecha_creacion timestamptz not null default now(),
            cant_booking integer not null default 0,
            fecha_ultimo_booking timestamptz
        );
    """)
    db.execute("""
        CREATE UNIQUE INDEX IF NOT EXISTS uq_asignacion_de_clientes_folio
            ON asignacion_de_clientes (folio);
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS usuario_plazas (
            id bigint generated always as identity primary key,
            usuario_id bigint not null references usuarios(id) on delete cascade,
            plaza text not null,
            unique (usuario_id, plaza)
        );
    """)
    db.execute("""
        CREATE TABLE IF NOT EXISTS registro_ingresos (
            id bigint generated always as identity primary key,
            usuario_id bigint references usuarios(id) on delete set null,
            usuario text not null,
            fecha_hora timestamptz not null default now()
        );
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_registro_ingresos_fecha ON registro_ingresos (fecha_hora desc);")
    db.commit()
    db.close()


def parse_presupuesto(raw):
    cleaned = (raw or "").replace(",", "").replace("$", "").replace(" ", "").strip()
    return float(cleaned)


MESES_ES = [
    "Enero", "Febrero", "Marzo", "Abril", "Mayo", "Junio",
    "Julio", "Agosto", "Septiembre", "Octubre", "Noviembre", "Diciembre",
]


def get_vendedores(db):
    filas = db.execute("SELECT vendedor FROM catalogo_vendedores ORDER BY vendedor").fetchall()
    return [f["vendedor"] for f in filas]


def get_desarrolladores(db):
    filas = db.execute("SELECT desarrollador FROM catalogo_desarrolladores ORDER BY desarrollador").fetchall()
    return [f["desarrollador"] for f in filas]


def opciones_mes():
    anio_actual = datetime.now().year
    opciones = []
    for anio in range(anio_actual - 1, anio_actual + 2):
        for mes_num, nombre in enumerate(MESES_ES, start=1):
            opciones.append({"value": f"{anio}-{mes_num:02d}", "label": f"{nombre} - {anio}"})
    return opciones


MESES_VALIDOS = {opt["value"] for opt in opciones_mes()}
PRESUPUESTO_COLUMNAS = ["mes", "vendedor", "desarrollador", "presupuesto"]


def leer_filas_csv(file_storage):
    stream = io.StringIO(file_storage.stream.read().decode("utf-8-sig"))
    reader = csv.DictReader(stream)
    return [{(k or "").strip().lower(): v for k, v in row.items()} for row in reader]


def leer_filas_xlsx(file_storage):
    wb = openpyxl.load_workbook(file_storage, data_only=True)
    ws = wb.active
    filas_iter = ws.iter_rows(values_only=True)
    header = [str(h).strip().lower() if h is not None else "" for h in next(filas_iter)]
    resultado = []
    for row in filas_iter:
        if not any(v not in (None, "") for v in row):
            continue
        resultado.append(dict(zip(header, row)))
    return resultado


def normalizar(texto):
    return (texto or "").strip().upper()


def extraer_tipo_servicio(referencia):
    """El tipo de servicio (FCLI, LCLI, DA, AI, FTL, ...) es el tercer
    segmento de la referencia, ej. '2608-3798-FCLI' -> 'FCLI'."""
    partes = (referencia or "").split("-")
    if len(partes) >= 3:
        return "-".join(partes[2:]).strip().upper() or "Sin tipo"
    return "Sin tipo"


def descargar_bookings_cargolink(fecha_inicio, fecha_fin):
    """Se conecta a CargoLink, descarga el reporte de vendedores del rango
    dado y regresa una lista de dicts (uno por booking). No toca el disco."""
    usuario = (os.environ.get("CARGOLINK_USUARIO") or "").strip()
    password = (os.environ.get("CARGOLINK_PASSWORD") or "").strip()
    if not usuario or not password:
        raise RuntimeError("Faltan las variables de entorno CARGOLINK_USUARIO / CARGOLINK_PASSWORD.")

    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
    sesion = requests.Session()
    r_login = sesion.post(CARGOLINK_LOGIN_URL, data={"usuario": usuario, "password": password}, headers=headers, timeout=60)
    if r_login.status_code != 200 or '"activo"' not in r_login.text:
        raise RuntimeError("No se pudo iniciar sesión en CargoLink.")

    report_url = (
        f"{CARGOLINK_REPORT_URL}?fecha_inicio={fecha_inicio}&fecha_fin={fecha_fin}&"
        f"ejecutivo=undefined&vendedor=undefined&id_cliente=undefined&"
        f"sucursal=undefined&id_cliente_factura=undefined&status_booking=1,2"
    )
    res = sesion.get(report_url, headers=headers, timeout=120)
    if res.status_code != 200 or len(res.content) == 0:
        raise RuntimeError("Error al descargar el reporte desde CargoLink.")

    soup = BeautifulSoup(res.content, "html.parser")
    header_map = None
    bookings = []
    campos_necesarios = {
        "Referencia": "referencia", "Fecha de creacion": "fecha", "Vendedor": "vendedor",
        "Ejecutivo": "ejecutivo", "Venta por": "venta_por", "Cliente servicio": "cliente_servicio",
        "Venta": "venta", "Profit": "profit", "Margen": "margen",
    }

    for tr in soup.find_all("tr"):
        celdas = [td.get_text(strip=True) for td in tr.find_all(["th", "td"])]
        if not celdas:
            continue
        if len(celdas) == 1:
            continue  # fila de título ("REPORTE DE VENDEDORES")
        if "Referencia" in celdas or "Vendedor" in celdas:
            header_map = {i: nombre for i, nombre in enumerate(celdas)}
            continue
        if header_map is None:
            continue

        fila = {campos_necesarios[header_map[i]]: v for i, v in enumerate(celdas) if header_map.get(i) in campos_necesarios}
        if not fila.get("vendedor") or not fila.get("fecha"):
            continue

        fecha_texto = fila["fecha"].split(" ")[0]
        try:
            fecha_dt = datetime.strptime(fila["fecha"], "%Y-%m-%d %H:%M:%S")
        except ValueError:
            try:
                fecha_dt = datetime.strptime(fecha_texto, "%Y-%m-%d")
            except ValueError:
                continue

        def num(v):
            v = (v or "0").replace(",", "").replace("$", "").replace("%", "").strip()
            try:
                return float(v)
            except ValueError:
                return 0.0

        bookings.append({
            "mes": fecha_dt.strftime("%Y-%m"),
            "vendedor": fila["vendedor"],
            "referencia": fila.get("referencia", ""),
            "fecha": fecha_dt,
            "ejecutivo": fila.get("ejecutivo", ""),
            "venta_por": fila.get("venta_por", ""),
            "cliente_servicio": fila.get("cliente_servicio", ""),
            "venta": num(fila.get("venta")),
            "profit": num(fila.get("profit")),
            "margen": num(fila.get("margen")),
        })

    return bookings


def descargar_reporte_clientes_cargolink():
    """Se conecta a CargoLink, descarga el Reporte de Clientes (excel real,
    no HTML) y regresa una lista de dicts (uno por cliente). No toca el
    disco. Columnas del excel: FOLIO, RAZÓN SOCIAL, VENDEDOR, DESARROLLADOR,
    TIPO DE CLIENTE, SUCURSAL, FECHA DE CREACIÓN, CANT BOOKING,
    F. ÚLT. BOOKING (SUCURSAL no se usa, no está en asignacion_de_clientes)."""
    usuario = (os.environ.get("CARGOLINK_USUARIO") or "").strip()
    password = (os.environ.get("CARGOLINK_PASSWORD") or "").strip()
    if not usuario or not password:
        raise RuntimeError("Faltan las variables de entorno CARGOLINK_USUARIO / CARGOLINK_PASSWORD.")

    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
    sesion = requests.Session()
    r_login = sesion.post(CARGOLINK_LOGIN_URL, data={"usuario": usuario, "password": password}, headers=headers, timeout=60)
    if r_login.status_code != 200 or '"activo"' not in r_login.text:
        raise RuntimeError("No se pudo iniciar sesión en CargoLink.")

    res = sesion.get(
        CARGOLINK_REPORTE_CLIENTES_URL,
        params={"cliente": "", "t_cliente": "", "vendedor": "", "sucursal": "", "desarrollador": "", "industria": ""},
        headers=headers,
        timeout=120,
    )
    if res.status_code != 200 or len(res.content) == 0:
        raise RuntimeError("Error al descargar el Reporte de Clientes desde CargoLink.")

    wb = openpyxl.load_workbook(io.BytesIO(res.content), data_only=True)
    ws = wb.active

    def parse_fecha(v):
        if not v:
            return None
        if isinstance(v, datetime):
            return v
        texto = str(v).strip()
        for formato in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
            try:
                return datetime.strptime(texto, formato)
            except ValueError:
                continue
        return None

    header = None
    clientes = []
    for row in ws.iter_rows(values_only=True):
        if header is None:
            if row and row[0] == "FOLIO":
                header = [str(h).strip() if h is not None else "" for h in row]
            continue
        if not row or row[0] is None:
            continue

        dato = dict(zip(header, row))
        try:
            folio = int(dato.get("FOLIO"))
        except (TypeError, ValueError):
            continue

        clientes.append({
            "folio": folio,
            "razon_social": (dato.get("RAZÓN SOCIAL") or "").strip() or "(sin nombre)",
            "vendedor": (dato.get("VENDEDOR") or "").strip() or None,
            "desarrollador": (dato.get("DESARROLLADOR") or "").strip() or None,
            "tipo_cliente": (dato.get("TIPO DE CLIENTE") or "").strip() or None,
            # fecha_creacion es NOT NULL en la tabla; si CargoLink no trae
            # una fecha parseable (no debería pasar, pero por seguridad),
            # se usa el momento de la descarga en vez de mandar NULL.
            "fecha_creacion": parse_fecha(dato.get("FECHA DE CREACIÓN")) or datetime.now(TZ_LOCAL),
            "cant_booking": int(dato.get("CANT BOOKING") or 0),
            "fecha_ultimo_booking": parse_fecha(dato.get("F. ÚLT. BOOKING")),
        })

    return clientes


def construir_datos_dashboard(plazas_permitidas=None):
    db = get_db()
    meta = db.execute(
        "SELECT fecha_inicio, fecha_fin, generado_en FROM reporte_generaciones ORDER BY generado_en DESC LIMIT 1"
    ).fetchone()
    if meta is None:
        db.close()
        return None

    catalogo_vendedor = {}
    for r in db.execute("SELECT vendedor, plaza, ocultar_detalle FROM catalogo_vendedores"):
        catalogo_vendedor[normalizar(r["vendedor"])] = {
            "plaza": r["plaza"],
            "nombre": r["vendedor"],
            "ocultar_detalle": r["ocultar_detalle"],
        }

    catalogo_desarrollador = {}
    for r in db.execute("SELECT desarrollador, plaza FROM catalogo_desarrolladores"):
        catalogo_desarrollador[normalizar(r["desarrollador"])] = {"plaza": r["plaza"], "nombre": r["desarrollador"]}

    presupuesto_por_mes_vendedor = {}
    for r in db.execute("SELECT mes, vendedor, presupuesto FROM catalogo_presupuesto WHERE vendedor IS NOT NULL"):
        clave = (r["mes"], normalizar(r["vendedor"]))
        presupuesto_por_mes_vendedor[clave] = presupuesto_por_mes_vendedor.get(clave, 0.0) + float(r["presupuesto"])

    presupuesto_por_mes_desarrollador = {}
    for r in db.execute("SELECT mes, desarrollador, presupuesto FROM catalogo_presupuesto WHERE desarrollador IS NOT NULL"):
        clave = (r["mes"], normalizar(r["desarrollador"]))
        presupuesto_por_mes_desarrollador[clave] = presupuesto_por_mes_desarrollador.get(clave, 0.0) + float(r["presupuesto"])

    bookings = db.execute(
        "SELECT mes, vendedor, referencia, fecha, ejecutivo, venta_por, cliente_servicio, venta, profit, margen "
        "FROM reporte_bookings"
    ).fetchall()
    db.close()

    agregados = {}
    agregados_desarrollador = {}
    detalle = []
    for r in bookings:
        vkey = normalizar(r["vendedor"])
        cat = catalogo_vendedor.get(vkey)
        plaza_vendedor = cat["plaza"] if cat else "#N/D"
        vendedor_permitido = plazas_permitidas is None or plaza_vendedor in plazas_permitidas

        dkey = normalizar(r["ejecutivo"]) if r["ejecutivo"] else None

        if vendedor_permitido:
            clave = (r["mes"], vkey)
            agg = agregados.setdefault(clave, {"cant_book": 0, "venta": 0.0, "profit": 0.0})
            agg["cant_book"] += 1
            agg["venta"] += float(r["venta"])
            agg["profit"] += float(r["profit"])

        if dkey and vendedor_permitido:
            agg_d = agregados_desarrollador.setdefault((r["mes"], dkey), {"cant_book": 0, "venta": 0.0, "profit": 0.0})
            agg_d["cant_book"] += 1
            agg_d["venta"] += float(r["venta"])
            agg_d["profit"] += float(r["profit"])

        nombre_canonico = cat["nombre"] if cat else r["vendedor"]
        # Los totales (agregados/filas de arriba) siempre incluyen a todos los
        # vendedores; solo el detalle a nivel booking se omite para quien
        # tenga marcado "ocultar_detalle" en su catálogo. El criterio
        # mandatorio de plaza es el vendedor: que el desarrollador/customer
        # esté catalogado en una plaza permitida NO basta para mostrar la
        # venta si el vendedor que la vendió es de otra plaza.
        if vendedor_permitido and not (cat and cat["ocultar_detalle"]):
            detalle.append({
                "mes": r["mes"],
                "vendedor": nombre_canonico,
                "referencia": r["referencia"] or "",
                "fecha": r["fecha"].strftime("%Y-%m-%d %H:%M") if r["fecha"] else "",
                "ejecutivo": r["ejecutivo"] or "",
                "venta_por": r["venta_por"] or "",
                "cliente_servicio": r["cliente_servicio"] or "",
                "venta": round(float(r["venta"]), 2),
                "profit": round(float(r["profit"]), 2),
                "margen": round(float(r["margen"]), 4),
            })

    for clave in presupuesto_por_mes_vendedor:
        _, vkey = clave
        cat = catalogo_vendedor.get(vkey)
        plaza = cat["plaza"] if cat else "#N/D"
        if plazas_permitidas is None or plaza in plazas_permitidas:
            agregados.setdefault(clave, {"cant_book": 0, "venta": 0.0, "profit": 0.0})
    for clave in presupuesto_por_mes_desarrollador:
        _, dkey = clave
        cat = catalogo_desarrollador.get(dkey)
        plaza = cat["plaza"] if cat else "#N/D"
        if plazas_permitidas is None or plaza in plazas_permitidas:
            agregados_desarrollador.setdefault(clave, {"cant_book": 0, "venta": 0.0, "profit": 0.0})

    filas = []
    for (mes, vkey), agg in agregados.items():
        cat = catalogo_vendedor.get(vkey)
        plaza = cat["plaza"] if cat else "#N/D"
        nombre = cat["nombre"] if cat else vkey
        ppto = presupuesto_por_mes_vendedor.get((mes, vkey), 0.0)
        filas.append({
            "mes": mes,
            "vendedor": nombre,
            "plaza": plaza,
            "cant_book": agg["cant_book"],
            "venta": round(agg["venta"], 2),
            "profit": round(agg["profit"], 2),
            "ppto": round(ppto, 2),
        })

    filas_desarrolladores = []
    for (mes, dkey), agg in agregados_desarrollador.items():
        cat = catalogo_desarrollador.get(dkey)
        plaza = cat["plaza"] if cat else "#N/D"
        nombre = cat["nombre"] if cat else dkey
        ppto = presupuesto_por_mes_desarrollador.get((mes, dkey), 0.0)
        filas_desarrolladores.append({
            "mes": mes,
            "desarrollador": nombre,
            "plaza": plaza,
            "cant_book": agg["cant_book"],
            "venta": round(agg["venta"], 2),
            "profit": round(agg["profit"], 2),
            "ppto": round(ppto, 2),
        })

    todos_los_meses = sorted(set(f["mes"] for f in filas) | set(f["mes"] for f in filas_desarrolladores))
    mes_actual = datetime.now().strftime("%Y-%m")
    if mes_actual not in todos_los_meses:
        todos_los_meses.append(mes_actual)
        todos_los_meses.sort()

    return {
        "archivo": f"Reporte {meta['fecha_inicio']} al {meta['fecha_fin']}",
        "generado_en": meta["generado_en"].astimezone(TZ_LOCAL).strftime("%d/%m/%Y %H:%M"),
        "filas": filas,
        "filas_desarrolladores": filas_desarrolladores,
        "detalle": detalle,
        "meses": todos_los_meses,
        "mes_actual": mes_actual,
        "plazas": sorted(set(f["plaza"] for f in filas)),
        "vendedores": sorted(set(f["vendedor"] for f in filas)),
        "desarrolladores": sorted(set(f["desarrollador"] for f in filas_desarrolladores)),
    }


try:
    init_db()
except Exception as e:
    print(f"Aviso: no se pudo inicializar la base de datos al arrancar ({e}).")

app = Flask(__name__)
app.secret_key = get_secret_key()

IMPORTACIONES_URL = (os.environ.get("IMPORTACIONES_URL") or "http://localhost:3001").strip()


@app.context_processor
def inject_importaciones_url():
    return {"importaciones_url": IMPORTACIONES_URL}


def registrar_ingreso():
    """Guarda un renglón en registro_ingresos la primera vez que una
    sesión recién autenticada toca una vista protegida (una fila por
    login, no por cada página que visite). Se engancha en los decoradores
    en vez de en /login para que funcione sin importar qué mecanismo de
    autenticación esté activo. Nunca debe tumbar la vista por un problema
    de logging."""
    if session.get("ingreso_registrado"):
        return
    session["ingreso_registrado"] = True
    try:
        db = get_db()
        db.execute(
            "INSERT INTO registro_ingresos (usuario_id, usuario) VALUES (%s, %s)",
            (session.get("usuario_id"), session.get("usuario") or "?"),
        )
        db.commit()
        db.close()
    except Exception as e:
        print(f"Aviso: no se pudo registrar el ingreso ({e}).")


def registrar_ingreso():
    """Guarda un renglón en registro_ingresos la primera vez que una
    sesión recién autenticada toca una vista protegida (una fila por
    login, no por cada página que visite). Se engancha en los decoradores
    en vez de en /login para que funcione sin importar qué mecanismo de
    autenticación esté activo. Nunca debe tumbar la vista por un problema
    de logging."""
    if session.get("ingreso_registrado"):
        return
    session["ingreso_registrado"] = True
    try:
        db = get_db()
        db.execute(
            "INSERT INTO registro_ingresos (usuario_id, usuario) VALUES (%s, %s)",
            (session.get("usuario_id"), session.get("usuario") or "?"),
        )
        db.commit()
        db.close()
    except Exception as e:
        print(f"Aviso: no se pudo registrar el ingreso ({e}).")


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        registrar_ingreso()
        return view(*args, **kwargs)

    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        registrar_ingreso()
        if not session.get("es_admin"):
            flash("Esa sección es solo para administradores.")
            return redirect(url_for("dashboard_plazas_vendedores"))
        return view(*args, **kwargs)

    return wrapped


def plazas_permitidas_usuario():
    """None = el usuario en sesión ve todas las plazas (sin restricción).
    Si no es None, es el set de plazas que puede ver. Los administradores
    siempre ven todo. Los usuarios autenticados contra el catálogo de accesos
    (Seguimiento de Importaciones) todavía no tienen un equivalente de
    usuario_plazas en app_user_permissions, así que por ahora no ven ninguna
    plaza hasta que se defina esa migración."""
    if session.get("es_admin"):
        return None
    return set()


def usuario_puede_exportar():
    """True = el usuario en sesión puede usar los botones "Exportar". Los
    administradores siempre pueden; para el resto se usa el permiso
    guardado en sesión al hacer login (app_user_permissions.puede_exportar)."""
    if session.get("es_admin"):
        return True
    return bool(session.get("puede_exportar"))


def usuario_puede_actualizar():
    """True = el usuario en sesión puede usar el botón "Actualizar" para
    regenerar el reporte desde CargoLink (acción sensible: reemplaza todos
    los bookings). Los administradores siempre pueden; para el resto se usa
    el permiso guardado en sesión al hacer login
    (app_user_permissions.puede_actualizar), otorgado desde Catálogos →
    Permiso de Actualizar."""
    if session.get("es_admin"):
        return True
    return bool(session.get("puede_actualizar"))


@app.context_processor
def inject_permisos_exportar():
    return {"puede_exportar": usuario_puede_exportar(), "puede_actualizar": usuario_puede_actualizar()}


def autenticar_contra_catalogo_accesos(email, password):
    """Valida el correo/contraseña contra el catálogo de accesos de
    Seguimiento de Importaciones (auth.users + app_user_permissions, mismo
    proyecto Supabase). Regresa la fila del usuario si es válido y la cuenta
    no está deshabilitada, o None si no."""
    db = get_db()
    fila = db.execute(
        """
        SELECT
            u.id, u.email,
            (u.encrypted_password IS NOT NULL
                AND extensions.crypt(%(password)s, u.encrypted_password) = u.encrypted_password) AS password_ok,
            (u.banned_until IS NOT NULL AND u.banned_until > now()) AS baneado,
            coalesce(p.es_admin, false) AS es_admin,
            coalesce(p.puede_exportar, false) AS puede_exportar,
            coalesce(p.puede_actualizar, false) AS puede_actualizar,
            coalesce(p.puede_borrar, false) AS puede_borrar,
            coalesce(p.puede_operativos, false) AS puede_operativos,
            coalesce(p.es_master, false) AS es_master
        FROM auth.users u
        LEFT JOIN public.app_user_permissions p ON p.user_id = u.id
        WHERE lower(u.email) = lower(%(email)s)
        """,
        {"email": email, "password": password},
    ).fetchone()
    db.close()
    if not fila or not fila["password_ok"] or fila["baneado"]:
        return None
    return fila


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        email = request.form.get("email", "").strip()
        clave = request.form.get("password", "")
        fila = autenticar_contra_catalogo_accesos(email, clave)
        if fila:
            session["logged_in"] = True
            session["usuario"] = fila["email"]
            session["usuario_id"] = str(fila["id"])
            session["es_admin"] = bool(fila["es_admin"])
            session["puede_exportar"] = bool(fila["puede_exportar"])
            session["puede_actualizar"] = bool(fila["puede_actualizar"])
            destino = "dashboard" if fila["es_admin"] else "dashboard_plazas_vendedores"
            return redirect(url_for(destino))
        flash("Correo o contraseña incorrectos.")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/", methods=["GET"])
@admin_required
def dashboard():
    return render_template("dashboard.html", resultado=session.pop("resultado", None))


def ejecutar_generacion_reporte(fecha_inicio, fecha_fin):
    """Descarga bookings de CargoLink y reemplaza reporte_bookings.
    Regresa (ok: bool, mensaje: str, detalle: str|None)."""
    try:
        bookings = descargar_bookings_cargolink(fecha_inicio, fecha_fin)
    except Exception as e:
        return False, "Error al generar el reporte.", str(e)[:1500]

    if not bookings:
        return False, "CargoLink no devolvió bookings para ese rango de fechas.", None

    columnas = ["mes", "vendedor", "referencia", "fecha", "ejecutivo", "venta_por", "cliente_servicio", "venta", "profit", "margen"]
    TAMANO_LOTE = 500

    db = get_db()
    cur = db.cursor()
    cur.execute("DELETE FROM reporte_bookings")
    for inicio in range(0, len(bookings), TAMANO_LOTE):
        lote = bookings[inicio:inicio + TAMANO_LOTE]
        placeholders = ", ".join(["(" + ", ".join(["%s"] * len(columnas)) + ")"] * len(lote))
        valores = [b[c] for b in lote for c in columnas]
        cur.execute(
            f"INSERT INTO reporte_bookings ({', '.join(columnas)}) VALUES {placeholders}",
            valores,
        )
    cur.execute(
        "INSERT INTO reporte_generaciones (fecha_inicio, fecha_fin) VALUES (%s, %s)",
        (fecha_inicio, fecha_fin),
    )
    db.commit()

    # Reporte de Clientes: además de los bookings, se actualiza
    # asignacion_de_clientes usando folio como llave — los folios que ya
    # existen se reemplazan con los datos frescos de CargoLink, y los que
    # no existían se agregan. Es un paso adicional: si falla, no se revierte
    # el reporte de bookings que ya se guardó arriba, solo se avisa.
    mensaje_clientes = ""
    try:
        clientes = descargar_reporte_clientes_cargolink()
        columnas_clientes = [
            "folio", "razon_social", "vendedor", "desarrollador",
            "tipo_cliente", "fecha_creacion", "cant_booking", "fecha_ultimo_booking",
        ]
        for inicio in range(0, len(clientes), TAMANO_LOTE):
            lote = clientes[inicio:inicio + TAMANO_LOTE]
            placeholders = ", ".join(["(" + ", ".join(["%s"] * len(columnas_clientes)) + ")"] * len(lote))
            valores = [c[col] for c in lote for col in columnas_clientes]
            cur.execute(
                f"""
                INSERT INTO asignacion_de_clientes ({', '.join(columnas_clientes)})
                VALUES {placeholders}
                ON CONFLICT (folio) DO UPDATE SET
                    razon_social = EXCLUDED.razon_social,
                    vendedor = EXCLUDED.vendedor,
                    desarrollador = EXCLUDED.desarrollador,
                    tipo_cliente = EXCLUDED.tipo_cliente,
                    fecha_creacion = EXCLUDED.fecha_creacion,
                    cant_booking = EXCLUDED.cant_booking,
                    fecha_ultimo_booking = EXCLUDED.fecha_ultimo_booking
                """,
                valores,
            )
        db.commit()
        mensaje_clientes = f" Reporte de clientes actualizado ({len(clientes)} clientes)."
    except Exception as e:
        db.rollback()
        mensaje_clientes = f" Aviso: el reporte de bookings sí se guardó, pero el reporte de clientes falló ({str(e)[:300]})."

    db.close()

    return True, f"Reporte generado correctamente ({len(bookings)} bookings).{mensaje_clientes}", None


@app.route("/generar", methods=["POST"])
@login_required
def generar():
    es_admin = bool(session.get("es_admin"))
    if not es_admin and not usuario_puede_actualizar():
        flash("No tienes permiso para actualizar el reporte.")
        return redirect(url_for("dashboard_plazas_vendedores"))

    # Las fechas de inicio/fin solo las puede elegir un administrador; para
    # el resto (botón "Actualizar" en Información de Ventas) siempre se usa
    # el rango por default, sin importar lo que venga en el formulario.
    fecha_inicio = request.form.get("fecha_inicio", "").strip() if es_admin else ""
    fecha_fin = request.form.get("fecha_fin", "").strip() if es_admin else ""

    if fecha_inicio and not DATE_RE.match(fecha_inicio):
        session["resultado"] = {"ok": False, "mensaje": "Fecha de inicio inválida."}
        return redirect(url_for("dashboard"))
    if fecha_fin and not DATE_RE.match(fecha_fin):
        session["resultado"] = {"ok": False, "mensaje": "Fecha de fin inválida."}
        return redirect(url_for("dashboard"))

    now = datetime.now(TZ_LOCAL)
    fecha_inicio = fecha_inicio or f"{now.year}-01-01"
    fecha_fin = fecha_fin or now.strftime("%Y-%m-%d")

    ok, mensaje, detalle = ejecutar_generacion_reporte(fecha_inicio, fecha_fin)
    if es_admin:
        session["resultado"] = {"ok": ok, "mensaje": mensaje, "detalle": detalle}
        return redirect(url_for("dashboard"))
    flash(mensaje)
    return redirect(url_for("dashboard_plazas_vendedores"))


@app.route("/cron/generar-reporte", methods=["GET", "POST"])
def cron_generar_reporte():
    cron_secret = os.environ.get("CRON_SECRET", "").strip()
    auth = request.headers.get("Authorization", "")
    if not cron_secret or auth != f"Bearer {cron_secret}":
        return {"ok": False, "error": "no autorizado"}, 401

    now = datetime.now(TZ_LOCAL)
    fecha_inicio = f"{now.year}-01-01"
    fecha_fin = now.strftime("%Y-%m-%d")

    ok, mensaje, detalle = ejecutar_generacion_reporte(fecha_inicio, fecha_fin)
    respuesta = {"ok": ok, "mensaje": mensaje, "fecha_inicio": fecha_inicio, "fecha_fin": fecha_fin}
    if detalle:
        respuesta["detalle"] = detalle
    return respuesta, (200 if ok else 500)


@app.route("/descargar")
@admin_required
def descargar():
    db = get_db()
    filas = db.execute(
        "SELECT mes, vendedor, referencia, fecha, ejecutivo, venta_por, cliente_servicio, venta, profit, margen "
        "FROM reporte_bookings ORDER BY fecha DESC"
    ).fetchall()
    db.close()
    if not filas:
        flash("Todavía no hay ningún reporte generado.")
        return redirect(url_for("dashboard"))

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Reporte Vendedores"
    encabezados = ["Referencia", "Fecha de creación", "Vendedor", "Ejecutivo", "Venta por", "Cliente servicio", "Venta", "Profit", "Margen"]
    ws.append(encabezados)
    for r in filas:
        ws.append([
            r["referencia"], r["fecha"].strftime("%Y-%m-%d %H:%M") if r["fecha"] else "", r["vendedor"],
            r["ejecutivo"], r["venta_por"], r["cliente_servicio"],
            float(r["venta"]), float(r["profit"]), float(r["margen"]),
        ])
    ws.freeze_panes = "A2"

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return send_file(
        buffer, as_attachment=True, download_name="Reporte_Vendedores.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.route("/dashboard")
@login_required
def dashboard_plazas_vendedores():
    datos = construir_datos_dashboard(plazas_permitidas_usuario())
    if datos is None:
        if session.get("es_admin"):
            flash("Todavía no hay ningún reporte descargado. Genera uno primero en 'Reporte'.")
            return redirect(url_for("dashboard"))
        flash("Todavía no hay ningún reporte generado. Pídele a un administrador que genere uno.")
        return render_template("dashboard_plazas_vendedores.html", datos_json="null", datos=None)
    datos_json = json.dumps(datos).replace("</", "<\\/")
    return render_template("dashboard_plazas_vendedores.html", datos_json=datos_json, datos=datos)


def construir_filas_reportes(plazas_permitidas=None):
    """Un registro liviano por booking (usado por /reportes y
    /reportes/por-vendedor) para que todo el filtrado y las sumas se hagan
    en el navegador, igual que en /dashboard."""
    db = get_db()

    plaza_por_vendedor = {}
    for r in db.execute("SELECT vendedor, plaza FROM catalogo_vendedores"):
        plaza_por_vendedor[normalizar(r["vendedor"])] = r["plaza"]

    bookings = db.execute(
        "SELECT fecha, vendedor, ejecutivo, referencia, venta_por, cliente_servicio, venta, profit FROM reporte_bookings ORDER BY fecha"
    ).fetchall()
    db.close()

    filas = []
    for r in bookings:
        fecha = r["fecha"]
        if fecha is None:
            continue
        vkey = normalizar(r["vendedor"])
        plaza = plaza_por_vendedor.get(vkey, "#N/D")
        if plazas_permitidas is not None and plaza not in plazas_permitidas:
            continue
        filas.append({
            "fecha": fecha.astimezone(TZ_LOCAL).strftime("%Y-%m-%d"),
            "mes": fecha.astimezone(TZ_LOCAL).strftime("%Y-%m"),
            "plaza": plaza,
            "vendedor": r["vendedor"] or "#N/D",
            "cliente": r["cliente_servicio"] or "Sin cliente",
            "tipo": r["venta_por"] or "Sin tipo",
            "ejecutivo": normalizar(r["ejecutivo"]),
            "tipoServicio": extraer_tipo_servicio(r["referencia"]),
            "venta": round(float(r["venta"]), 2),
            "profit": round(float(r["profit"]), 2),
        })
    return filas


@app.route("/reportes")
@login_required
def reportes_graficas():
    filas = construir_filas_reportes(plazas_permitidas_usuario())
    datos_json = json.dumps(filas).replace("</", "<\\/")
    return render_template("reportes.html", datos_json=datos_json, hay_datos=len(filas) > 0)


@app.route("/reportes/por-vendedor")
@login_required
def reportes_por_vendedor():
    filas = construir_filas_reportes(plazas_permitidas_usuario())
    datos_json = json.dumps(filas).replace("</", "<\\/")
    return render_template("reportes_por_vendedor.html", datos_json=datos_json, hay_datos=len(filas) > 0)


@app.route("/reportes/clientes-asignados")
@login_required
def reportes_clientes_asignados():
    db = get_db()

    plaza_por_vendedor = {}
    for r in db.execute("SELECT vendedor, plaza FROM catalogo_vendedores"):
        plaza_por_vendedor[normalizar(r["vendedor"])] = r["plaza"]

    filas_clientes = db.execute(
        "SELECT folio, razon_social, vendedor, tipo_cliente, cant_booking, fecha_ultimo_booking "
        "FROM asignacion_de_clientes WHERE vendedor IS NOT NULL ORDER BY vendedor, razon_social"
    ).fetchall()
    db.close()

    plazas_permitidas = plazas_permitidas_usuario()
    filas = []
    for r in filas_clientes:
        vkey = normalizar(r["vendedor"])
        plaza = plaza_por_vendedor.get(vkey, "#N/D")
        if plazas_permitidas is not None and plaza not in plazas_permitidas:
            continue
        filas.append({
            "folio": r["folio"],
            "razonSocial": r["razon_social"],
            "vendedor": r["vendedor"],
            "plaza": plaza,
            "tipoCliente": r["tipo_cliente"] or "",
            "cantBooking": r["cant_booking"],
            "fechaUltimoBooking": r["fecha_ultimo_booking"].strftime("%Y-%m-%d") if r["fecha_ultimo_booking"] else "",
        })

    datos_json = json.dumps(filas).replace("</", "<\\/")
    return render_template("reportes_clientes_asignados.html", datos_json=datos_json, hay_datos=len(filas) > 0)


@app.route("/reportes/clientes-mensual")
@login_required
def reportes_clientes_mensual():
    db = get_db()

    plaza_por_vendedor = {}
    for r in db.execute("SELECT vendedor, plaza FROM catalogo_vendedores"):
        plaza_por_vendedor[normalizar(r["vendedor"])] = r["plaza"]

    # El booking pertenece al cliente (cliente_servicio) sin importar quién
    # de reporte_bookings.vendedor lo vendió — aquí se agrupa por el
    # vendedor ASIGNADO al cliente en asignacion_de_clientes, que es lo que
    # pidió el usuario ("clientes asignados por vendedor"). Se guarda
    # también el set de vendedores reales detrás de cada mes para poder
    # marcar en rojo cuando alguna venta la generó alguien distinto al
    # vendedor asignado actualmente.
    mensual_por_cliente = {}
    for r in db.execute("SELECT mes, vendedor, cliente_servicio, profit FROM reporte_bookings"):
        ckey = normalizar(r["cliente_servicio"])
        if not ckey:
            continue
        por_mes = mensual_por_cliente.setdefault(ckey, {})
        acc = por_mes.setdefault(r["mes"], {"cant": 0, "profit": 0.0, "vendedores": set()})
        acc["cant"] += 1
        acc["profit"] += float(r["profit"])
        acc["vendedores"].add(normalizar(r["vendedor"]))

    filas_clientes = db.execute(
        "SELECT folio, razon_social, vendedor FROM asignacion_de_clientes WHERE vendedor IS NOT NULL ORDER BY vendedor, razon_social"
    ).fetchall()
    db.close()

    plazas_permitidas = plazas_permitidas_usuario()
    filas = []
    for r in filas_clientes:
        vkey = normalizar(r["vendedor"])
        ckey = normalizar(r["razon_social"])
        plaza = plaza_por_vendedor.get(vkey, "#N/D")
        if plazas_permitidas is not None and plaza not in plazas_permitidas:
            continue
        mensual = {}
        for mes, acc in mensual_por_cliente.get(ckey, {}).items():
            mensual[mes] = {
                "cant": acc["cant"],
                "profit": acc["profit"],
                "otroVendedor": bool(acc["vendedores"] - {vkey}),
            }
        filas.append({
            "folio": r["folio"],
            "razonSocial": r["razon_social"],
            "vendedor": r["vendedor"],
            "plaza": plaza,
            "mensual": mensual,
        })

    datos_json = json.dumps(filas).replace("</", "<\\/")
    return render_template("reportes_clientes_mensual.html", datos_json=datos_json, hay_datos=len(filas) > 0)


@app.route("/catalogos")
@admin_required
def catalogos():
    return render_template("catalogos.html")


@app.route("/catalogos/permisos-actualizar")
@admin_required
def permisos_actualizar():
    db = get_db()
    filas = db.execute(
        """
        SELECT u.id, u.email,
            coalesce(p.es_admin, false) AS es_admin,
            coalesce(p.puede_actualizar, false) AS puede_actualizar
        FROM auth.users u
        LEFT JOIN public.app_user_permissions p ON p.user_id = u.id
        ORDER BY u.email
        """
    ).fetchall()
    db.close()
    return render_template("permisos_actualizar.html", filas=filas)


@app.route("/catalogos/permisos-actualizar/<uuid:user_id>/toggle", methods=["POST"])
@admin_required
def permisos_actualizar_toggle(user_id):
    nuevo_valor = request.form.get("puede_actualizar") == "1"
    db = get_db()
    db.execute(
        """
        INSERT INTO app_user_permissions (user_id, puede_actualizar)
        VALUES (%s, %s)
        ON CONFLICT (user_id) DO UPDATE SET puede_actualizar = EXCLUDED.puede_actualizar, updated_at = now()
        """,
        (str(user_id), nuevo_valor),
    )
    db.commit()
    db.close()
    return redirect(url_for("permisos_actualizar"))


@app.route("/catalogos/actividad-usuarios")
@admin_required
def actividad_usuarios():
    db = get_db()
    filas = db.execute(
        "SELECT usuario, fecha_hora FROM registro_ingresos ORDER BY fecha_hora DESC LIMIT 500"
    ).fetchall()
    db.close()
    ingresos = [
        {"usuario": f["usuario"], "fecha_hora": f["fecha_hora"].astimezone(TZ_LOCAL).strftime("%d/%m/%Y %H:%M")}
        for f in filas
    ]
    return render_template("actividad_usuarios.html", ingresos=ingresos)


SUPABASE_DB_LIMIT_MB = float(os.environ.get("SUPABASE_DB_LIMIT_MB", "500"))


@app.route("/catalogos/almacenamiento")
@admin_required
def almacenamiento_bd():
    db = get_db()
    total = db.execute(
        "SELECT pg_database_size(current_database()) AS bytes, "
        "pg_size_pretty(pg_database_size(current_database())) AS legible"
    ).fetchone()
    tablas_filas = db.execute("""
        SELECT relname AS tabla,
               pg_total_relation_size(relid) AS bytes,
               pg_size_pretty(pg_total_relation_size(relid)) AS legible
        FROM pg_catalog.pg_statio_user_tables
        WHERE schemaname = 'public'
        ORDER BY bytes DESC
    """).fetchall()
    db.close()

    total_bytes = total["bytes"]
    limite_bytes = SUPABASE_DB_LIMIT_MB * 1024 * 1024
    porcentaje = round(total_bytes / limite_bytes * 100, 1) if limite_bytes else 0
    tablas = [
        {
            "tabla": t["tabla"],
            "legible": t["legible"],
            "porcentaje": round(t["bytes"] / total_bytes * 100, 1) if total_bytes else 0,
        }
        for t in tablas_filas
    ]
    return render_template(
        "almacenamiento_bd.html",
        total_legible=total["legible"],
        limite_mb=SUPABASE_DB_LIMIT_MB,
        porcentaje=porcentaje,
        tablas=tablas,
    )


@app.route("/catalogos/vendedores", methods=["GET", "POST"])
@admin_required
def catalogo_vendedores():
    db = get_db()
    if request.method == "POST":
        vendedor = request.form.get("vendedor", "").strip()
        plaza = request.form.get("plaza", "").strip()
        ocultar_detalle = request.form.get("ocultar_detalle") == "on"
        if not vendedor or not plaza:
            flash("Vendedor y Plaza son obligatorios.")
        else:
            try:
                db.execute(
                    "INSERT INTO catalogo_vendedores (vendedor, plaza, ocultar_detalle) VALUES (%s, %s, %s)",
                    (vendedor, plaza, ocultar_detalle),
                )
                db.commit()
            except psycopg.errors.UniqueViolation:
                db.rollback()
                flash("Ese Vendedor ya existe en el catálogo.")
        db.close()
        return redirect(url_for("catalogo_vendedores"))

    filas = db.execute("SELECT * FROM catalogo_vendedores ORDER BY plaza, vendedor").fetchall()
    db.close()
    return render_template("catalogo_vendedores.html", filas=filas)


@app.route("/catalogos/vendedores/<int:fila_id>/editar", methods=["GET", "POST"])
@admin_required
def catalogo_vendedores_editar(fila_id):
    db = get_db()
    if request.method == "POST":
        vendedor = request.form.get("vendedor", "").strip()
        plaza = request.form.get("plaza", "").strip()
        ocultar_detalle = request.form.get("ocultar_detalle") == "on"
        if not vendedor or not plaza:
            flash("Vendedor y Plaza son obligatorios.")
        else:
            try:
                db.execute(
                    "UPDATE catalogo_vendedores SET vendedor = %s, plaza = %s, ocultar_detalle = %s WHERE id = %s",
                    (vendedor, plaza, ocultar_detalle, fila_id),
                )
                db.commit()
            except psycopg.errors.UniqueViolation:
                db.rollback()
                flash("Ese Vendedor ya existe en el catálogo.")
            db.close()
            return redirect(url_for("catalogo_vendedores"))

    fila = db.execute("SELECT * FROM catalogo_vendedores WHERE id = %s", (fila_id,)).fetchone()
    db.close()
    if fila is None:
        return "No encontrado", 404
    return render_template("catalogo_vendedores_editar.html", fila=fila)


@app.route("/catalogos/vendedores/<int:fila_id>/eliminar", methods=["POST"])
@admin_required
def catalogo_vendedores_eliminar(fila_id):
    db = get_db()
    db.execute("DELETE FROM catalogo_vendedores WHERE id = %s", (fila_id,))
    db.commit()
    db.close()
    return redirect(url_for("catalogo_vendedores"))


@app.route("/catalogos/desarrolladores", methods=["GET", "POST"])
@admin_required
def catalogo_desarrolladores():
    db = get_db()
    if request.method == "POST":
        desarrollador = request.form.get("desarrollador", "").strip()
        plaza = request.form.get("plaza", "").strip()
        if not desarrollador or not plaza:
            flash("Desarrollador y Plaza son obligatorios.")
        else:
            try:
                db.execute("INSERT INTO catalogo_desarrolladores (desarrollador, plaza) VALUES (%s, %s)", (desarrollador, plaza))
                db.commit()
            except psycopg.errors.UniqueViolation:
                db.rollback()
                flash("Ese Desarrollador ya existe en el catálogo.")
        db.close()
        return redirect(url_for("catalogo_desarrolladores"))

    filas = db.execute("SELECT * FROM catalogo_desarrolladores ORDER BY plaza, desarrollador").fetchall()
    db.close()
    return render_template("catalogo_desarrolladores.html", filas=filas)


@app.route("/catalogos/desarrolladores/<int:fila_id>/editar", methods=["GET", "POST"])
@admin_required
def catalogo_desarrolladores_editar(fila_id):
    db = get_db()
    if request.method == "POST":
        desarrollador = request.form.get("desarrollador", "").strip()
        plaza = request.form.get("plaza", "").strip()
        if not desarrollador or not plaza:
            flash("Desarrollador y Plaza son obligatorios.")
        else:
            try:
                db.execute(
                    "UPDATE catalogo_desarrolladores SET desarrollador = %s, plaza = %s WHERE id = %s",
                    (desarrollador, plaza, fila_id),
                )
                db.commit()
            except psycopg.errors.UniqueViolation:
                db.rollback()
                flash("Ese Desarrollador ya existe en el catálogo.")
            db.close()
            return redirect(url_for("catalogo_desarrolladores"))

    fila = db.execute("SELECT * FROM catalogo_desarrolladores WHERE id = %s", (fila_id,)).fetchone()
    db.close()
    if fila is None:
        return "No encontrado", 404
    return render_template("catalogo_desarrolladores_editar.html", fila=fila)


@app.route("/catalogos/desarrolladores/<int:fila_id>/eliminar", methods=["POST"])
@admin_required
def catalogo_desarrolladores_eliminar(fila_id):
    db = get_db()
    db.execute("DELETE FROM catalogo_desarrolladores WHERE id = %s", (fila_id,))
    db.commit()
    db.close()
    return redirect(url_for("catalogo_desarrolladores"))


@app.route("/catalogos/presupuesto", methods=["GET", "POST"])
@admin_required
def catalogo_presupuesto():
    db = get_db()
    if request.method == "POST":
        mes = request.form.get("mes", "").strip()
        vendedor = request.form.get("vendedor", "").strip() or None
        desarrollador = request.form.get("desarrollador", "").strip() or None
        presupuesto_raw = request.form.get("presupuesto", "")
        if not mes or not presupuesto_raw:
            flash("Mes y Presupuesto son obligatorios.")
        elif not vendedor and not desarrollador:
            flash("Debes indicar al menos un Vendedor o un Desarrollador.")
        else:
            try:
                presupuesto = parse_presupuesto(presupuesto_raw)
            except ValueError:
                flash("El presupuesto debe ser un número válido.")
                presupuesto = None
            if presupuesto is not None:
                try:
                    db.execute(
                        "INSERT INTO catalogo_presupuesto (mes, vendedor, desarrollador, presupuesto) VALUES (%s, %s, %s, %s)",
                        (mes, vendedor, desarrollador, presupuesto),
                    )
                    db.commit()
                except psycopg.errors.UniqueViolation:
                    db.rollback()
                    flash("Ya existe un presupuesto para ese Mes, Vendedor y Desarrollador.")
        db.close()
        return redirect(url_for("catalogo_presupuesto"))

    filas = db.execute("SELECT * FROM catalogo_presupuesto ORDER BY mes DESC, vendedor").fetchall()
    vendedores = get_vendedores(db)
    desarrolladores = get_desarrolladores(db)
    db.close()
    return render_template(
        "catalogo_presupuesto.html", filas=filas, opciones_mes=opciones_mes(),
        mes_actual=datetime.now().strftime("%Y-%m"),
        vendedores=vendedores, desarrolladores=desarrolladores,
    )


@app.route("/catalogos/presupuesto/<int:fila_id>/editar", methods=["GET", "POST"])
@admin_required
def catalogo_presupuesto_editar(fila_id):
    db = get_db()
    if request.method == "POST":
        mes = request.form.get("mes", "").strip()
        vendedor = request.form.get("vendedor", "").strip() or None
        desarrollador = request.form.get("desarrollador", "").strip() or None
        presupuesto_raw = request.form.get("presupuesto", "")
        if not mes or not presupuesto_raw:
            flash("Mes y Presupuesto son obligatorios.")
        elif not vendedor and not desarrollador:
            flash("Debes indicar al menos un Vendedor o un Desarrollador.")
        else:
            try:
                presupuesto = parse_presupuesto(presupuesto_raw)
            except ValueError:
                flash("El presupuesto debe ser un número válido.")
                presupuesto = None
            if presupuesto is not None:
                try:
                    db.execute(
                        "UPDATE catalogo_presupuesto SET mes = %s, vendedor = %s, desarrollador = %s, presupuesto = %s WHERE id = %s",
                        (mes, vendedor, desarrollador, presupuesto, fila_id),
                    )
                    db.commit()
                except psycopg.errors.UniqueViolation:
                    db.rollback()
                    flash("Ya existe un presupuesto para ese Mes, Vendedor y Desarrollador.")
                db.close()
                return redirect(url_for("catalogo_presupuesto"))

    fila = db.execute("SELECT * FROM catalogo_presupuesto WHERE id = %s", (fila_id,)).fetchone()
    vendedores = get_vendedores(db)
    desarrolladores = get_desarrolladores(db)
    db.close()
    if fila is None:
        return "No encontrado", 404
    return render_template(
        "catalogo_presupuesto_editar.html", fila=fila, opciones_mes=opciones_mes(),
        vendedores=vendedores, desarrolladores=desarrolladores,
    )


@app.route("/catalogos/presupuesto/<int:fila_id>/eliminar", methods=["POST"])
@admin_required
def catalogo_presupuesto_eliminar(fila_id):
    db = get_db()
    db.execute("DELETE FROM catalogo_presupuesto WHERE id = %s", (fila_id,))
    db.commit()
    db.close()
    return redirect(url_for("catalogo_presupuesto"))


@app.route("/catalogos/presupuesto/plantilla")
@admin_required
def catalogo_presupuesto_plantilla():
    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Presupuesto"
    ws.append(PRESUPUESTO_COLUMNAS)
    ws.append(["2026-07", "ARMANDO VILLANUEVA SILVA", "", 20000])
    for col_idx, ancho in enumerate([12, 30, 22, 16], start=1):
        ws.column_dimensions[chr(64 + col_idx)].width = ancho

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    return send_file(
        buffer,
        as_attachment=True,
        download_name="plantilla_presupuesto.xlsx",
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.route("/catalogos/presupuesto/carga_masiva", methods=["GET", "POST"])
@admin_required
def catalogo_presupuesto_carga_masiva():
    if request.method == "POST":
        archivo = request.files.get("archivo")
        if not archivo or archivo.filename == "":
            flash("Selecciona un archivo .csv o .xlsx para cargar.")
            return redirect(url_for("catalogo_presupuesto_carga_masiva"))

        nombre = archivo.filename.lower()
        try:
            if nombre.endswith(".csv"):
                filas_crudas = leer_filas_csv(archivo)
            elif nombre.endswith(".xlsx"):
                filas_crudas = leer_filas_xlsx(archivo)
            else:
                flash("Formato no soportado. Usa un archivo .csv o .xlsx.")
                return redirect(url_for("catalogo_presupuesto_carga_masiva"))
        except Exception:
            flash("No se pudo leer el archivo. Verifica que tenga las columnas mes, vendedor, desarrollador, presupuesto.")
            return redirect(url_for("catalogo_presupuesto_carga_masiva"))

        db = get_db()
        agregados = 0
        actualizados = 0
        errores = []
        for numero_fila, fila in enumerate(filas_crudas, start=2):
            mes = str(fila.get("mes") or "").strip()
            vendedor = str(fila.get("vendedor") or "").strip() or None
            desarrollador = str(fila.get("desarrollador") or "").strip() or None
            presupuesto_raw = fila.get("presupuesto")

            if not mes or presupuesto_raw in (None, ""):
                errores.append(f"Fila {numero_fila}: faltan datos obligatorios (mes o presupuesto).")
                continue
            if not vendedor and not desarrollador:
                errores.append(f"Fila {numero_fila}: debe indicar Vendedor o Desarrollador.")
                continue
            if mes not in MESES_VALIDOS:
                errores.append(f"Fila {numero_fila}: mes '{mes}' inválido, usa formato AAAA-MM.")
                continue
            try:
                presupuesto = parse_presupuesto(str(presupuesto_raw))
            except ValueError:
                errores.append(f"Fila {numero_fila}: presupuesto '{presupuesto_raw}' no es numérico.")
                continue

            existente = db.execute(
                "SELECT id FROM catalogo_presupuesto WHERE mes = %s AND coalesce(vendedor, '') = coalesce(%s, '') AND coalesce(desarrollador, '') = coalesce(%s, '')",
                (mes, vendedor, desarrollador),
            ).fetchone()
            if existente:
                db.execute("UPDATE catalogo_presupuesto SET presupuesto = %s WHERE id = %s", (presupuesto, existente["id"]))
                actualizados += 1
            else:
                db.execute(
                    "INSERT INTO catalogo_presupuesto (mes, vendedor, desarrollador, presupuesto) VALUES (%s, %s, %s, %s)",
                    (mes, vendedor, desarrollador, presupuesto),
                )
                agregados += 1

        db.commit()
        db.close()

        mensaje = f"Carga completa: {agregados} agregados, {actualizados} actualizados."
        if errores:
            mensaje += f" {len(errores)} fila(s) con errores."
        session["resultado_carga"] = {"mensaje": mensaje, "ok": not errores, "errores": errores[:50]}
        return redirect(url_for("catalogo_presupuesto_carga_masiva"))

    resultado = session.pop("resultado_carga", None)
    return render_template("catalogo_presupuesto_carga_masiva.html", resultado=resultado)


if __name__ == "__main__":
    app.config["TEMPLATES_AUTO_RELOAD"] = True
    app.run(host=os.environ.get("HOST", "127.0.0.1"), port=int(os.environ.get("PORT", 5050)), debug=False)
