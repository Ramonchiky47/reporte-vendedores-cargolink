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
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
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
CARGOLINK_LIQ_VENDEDOR_URL = "https://fwd.cargolink.mx/templates/egresos_liq_vendedor/"


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
    db.execute("""
        CREATE TABLE IF NOT EXISTS comisiones_liquidacion_detalle (
            id bigint generated always as identity primary key,
            folio integer not null,
            descripcion text not null,
            booking text not null,
            folio_cobro text,
            profit numeric not null default 0,
            vendedor text,
            pct_vendedor numeric,
            total_vendedor numeric not null default 0,
            desarrollador text,
            pct_desarrollador numeric,
            total_desarrollador numeric not null default 0,
            cargado_en timestamptz not null default now()
        );
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_comisiones_liq_folio ON comisiones_liquidacion_detalle (folio);")
    db.execute("""
        CREATE TABLE IF NOT EXISTS comisiones_cobros_detalle (
            id bigint generated always as identity primary key,
            folio integer not null,
            etiqueta text not null,
            folio_cobro text,
            folio_factura text,
            referencia text not null,
            uuid text,
            tipo_docto text,
            tipo_referencia text,
            cliente text,
            fecha_factura date,
            fecha_cobro date,
            dias_diferencia integer,
            fecha_timbre text,
            banco text,
            moneda text,
            subtotal numeric not null default 0,
            iva numeric not null default 0,
            descuento numeric not null default 0,
            retencion numeric not null default 0,
            total numeric not null default 0,
            cargado_en timestamptz not null default now()
        );
    """)
    db.execute("CREATE INDEX IF NOT EXISTS idx_comisiones_cobros_folio ON comisiones_cobros_detalle (folio);")
    db.execute("CREATE INDEX IF NOT EXISTS idx_comisiones_cobros_referencia ON comisiones_cobros_detalle (referencia);")
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


def _conectar_liq_vendedor_cargolink():
    """Login a CargoLink + token de sesión del módulo Liquidación de
    vendedores (m=150). Compartido por listar_folios_liquidacion_cargolink
    y descargar_liquidacion_vendedor_cargolink."""
    usuario = (os.environ.get("CARGOLINK_USUARIO") or "").strip()
    password = (os.environ.get("CARGOLINK_PASSWORD") or "").strip()
    if not usuario or not password:
        raise RuntimeError("Faltan las variables de entorno CARGOLINK_USUARIO / CARGOLINK_PASSWORD.")

    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
    sesion = requests.Session()
    r_login = sesion.post(CARGOLINK_LOGIN_URL, data={"usuario": usuario, "password": password}, headers=headers, timeout=60)
    if r_login.status_code != 200 or '"activo"' not in r_login.text:
        raise RuntimeError("No se pudo iniciar sesión en CargoLink.")

    r_pagina = sesion.get(f"{CARGOLINK_LIQ_VENDEDOR_URL}?m=150", headers=headers, timeout=60)
    match_token = re.search(r"token=([a-f0-9]{32}\d*)", r_pagina.text)
    if not match_token:
        raise RuntimeError("No se pudo obtener el token de sesión de Liquidación de Vendedores.")
    return sesion, headers, match_token.group(1)


def listar_folios_liquidacion_cargolink():
    """Lista los folios (folio, descripción) disponibles en Egresos →
    Liquidación de vendedores, para el selector de carga."""
    sesion, headers, token = _conectar_liq_vendedor_cargolink()
    r_lista = sesion.post(
        f"https://fwd.cargolink.mx/ws/cliente_conexion.php?token={token}&cat=apiLiquidacion&fn=consultaLiqVendedor",
        json={},
        headers={"Content-Type": "application/json"},
        timeout=60,
    )
    if r_lista.status_code != 200:
        raise RuntimeError("Error al consultar la lista de liquidaciones en CargoLink.")
    folios = [
        {"folio": int(f["folio_int"]), "descripcion": f.get("nombre") or ""}
        for f in r_lista.json().get("values", [])
        if int(f["folio_int"]) >= 51
    ]
    folios.sort(key=lambda f: f["folio"], reverse=True)
    return folios


def descargar_liquidacion_vendedor_cargolink(folio):
    """Se conecta a CargoLink, ubica el folio dado en Egresos → Liquidación
    de vendedores (m=150) y descarga su detalle línea por línea (uno por
    booking). No toca el disco. Regresa {folio, descripcion, detalle}."""
    sesion, headers, token = _conectar_liq_vendedor_cargolink()

    r_lista = sesion.post(
        f"https://fwd.cargolink.mx/ws/cliente_conexion.php?token={token}&cat=apiLiquidacion&fn=consultaLiqVendedor",
        json={},
        headers={"Content-Type": "application/json"},
        timeout=60,
    )
    if r_lista.status_code != 200:
        raise RuntimeError("Error al consultar la lista de liquidaciones en CargoLink.")
    fila_folio = next(
        (f for f in r_lista.json().get("values", []) if str(f.get("folio_int")) == str(folio)), None
    )
    if fila_folio is None:
        raise RuntimeError(f"No se encontró el folio {folio} en Liquidación de vendedores.")

    id_liq = fila_folio["id_liq_vendedor"]
    descripcion = fila_folio.get("nombre") or ""

    r_excel = sesion.get(
        f"{CARGOLINK_LIQ_VENDEDOR_URL}excel_detalle.php?token={token}&id_liq={id_liq}",
        headers=headers,
        timeout=60,
    )
    if r_excel.status_code != 200 or len(r_excel.content) == 0:
        raise RuntimeError("Error al descargar el detalle de la liquidación desde CargoLink.")

    def num(v):
        v = (v or "0").replace(",", "").replace("$", "").strip()
        try:
            return float(v)
        except ValueError:
            return 0.0

    soup = BeautifulSoup(r_excel.content.decode("utf-8-sig", errors="replace"), "html.parser")
    tabla = soup.find("table")
    filas_html = tabla.find_all("tr") if tabla else []

    detalle = []
    header_visto = False
    for tr in filas_html:
        celdas = [c.get_text(strip=True) for c in tr.find_all(["th", "td"])]
        if not celdas:
            continue
        if celdas[0] == "Booking":
            header_visto = True
            continue
        if not header_visto or celdas[0] == "" or len(celdas) < 9:
            continue  # fila de totales al final, o de encabezado/folio arriba de la tabla
        detalle.append({
            "booking": celdas[0],
            "folio_cobro": celdas[1],
            "profit": num(celdas[2]),
            "vendedor": celdas[3],
            "pct_vendedor": num(celdas[4]),
            "total_vendedor": num(celdas[5]),
            "desarrollador": celdas[6],
            "pct_desarrollador": num(celdas[7]),
            "total_desarrollador": num(celdas[8]),
        })

    return {"folio": int(folio), "descripcion": descripcion, "detalle": detalle}


def descargar_concentrado_cobros_cargolink(fecha_ini, fecha_fin):
    """Se conecta a CargoLink, consulta Ingresos → Reporte de Cobros (m=48)
    para el rango de fechas dado y descarga el Excel Concentrado. No toca
    el disco. Regresa una lista de dicts (uno por cobro)."""
    usuario = (os.environ.get("CARGOLINK_USUARIO") or "").strip()
    password = (os.environ.get("CARGOLINK_PASSWORD") or "").strip()
    if not usuario or not password:
        raise RuntimeError("Faltan las variables de entorno CARGOLINK_USUARIO / CARGOLINK_PASSWORD.")

    headers = {"User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"}
    sesion = requests.Session()
    r_login = sesion.post(CARGOLINK_LOGIN_URL, data={"usuario": usuario, "password": password}, headers=headers, timeout=60)
    if r_login.status_code != 200 or '"activo"' not in r_login.text:
        raise RuntimeError("No se pudo iniciar sesión en CargoLink.")

    r_pagina = sesion.get(
        "https://fwd.cargolink.mx/templates/reporteCobros/index20.php?m=48", headers=headers, timeout=60
    )
    match_token = re.search(r"token=([a-f0-9]{32}\d*)", r_pagina.text)
    if not match_token:
        raise RuntimeError("No se pudo obtener el token de sesión de Reporte de Cobros.")
    token = match_token.group(1)

    r_consulta = sesion.post(
        f"https://fwd.cargolink.mx/ws/cliente_conexion.php?token={token}&cat=api&fn=consultaCobrosClientes&limit=0",
        json={"filtros": {}, "filtros2": {"fechaini": fecha_ini, "fechafin": fecha_fin}},
        headers={"Content-Type": "application/json"},
        timeout=60,
    )
    if r_consulta.status_code != 200:
        raise RuntimeError("Error al consultar Reporte de Cobros en CargoLink.")
    where = r_consulta.json().get("where")
    if where is None:
        raise RuntimeError("CargoLink no regresó resultados para ese rango de fechas.")

    r_excel = sesion.get(
        "https://fwd.cargolink.mx/templates/reporteCobros/excelConcentrado.php",
        params={"filtros": where, "token": token},
        headers=headers,
        timeout=120,
    )
    if r_excel.status_code != 200 or len(r_excel.content) == 0:
        raise RuntimeError("Error al descargar el concentrado de cobros desde CargoLink.")

    def num(v):
        v = (v or "0").replace(",", "").replace("$", "").strip()
        try:
            return float(v)
        except ValueError:
            return 0.0

    def fecha(v):
        v = (v or "").strip()
        try:
            return datetime.strptime(v, "%d-%m-%Y").date()
        except ValueError:
            return None

    soup = BeautifulSoup(r_excel.content.decode("utf-8-sig", errors="replace"), "html.parser")
    tabla = soup.find("table")
    filas_html = tabla.find_all("tr") if tabla else []

    cobros = []
    header_visto = False
    for tr in filas_html:
        celdas = [c.get_text(strip=True) for c in tr.find_all(["th", "td"])]
        if not celdas:
            continue
        if celdas[0] == "Folio cobro":
            header_visto = True
            continue
        if not header_visto or len(celdas) < 18 or not celdas[2]:
            continue  # fila de título arriba de la tabla, o sin Referencia (nota/anotación, no un cobro real)
        cobros.append({
            "folio_cobro": celdas[0],
            "folio_factura": celdas[1],
            "referencia": celdas[2],
            "uuid": celdas[3],
            "tipo_docto": celdas[4],
            "tipo_referencia": celdas[5],
            "cliente": celdas[6],
            "fecha_factura": fecha(celdas[7]),
            "fecha_cobro": fecha(celdas[8]),
            "dias_diferencia": int(celdas[9]) if celdas[9].isdigit() else None,
            "fecha_timbre": celdas[10],
            "banco": celdas[11],
            "moneda": celdas[12],
            "subtotal": num(celdas[13]),
            "iva": num(celdas[14]),
            "descuento": num(celdas[15]),
            "retencion": num(celdas[16]),
            "total": num(celdas[17]),
        })

    return cobros


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
    siempre ven todo, igual que quien tenga marcado "Todas las plazas" en
    Catálogos → Visibilidad de Plazas. El resto ve solo las plazas que se le
    hayan asignado ahí (ninguna hasta que un admin le asigne alguna)."""
    if session.get("es_admin") or session.get("todas_las_plazas"):
        return None
    usuario_id = session.get("usuario_id")
    if not usuario_id:
        return set()
    db = get_db()
    filas = db.execute("SELECT plaza FROM app_user_plazas WHERE user_id = %s", (usuario_id,)).fetchall()
    db.close()
    return {f["plaza"] for f in filas}


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


def usuario_puede_comisiones():
    """True = el usuario en sesión puede ver la pestaña y la pantalla de
    Comisiones. Los administradores siempre pueden; para el resto se usa
    el permiso guardado en sesión al hacer login
    (app_user_permissions.puede_comisiones), otorgado desde Catálogos →
    Permiso de Comisiones."""
    if session.get("es_admin"):
        return True
    return bool(session.get("puede_comisiones"))


@app.context_processor
def inject_permisos_exportar():
    return {
        "puede_exportar": usuario_puede_exportar(),
        "puede_actualizar": usuario_puede_actualizar(),
        "puede_comisiones": usuario_puede_comisiones(),
    }


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
            coalesce(p.puede_comisiones, false) AS puede_comisiones,
            coalesce(p.todas_las_plazas, false) AS todas_las_plazas,
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
            session["puede_comisiones"] = bool(fila["puede_comisiones"])
            session["todas_las_plazas"] = bool(fila["todas_las_plazas"])
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
    """Descarga bookings de CargoLink y reemplaza reporte_bookings solo para
    el rango [fecha_inicio, fecha_fin] — lo que ya existe fuera de ese rango
    (ej. años anteriores cargados una sola vez) no se toca.
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
    cur.execute(
        "DELETE FROM reporte_bookings WHERE fecha >= %s AND fecha < (%s::date + interval '1 day')",
        (fecha_inicio, fecha_fin),
    )
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


def construir_presupuesto_mensual(plazas_permitidas=None):
    """Suma de presupuesto por mes (mismo criterio que la tabla Venta por
    Plaza del Dashboard: presupuesto por vendedor, filtrado por plaza),
    para comparar Venta vs Presupuesto en /reportes."""
    db = get_db()
    plaza_por_vendedor = {}
    for r in db.execute("SELECT vendedor, plaza FROM catalogo_vendedores"):
        plaza_por_vendedor[normalizar(r["vendedor"])] = r["plaza"]

    totales = {}
    for r in db.execute("SELECT mes, vendedor, presupuesto FROM catalogo_presupuesto WHERE vendedor IS NOT NULL"):
        plaza = plaza_por_vendedor.get(normalizar(r["vendedor"]), "#N/D")
        if plazas_permitidas is not None and plaza not in plazas_permitidas:
            continue
        totales[r["mes"]] = totales.get(r["mes"], 0.0) + float(r["presupuesto"])
    db.close()
    return [{"mes": mes, "ppto": round(v, 2)} for mes, v in sorted(totales.items())]


@app.route("/reportes")
@login_required
def reportes_graficas():
    plazas_permitidas = plazas_permitidas_usuario()
    filas = construir_filas_reportes(plazas_permitidas)
    presupuesto_mensual = construir_presupuesto_mensual(plazas_permitidas)
    datos_json = json.dumps(filas).replace("</", "<\\/")
    presupuesto_json = json.dumps(presupuesto_mensual).replace("</", "<\\/")
    return render_template(
        "reportes.html", datos_json=datos_json, presupuesto_json=presupuesto_json, hay_datos=len(filas) > 0
    )


@app.route("/comisiones")
@login_required
def comisiones():
    if not usuario_puede_comisiones():
        flash("No tienes permiso para ver Comisiones.")
        return redirect(url_for("dashboard_plazas_vendedores"))

    db = get_db()
    folios_disponibles = db.execute(
        "SELECT DISTINCT folio, descripcion FROM comisiones_liquidacion_detalle WHERE folio >= 51 ORDER BY folio DESC"
    ).fetchall()

    folio_solicitado = request.args.get("folio", type=int)
    folio_actual = folio_solicitado or (folios_disponibles[0]["folio"] if folios_disponibles else None)

    filas = []
    descripcion = None
    reporte_por_booking = {}
    cobros_por_booking = {}
    if folio_actual is not None:
        filas = db.execute(
            "SELECT * FROM comisiones_liquidacion_detalle WHERE folio = %s ORDER BY booking", (folio_actual,)
        ).fetchall()
        if filas:
            descripcion = filas[0]["descripcion"]
            bookings = [f["booking"] for f in filas]
            for r in db.execute(
                "SELECT referencia, venta, margen, cliente_servicio, fecha, ejecutivo, venta_por "
                "FROM reporte_bookings WHERE referencia = ANY(%s)",
                (bookings,),
            ):
                reporte_por_booking[r["referencia"]] = {
                    "venta": float(r["venta"]),
                    "margen": float(r["margen"]),
                    "cliente": r["cliente_servicio"],
                    "fecha": r["fecha"].strftime("%Y-%m-%d") if r["fecha"] else None,
                    "ejecutivo": r["ejecutivo"],
                    "venta_por": r["venta_por"],
                }
            for r in db.execute(
                "SELECT referencia, folio_cobro, folio_factura, uuid, tipo_docto, tipo_referencia, cliente, "
                "fecha_factura, fecha_cobro, dias_diferencia, fecha_timbre, banco, moneda, subtotal, iva, "
                "descuento, retencion, total "
                "FROM comisiones_cobros_detalle WHERE referencia = ANY(%s) ORDER BY fecha_cobro",
                (bookings,),
            ):
                cobros_por_booking.setdefault(r["referencia"], []).append({
                    "folio_cobro": r["folio_cobro"],
                    "folio_factura": r["folio_factura"],
                    "uuid": r["uuid"],
                    "tipo_docto": r["tipo_docto"],
                    "tipo_referencia": r["tipo_referencia"],
                    "cliente": r["cliente"],
                    "fecha_factura": r["fecha_factura"].strftime("%Y-%m-%d") if r["fecha_factura"] else None,
                    "fecha_cobro": r["fecha_cobro"].strftime("%Y-%m-%d") if r["fecha_cobro"] else None,
                    "dias_diferencia": r["dias_diferencia"],
                    "fecha_timbre": r["fecha_timbre"],
                    "banco": r["banco"],
                    "moneda": r["moneda"],
                    "subtotal": float(r["subtotal"]),
                    "iva": float(r["iva"]),
                    "descuento": float(r["descuento"]),
                    "retencion": float(r["retencion"]),
                    "total": float(r["total"]),
                })

    cobros_cargados = 0
    if folio_actual is not None:
        cobros_cargados = db.execute(
            "SELECT count(*) AS n FROM comisiones_cobros_detalle WHERE folio = %s", (folio_actual,)
        ).fetchone()["n"]
    db.close()

    total_profit = sum(float(f["profit"]) for f in filas)
    total_vendedor = sum(float(f["total_vendedor"]) for f in filas)
    total_desarrollador = sum(float(f["total_desarrollador"]) for f in filas)
    total_venta = sum(reporte_por_booking.get(f["booking"], {}).get("venta") or 0.0 for f in filas)
    margen_total = (total_profit / total_venta) if total_venta else 0.0

    def agrupar(filas, campo_nombre, campo_total):
        grupos = {}
        for f in filas:
            nombre = f[campo_nombre] or "(sin nombre)"
            g = grupos.setdefault(nombre, {"nombre": nombre, "total": 0.0, "cant_book": 0})
            g["total"] += float(f[campo_total])
            g["cant_book"] += 1
        return sorted(grupos.values(), key=lambda g: g["total"], reverse=True)

    por_vendedor = agrupar(filas, "vendedor", "total_vendedor")
    por_desarrollador = agrupar(filas, "desarrollador", "total_desarrollador")

    filas_json = json.dumps([
        {
            "booking": f["booking"],
            "folio_cobro": f["folio_cobro"],
            "profit": float(f["profit"]),
            "venta": reporte_por_booking.get(f["booking"], {}).get("venta"),
            "margen": reporte_por_booking.get(f["booking"], {}).get("margen"),
            "cliente": reporte_por_booking.get(f["booking"], {}).get("cliente"),
            "fecha": reporte_por_booking.get(f["booking"], {}).get("fecha"),
            "ejecutivo": reporte_por_booking.get(f["booking"], {}).get("ejecutivo"),
            "venta_por": reporte_por_booking.get(f["booking"], {}).get("venta_por"),
            "cobros": cobros_por_booking.get(f["booking"], []),
            "vendedor": f["vendedor"],
            "pct_vendedor": float(f["pct_vendedor"]) if f["pct_vendedor"] is not None else None,
            "total_vendedor": float(f["total_vendedor"]),
            "desarrollador": f["desarrollador"],
            "pct_desarrollador": float(f["pct_desarrollador"]) if f["pct_desarrollador"] is not None else None,
            "total_desarrollador": float(f["total_desarrollador"]),
        }
        for f in filas
    ]).replace("</", "<\\/")

    folios_cargolink = []
    if session.get("es_admin"):
        try:
            folios_cargolink = listar_folios_liquidacion_cargolink()
        except RuntimeError as e:
            flash(f"No se pudo consultar la lista de folios en CargoLink: {e}")

    return render_template(
        "comisiones.html",
        folios_disponibles=folios_disponibles,
        folios_cargolink=folios_cargolink,
        folio_actual=folio_actual,
        descripcion=descripcion,
        filas=filas,
        filas_json=filas_json,
        total_profit=total_profit,
        total_vendedor=total_vendedor,
        total_desarrollador=total_desarrollador,
        total_venta=total_venta,
        margen_total=margen_total,
        total_liquidar=total_vendedor + total_desarrollador,
        por_vendedor=por_vendedor,
        por_desarrollador=por_desarrollador,
        cobros_cargados=cobros_cargados,
    )


@app.route("/comisiones/exportar")
@login_required
def comisiones_exportar():
    if not usuario_puede_comisiones():
        flash("No tienes permiso para ver Comisiones.")
        return redirect(url_for("dashboard_plazas_vendedores"))

    folio = request.args.get("folio", type=int)
    campo = request.args.get("campo")
    nombre = request.args.get("nombre", "")
    if folio is None or campo not in ("vendedor", "desarrollador") or not nombre:
        flash("Parámetros inválidos para exportar.")
        return redirect(url_for("comisiones"))

    db = get_db()
    filas = db.execute(
        f"SELECT * FROM comisiones_liquidacion_detalle WHERE folio = %s AND {campo} = %s ORDER BY booking",
        (folio, nombre),
    ).fetchall()
    descripcion = filas[0]["descripcion"] if filas else ""

    venta_por_booking = {}
    if filas:
        bookings = [f["booking"] for f in filas]
        for r in db.execute("SELECT referencia, venta FROM reporte_bookings WHERE referencia = ANY(%s)", (bookings,)):
            venta_por_booking[r["referencia"]] = float(r["venta"])
    db.close()

    campo_total = "total_vendedor" if campo == "vendedor" else "total_desarrollador"
    etiqueta = "Vendedor" if campo == "vendedor" else "Desarrollador"

    profit_total = sum(float(f["profit"]) for f in filas)
    comision_total = sum(float(f[campo_total]) for f in filas)
    venta_total = sum(venta_por_booking.get(f["booking"], 0.0) for f in filas)
    margen = (profit_total / venta_total) if venta_total else 0.0

    amarillo = PatternFill(fill_type="solid", fgColor="FFF59D")
    naranja = PatternFill(fill_type="solid", fgColor="C1502E")
    lado = Side(style="thin", color="E6C200")
    borde = Border(left=lado, right=lado, top=lado, bottom=lado)
    centrado = Alignment(horizontal="center", vertical="center")
    izquierda = Alignment(horizontal="left", vertical="center")
    derecha = Alignment(horizontal="right", vertical="center")

    wb = openpyxl.Workbook()
    ws = wb.active
    ws.title = "Comisiones"

    ws.merge_cells("A1:C1")
    titulo = ws["A1"]
    titulo.value = f"Comisiones {descripcion}"
    titulo.font = Font(bold=True, size=13)
    titulo.alignment = centrado
    ws.row_dimensions[1].height = 22

    ws["A3"] = etiqueta
    ws["A3"].font = Font(bold=True)
    ws.merge_cells("B3:C3")
    ws["B3"] = nombre
    ws["B3"].font = Font(bold=True)
    ws["B3"].alignment = centrado
    for coord in ("A3", "B3", "C3"):
        ws[coord].fill = amarillo
        ws[coord].border = borde

    stats = [
        ("Cantidad de Booking", len(filas), None),
        ("Venta Total USD", venta_total, "#,##0.00"),
        ("Profit USD", profit_total, "#,##0.00"),
        ("Margen", margen, "0.00%"),
        ("Comisión", comision_total, "#,##0.00"),
    ]
    fila = 5
    for etq, valor, formato in stats:
        celda_etq = ws.cell(row=fila, column=1, value=etq)
        celda_etq.font = Font(bold=True)
        celda_etq.fill = amarillo
        celda_etq.border = borde
        celda_valor = ws.cell(row=fila, column=2, value=valor)
        celda_valor.font = Font(bold=True)
        celda_valor.alignment = derecha
        celda_valor.fill = amarillo
        celda_valor.border = borde
        if formato:
            celda_valor.number_format = formato
        fila += 1

    fila_tabla = fila + 1
    encabezados = ["Booking", "Profit", f"Comisión {etiqueta}"]
    for col, encabezado in enumerate(encabezados, start=1):
        celda = ws.cell(row=fila_tabla, column=col, value=encabezado)
        celda.fill = naranja
        celda.font = Font(bold=True, color="FFFFFF")
        celda.alignment = centrado if col == 1 else derecha

    for i, f in enumerate(filas, start=fila_tabla + 1):
        ws.cell(row=i, column=1, value=f["booking"]).alignment = izquierda
        celda_profit = ws.cell(row=i, column=2, value=float(f["profit"]))
        celda_profit.number_format = "#,##0.00"
        celda_profit.alignment = derecha
        celda_com = ws.cell(row=i, column=3, value=float(f[campo_total]))
        celda_com.number_format = "#,##0.00"
        celda_com.alignment = derecha

    ws.column_dimensions["A"].width = 20
    ws.column_dimensions["B"].width = 16
    ws.column_dimensions["C"].width = 20
    ws.freeze_panes = ws.cell(row=fila_tabla + 1, column=1).coordinate

    buffer = io.BytesIO()
    wb.save(buffer)
    buffer.seek(0)
    nombre_archivo = re.sub(r"[^a-zA-Z0-9]+", "_", f"Comisiones_{nombre}_{descripcion}").strip("_") + ".xlsx"
    return send_file(
        buffer, as_attachment=True, download_name=nombre_archivo,
        mimetype="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )


@app.route("/comisiones/cargar", methods=["POST"])
@admin_required
def comisiones_cargar():
    folio_raw = (request.form.get("folio") or "").strip()
    try:
        folio = int(folio_raw)
    except ValueError:
        flash("Folio inválido.")
        return redirect(url_for("comisiones"))

    try:
        resultado = descargar_liquidacion_vendedor_cargolink(folio)
    except RuntimeError as e:
        flash(str(e))
        return redirect(url_for("comisiones"))

    db = get_db()
    db.execute("DELETE FROM comisiones_liquidacion_detalle WHERE folio = %s", (folio,))
    for d in resultado["detalle"]:
        db.execute(
            """
            INSERT INTO comisiones_liquidacion_detalle
                (folio, descripcion, booking, folio_cobro, profit, vendedor, pct_vendedor,
                 total_vendedor, desarrollador, pct_desarrollador, total_desarrollador)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                resultado["folio"], resultado["descripcion"], d["booking"], d["folio_cobro"], d["profit"],
                d["vendedor"], d["pct_vendedor"], d["total_vendedor"], d["desarrollador"],
                d["pct_desarrollador"], d["total_desarrollador"],
            ),
        )
    db.commit()
    db.close()

    flash(f"Folio {folio} cargado: {len(resultado['detalle'])} booking(s).")
    return redirect(url_for("comisiones", folio=folio))


@app.route("/comisiones/cobros/cargar", methods=["POST"])
@admin_required
def comisiones_cobros_cargar():
    folio_raw = (request.form.get("folio") or "").strip()
    descripcion = (request.form.get("descripcion") or "").strip()
    fecha_ini = (request.form.get("fecha_ini") or "").strip()
    fecha_fin = (request.form.get("fecha_fin") or "").strip()
    try:
        folio = int(folio_raw)
    except ValueError:
        flash("Folio inválido.")
        return redirect(url_for("comisiones"))
    if not DATE_RE.match(fecha_ini) or not DATE_RE.match(fecha_fin):
        flash("Selecciona una fecha inicial y una fecha final válidas.")
        return redirect(url_for("comisiones", folio=folio))

    etiqueta = f"{folio} {descripcion}".strip()

    try:
        cobros = descargar_concentrado_cobros_cargolink(fecha_ini, fecha_fin)
    except RuntimeError as e:
        flash(str(e))
        return redirect(url_for("comisiones", folio=folio))

    db = get_db()
    db.execute("DELETE FROM comisiones_cobros_detalle WHERE folio = %s", (folio,))
    for c in cobros:
        db.execute(
            """
            INSERT INTO comisiones_cobros_detalle
                (folio, etiqueta, folio_cobro, folio_factura, referencia, uuid, tipo_docto, tipo_referencia,
                 cliente, fecha_factura, fecha_cobro, dias_diferencia, fecha_timbre, banco, moneda,
                 subtotal, iva, descuento, retencion, total)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)
            """,
            (
                folio, etiqueta, c["folio_cobro"], c["folio_factura"], c["referencia"], c["uuid"],
                c["tipo_docto"], c["tipo_referencia"], c["cliente"], c["fecha_factura"], c["fecha_cobro"],
                c["dias_diferencia"], c["fecha_timbre"], c["banco"], c["moneda"], c["subtotal"], c["iva"],
                c["descuento"], c["retencion"], c["total"],
            ),
        )
    db.commit()
    db.close()

    flash(f'Cobros cargados para "{etiqueta}": {len(cobros)} registro(s).')
    return redirect(url_for("comisiones", folio=folio))


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
            coalesce(p.puede_actualizar, false) AS puede_actualizar,
            coalesce(p.puede_comisiones, false) AS puede_comisiones
        FROM auth.users u
        LEFT JOIN public.app_user_permissions p ON p.user_id = u.id
        ORDER BY u.email
        """
    ).fetchall()
    db.close()
    return render_template("permisos_actualizar.html", filas=filas)


PERMISOS_TOGGLEABLES = {"puede_actualizar", "puede_comisiones"}


@app.route("/catalogos/permisos-actualizar/<uuid:user_id>/toggle", methods=["POST"])
@admin_required
def permisos_actualizar_toggle(user_id):
    campo = request.form.get("campo") or "puede_actualizar"
    if campo not in PERMISOS_TOGGLEABLES:
        flash("Permiso inválido.")
        return redirect(url_for("permisos_actualizar"))

    nuevo_valor = request.form.get("valor") == "1"
    db = get_db()
    db.execute(
        f"""
        INSERT INTO app_user_permissions (user_id, {campo})
        VALUES (%s, %s)
        ON CONFLICT (user_id) DO UPDATE SET {campo} = EXCLUDED.{campo}, updated_at = now()
        """,
        (str(user_id), nuevo_valor),
    )
    db.commit()
    db.close()
    return redirect(url_for("permisos_actualizar"))


def get_plazas_catalogo():
    """Todas las plazas conocidas (unión de catalogo_vendedores y
    catalogo_desarrolladores), para poblar los checkboxes de visibilidad."""
    db = get_db()
    filas_v = db.execute("SELECT DISTINCT plaza FROM catalogo_vendedores").fetchall()
    filas_d = db.execute("SELECT DISTINCT plaza FROM catalogo_desarrolladores").fetchall()
    db.close()
    plazas = {f["plaza"] for f in filas_v if f["plaza"]} | {f["plaza"] for f in filas_d if f["plaza"]}
    return sorted(plazas)


@app.route("/catalogos/visibilidad-plazas")
@admin_required
def visibilidad_plazas():
    db = get_db()
    usuarios_filas = db.execute(
        """
        SELECT u.id, u.email,
            coalesce(p.es_admin, false) AS es_admin,
            coalesce(p.todas_las_plazas, false) AS todas_las_plazas
        FROM auth.users u
        LEFT JOIN public.app_user_permissions p ON p.user_id = u.id
        ORDER BY u.email
        """
    ).fetchall()
    plazas_por_usuario = {}
    for r in db.execute("SELECT user_id, plaza FROM app_user_plazas ORDER BY plaza"):
        plazas_por_usuario.setdefault(str(r["user_id"]), []).append(r["plaza"])
    db.close()

    filas = []
    for u in usuarios_filas:
        filas.append({
            "id": u["id"],
            "email": u["email"],
            "es_admin": u["es_admin"],
            "todas_las_plazas": u["todas_las_plazas"],
            "plazas": plazas_por_usuario.get(str(u["id"]), []),
        })
    return render_template("visibilidad_plazas.html", filas=filas)


@app.route("/catalogos/visibilidad-plazas/<uuid:user_id>/editar", methods=["GET", "POST"])
@admin_required
def visibilidad_plazas_editar(user_id):
    db = get_db()
    usuario = db.execute("SELECT id, email FROM auth.users WHERE id = %s", (str(user_id),)).fetchone()
    if usuario is None:
        db.close()
        return "No encontrado", 404

    if request.method == "POST":
        todas_las_plazas = request.form.get("todas_las_plazas") == "on"
        plazas_seleccionadas = request.form.getlist("plazas")
        if not todas_las_plazas and not plazas_seleccionadas:
            flash('Selecciona al menos una plaza, o marca "Todas las plazas".')
        else:
            db.execute(
                """
                INSERT INTO app_user_permissions (user_id, todas_las_plazas)
                VALUES (%s, %s)
                ON CONFLICT (user_id) DO UPDATE SET todas_las_plazas = EXCLUDED.todas_las_plazas, updated_at = now()
                """,
                (str(user_id), todas_las_plazas),
            )
            db.execute("DELETE FROM app_user_plazas WHERE user_id = %s", (str(user_id),))
            if not todas_las_plazas:
                for plaza in plazas_seleccionadas:
                    db.execute(
                        "INSERT INTO app_user_plazas (user_id, plaza) VALUES (%s, %s)",
                        (str(user_id), plaza),
                    )
            db.commit()
            db.close()
            return redirect(url_for("visibilidad_plazas"))

    plazas_actuales = {r["plaza"] for r in db.execute("SELECT plaza FROM app_user_plazas WHERE user_id = %s", (str(user_id),))}
    todas_las_plazas_actual = db.execute(
        "SELECT coalesce(todas_las_plazas, false) AS v FROM app_user_permissions WHERE user_id = %s", (str(user_id),)
    ).fetchone()
    db.close()
    return render_template(
        "visibilidad_plazas_editar.html",
        usuario=usuario,
        plazas_catalogo=get_plazas_catalogo(),
        plazas_actuales=plazas_actuales,
        sin_restriccion=bool(todas_las_plazas_actual and todas_las_plazas_actual["v"]),
    )


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
