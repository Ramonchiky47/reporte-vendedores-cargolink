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

import openpyxl
import psycopg
import requests
from bs4 import BeautifulSoup
from dotenv import load_dotenv
from flask import Flask, flash, redirect, render_template, request, send_file, session, url_for
from psycopg.rows import dict_row
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

DATABASE_URL = (os.environ.get("DATABASE_URL") or "").strip()
HASH_METHOD = "pbkdf2:sha256"
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

CARGOLINK_LOGIN_URL = "https://fwd.cargolink.mx/seguridad/control.php?loginfrom=usuario"
CARGOLINK_REPORT_URL = "https://fwd.cargolink.mx/templates/pdfs/excel_vendedores.php"


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
    """Crea las tablas si no existen (primer arranque en una base vacía) y,
    si se definieron INITIAL_ADMIN_USER / INITIAL_ADMIN_PASSWORD y todavía no
    hay ningún usuario, da de alta ese primer administrador."""
    db = get_db()
    db.execute("""
        CREATE TABLE IF NOT EXISTS usuarios (
            id bigint generated always as identity primary key,
            usuario text not null,
            password_hash text not null,
            creado_en timestamptz not null default now(),
            es_admin boolean not null default false
        );
    """)
    db.execute("CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_usuario ON usuarios (lower(usuario));")
    db.execute("""
        CREATE TABLE IF NOT EXISTS catalogo_vendedores (
            id bigint generated always as identity primary key,
            vendedor text not null unique,
            plaza text not null
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
    db.commit()

    hay_usuarios = db.execute("SELECT COUNT(*) AS c FROM usuarios").fetchone()["c"]
    admin_inicial = (os.environ.get("INITIAL_ADMIN_USER") or "").strip()
    clave_inicial = (os.environ.get("INITIAL_ADMIN_PASSWORD") or "").strip()
    if hay_usuarios == 0 and admin_inicial and clave_inicial:
        db.execute(
            "INSERT INTO usuarios (usuario, password_hash, es_admin) VALUES (%s, %s, true)",
            (admin_inicial, generate_password_hash(clave_inicial, method=HASH_METHOD)),
        )
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


def construir_datos_dashboard():
    db = get_db()
    meta = db.execute(
        "SELECT fecha_inicio, fecha_fin, generado_en FROM reporte_generaciones ORDER BY generado_en DESC LIMIT 1"
    ).fetchone()
    if meta is None:
        db.close()
        return None

    catalogo_vendedor = {}
    for r in db.execute("SELECT vendedor, plaza FROM catalogo_vendedores"):
        catalogo_vendedor[normalizar(r["vendedor"])] = {"plaza": r["plaza"], "nombre": r["vendedor"]}

    presupuesto_por_mes_vendedor = {}
    for r in db.execute("SELECT mes, vendedor, presupuesto FROM catalogo_presupuesto WHERE vendedor IS NOT NULL"):
        clave = (r["mes"], normalizar(r["vendedor"]))
        presupuesto_por_mes_vendedor[clave] = presupuesto_por_mes_vendedor.get(clave, 0.0) + float(r["presupuesto"])

    bookings = db.execute(
        "SELECT mes, vendedor, referencia, fecha, ejecutivo, venta_por, cliente_servicio, venta, profit, margen "
        "FROM reporte_bookings"
    ).fetchall()
    db.close()

    agregados = {}
    detalle = []
    for r in bookings:
        vkey = normalizar(r["vendedor"])
        clave = (r["mes"], vkey)
        agg = agregados.setdefault(clave, {"cant_book": 0, "venta": 0.0, "profit": 0.0})
        agg["cant_book"] += 1
        agg["venta"] += float(r["venta"])
        agg["profit"] += float(r["profit"])

        cat = catalogo_vendedor.get(vkey)
        nombre_canonico = cat["nombre"] if cat else r["vendedor"]
        detalle.append({
            "mes": r["mes"],
            "vendedor": nombre_canonico,
            "referencia": r["referencia"] or "",
            "fecha": r["fecha"].strftime("%Y-%m-%d %H:%M") if r["fecha"] else "",
            "ejecutivo": r["ejecutivo"] or "",
            "venta_por": r["venta_por"] or "",
            "cliente_servicio": r["cliente_servicio"] or "",
            "profit": round(float(r["profit"]), 2),
            "margen": round(float(r["margen"]), 4),
        })

    for clave in presupuesto_por_mes_vendedor:
        agregados.setdefault(clave, {"cant_book": 0, "venta": 0.0, "profit": 0.0})

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

    return {
        "archivo": f"Reporte {meta['fecha_inicio']} al {meta['fecha_fin']}",
        "generado_en": meta["generado_en"].strftime("%d/%m/%Y %H:%M"),
        "filas": filas,
        "detalle": detalle,
        "meses": sorted(set(f["mes"] for f in filas)),
        "plazas": sorted(set(f["plaza"] for f in filas)),
        "vendedores": sorted(set(f["vendedor"] for f in filas)),
    }


try:
    init_db()
except Exception as e:
    print(f"Aviso: no se pudo inicializar la base de datos al arrancar ({e}).")

app = Flask(__name__)
app.secret_key = get_secret_key()


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        return view(*args, **kwargs)

    return wrapped


def admin_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("logged_in"):
            return redirect(url_for("login"))
        if not session.get("es_admin"):
            flash("Esa sección es solo para administradores.")
            return redirect(url_for("dashboard"))
        return view(*args, **kwargs)

    return wrapped


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "POST":
        usuario = request.form.get("usuario", "").strip()
        clave = request.form.get("clave", "")
        db = get_db()
        fila = db.execute("SELECT * FROM usuarios WHERE lower(usuario) = lower(%s)", (usuario,)).fetchone()
        db.close()
        if fila and check_password_hash(fila["password_hash"], clave):
            session["logged_in"] = True
            session["usuario"] = fila["usuario"]
            session["usuario_id"] = fila["id"]
            session["es_admin"] = bool(fila["es_admin"])
            return redirect(url_for("dashboard"))
        flash("Usuario o contraseña incorrectos.")
    return render_template("login.html")


@app.route("/logout")
def logout():
    session.clear()
    return redirect(url_for("login"))


@app.route("/", methods=["GET"])
@login_required
def dashboard():
    return render_template("dashboard.html", resultado=session.pop("resultado", None))


@app.route("/generar", methods=["POST"])
@login_required
def generar():
    fecha_inicio = request.form.get("fecha_inicio", "").strip()
    fecha_fin = request.form.get("fecha_fin", "").strip()

    if fecha_inicio and not DATE_RE.match(fecha_inicio):
        session["resultado"] = {"ok": False, "mensaje": "Fecha de inicio inválida."}
        return redirect(url_for("dashboard"))
    if fecha_fin and not DATE_RE.match(fecha_fin):
        session["resultado"] = {"ok": False, "mensaje": "Fecha de fin inválida."}
        return redirect(url_for("dashboard"))

    now = datetime.now()
    fecha_inicio = fecha_inicio or f"{now.year}-01-01"
    fecha_fin = fecha_fin or now.strftime("%Y-%m-%d")

    try:
        bookings = descargar_bookings_cargolink(fecha_inicio, fecha_fin)
    except Exception as e:
        session["resultado"] = {"ok": False, "mensaje": "Error al generar el reporte.", "detalle": str(e)[:1500]}
        return redirect(url_for("dashboard"))

    if not bookings:
        session["resultado"] = {"ok": False, "mensaje": "CargoLink no devolvió bookings para ese rango de fechas."}
        return redirect(url_for("dashboard"))

    db = get_db()
    db.execute("DELETE FROM reporte_bookings")
    for b in bookings:
        db.execute(
            "INSERT INTO reporte_bookings (mes, vendedor, referencia, fecha, ejecutivo, venta_por, cliente_servicio, venta, profit, margen) "
            "VALUES (%(mes)s, %(vendedor)s, %(referencia)s, %(fecha)s, %(ejecutivo)s, %(venta_por)s, %(cliente_servicio)s, %(venta)s, %(profit)s, %(margen)s)",
            b,
        )
    db.execute(
        "INSERT INTO reporte_generaciones (fecha_inicio, fecha_fin) VALUES (%s, %s)",
        (fecha_inicio, fecha_fin),
    )
    db.commit()
    db.close()

    session["resultado"] = {"ok": True, "mensaje": f"Reporte generado correctamente ({len(bookings)} bookings)."}
    return redirect(url_for("dashboard"))


@app.route("/descargar")
@login_required
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
    datos = construir_datos_dashboard()
    if datos is None:
        flash("Todavía no hay ningún reporte descargado. Genera uno primero en 'Reporte'.")
        return redirect(url_for("dashboard"))
    datos_json = json.dumps(datos).replace("</", "<\\/")
    return render_template("dashboard_plazas_vendedores.html", datos_json=datos_json, datos=datos)


@app.route("/catalogos")
@admin_required
def catalogos():
    return render_template("catalogos.html")


@app.route("/catalogos/vendedores", methods=["GET", "POST"])
@admin_required
def catalogo_vendedores():
    db = get_db()
    if request.method == "POST":
        vendedor = request.form.get("vendedor", "").strip()
        plaza = request.form.get("plaza", "").strip()
        if not vendedor or not plaza:
            flash("Vendedor y Plaza son obligatorios.")
        else:
            try:
                db.execute("INSERT INTO catalogo_vendedores (vendedor, plaza) VALUES (%s, %s)", (vendedor, plaza))
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
        if not vendedor or not plaza:
            flash("Vendedor y Plaza son obligatorios.")
        else:
            try:
                db.execute(
                    "UPDATE catalogo_vendedores SET vendedor = %s, plaza = %s WHERE id = %s",
                    (vendedor, plaza, fila_id),
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


@app.route("/catalogos/usuarios", methods=["GET", "POST"])
@admin_required
def catalogo_usuarios():
    db = get_db()
    if request.method == "POST":
        usuario = request.form.get("usuario", "").strip()
        clave = request.form.get("clave", "")
        clave_confirmar = request.form.get("clave_confirmar", "")
        es_admin = bool(request.form.get("es_admin"))
        if not usuario or not clave:
            flash("Usuario y contraseña son obligatorios.")
        elif clave != clave_confirmar:
            flash("Las contraseñas no coinciden.")
        else:
            try:
                db.execute(
                    "INSERT INTO usuarios (usuario, password_hash, es_admin) VALUES (%s, %s, %s)",
                    (usuario, generate_password_hash(clave, method=HASH_METHOD), es_admin),
                )
                db.commit()
            except psycopg.errors.UniqueViolation:
                db.rollback()
                flash("Ese usuario ya existe.")
        db.close()
        return redirect(url_for("catalogo_usuarios"))

    filas = db.execute("SELECT id, usuario, creado_en, es_admin FROM usuarios ORDER BY usuario").fetchall()
    db.close()
    return render_template("catalogo_usuarios.html", filas=filas)


@app.route("/catalogos/usuarios/<int:fila_id>/editar", methods=["GET", "POST"])
@admin_required
def catalogo_usuarios_editar(fila_id):
    db = get_db()
    if request.method == "POST":
        usuario = request.form.get("usuario", "").strip()
        clave = request.form.get("clave", "")
        clave_confirmar = request.form.get("clave_confirmar", "")
        es_admin = bool(request.form.get("es_admin"))
        admins_actuales = db.execute("SELECT COUNT(*) AS c FROM usuarios WHERE es_admin = true").fetchone()["c"]
        fila_actual = db.execute("SELECT es_admin FROM usuarios WHERE id = %s", (fila_id,)).fetchone()
        if not usuario:
            flash("El usuario es obligatorio.")
        elif clave != clave_confirmar:
            flash("Las contraseñas no coinciden.")
        elif fila_actual and fila_actual["es_admin"] and not es_admin and admins_actuales <= 1:
            flash("No puedes quitarle el rol de administrador al único administrador que queda.")
        else:
            try:
                if clave:
                    db.execute(
                        "UPDATE usuarios SET usuario = %s, password_hash = %s, es_admin = %s WHERE id = %s",
                        (usuario, generate_password_hash(clave, method=HASH_METHOD), es_admin, fila_id),
                    )
                else:
                    db.execute(
                        "UPDATE usuarios SET usuario = %s, es_admin = %s WHERE id = %s",
                        (usuario, es_admin, fila_id),
                    )
                db.commit()
                if fila_id == session.get("usuario_id"):
                    session["usuario"] = usuario
                    session["es_admin"] = bool(es_admin)
            except psycopg.errors.UniqueViolation:
                db.rollback()
                flash("Ese usuario ya existe.")
            db.close()
            return redirect(url_for("catalogo_usuarios"))

    fila = db.execute("SELECT id, usuario, es_admin FROM usuarios WHERE id = %s", (fila_id,)).fetchone()
    db.close()
    if fila is None:
        return "No encontrado", 404
    return render_template("catalogo_usuarios_editar.html", fila=fila)


@app.route("/catalogos/usuarios/<int:fila_id>/eliminar", methods=["POST"])
@admin_required
def catalogo_usuarios_eliminar(fila_id):
    db = get_db()
    total = db.execute("SELECT COUNT(*) AS c FROM usuarios").fetchone()["c"]
    admins = db.execute("SELECT COUNT(*) AS c FROM usuarios WHERE es_admin = true").fetchone()["c"]
    fila = db.execute("SELECT es_admin FROM usuarios WHERE id = %s", (fila_id,)).fetchone()
    if total <= 1:
        flash("No puedes eliminar el único usuario que queda.")
    elif fila_id == session.get("usuario_id"):
        flash("No puedes eliminar el usuario con el que iniciaste sesión.")
    elif fila and fila["es_admin"] and admins <= 1:
        flash("No puedes eliminar al único administrador que queda.")
    else:
        db.execute("DELETE FROM usuarios WHERE id = %s", (fila_id,))
        db.commit()
    db.close()
    return redirect(url_for("catalogo_usuarios"))


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
