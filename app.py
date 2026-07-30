#!/usr/bin/env python3
"""App local con login y un botón para generar el Reporte de Vendedores de CargoLink."""

import csv
import io
import json
import os
import re
import secrets
import sqlite3
import subprocess
from datetime import datetime
from functools import wraps

import openpyxl
from dotenv import load_dotenv
from flask import Flask, flash, redirect, render_template, request, send_file, send_from_directory, session, url_for
from werkzeug.security import check_password_hash, generate_password_hash

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
load_dotenv(os.path.join(BASE_DIR, ".env"))

# DATA_DIR es donde vive todo lo que debe persistir (base de datos, clave de
# sesión, reportes descargados). En local es la propia carpeta webapp/; en
# Railway se apunta a la ruta del Volume vía la variable de entorno DATA_DIR.
DATA_DIR = os.environ.get("DATA_DIR") or BASE_DIR
os.makedirs(DATA_DIR, exist_ok=True)

REPORTS_DIR = os.environ.get("REPORTES_DIR") or DATA_DIR
os.makedirs(REPORTS_DIR, exist_ok=True)

SCRIPT_PATH = os.path.join(BASE_DIR, "descargar_reporte.py")
SECRET_KEY_PATH = os.path.join(DATA_DIR, ".secret_key")
DB_PATH = os.path.join(DATA_DIR, "reporte_vendedores.db")
HASH_METHOD = "pbkdf2:sha256"

REPORT_FILENAME_RE = re.compile(r"^Reporte_Vendedores_\d{4}-\d{2}-\d{2}_al_\d{4}-\d{2}-\d{2}\.xlsx$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def get_secret_key():
    env_key = os.environ.get("SECRET_KEY")
    if env_key:
        return env_key
    if os.path.exists(SECRET_KEY_PATH):
        with open(SECRET_KEY_PATH, "r") as f:
            return f.read().strip()
    key = secrets.token_hex(32)
    with open(SECRET_KEY_PATH, "w") as f:
        f.write(key)
    return key


def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    """Crea las tablas si no existen (primer arranque en una base vacía) y,
    si se definieron INITIAL_ADMIN_USER / INITIAL_ADMIN_PASSWORD y todavía no
    hay ningún usuario, da de alta ese primer administrador."""
    db = get_db()
    db.executescript("""
        CREATE TABLE IF NOT EXISTS usuarios (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            usuario TEXT NOT NULL,
            password_hash TEXT NOT NULL,
            creado_en TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            es_admin INTEGER NOT NULL DEFAULT 0
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_usuarios_usuario ON usuarios (lower(usuario));

        CREATE TABLE IF NOT EXISTS catalogo_vendedores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            vendedor TEXT NOT NULL UNIQUE,
            plaza TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS catalogo_desarrolladores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            desarrollador TEXT NOT NULL UNIQUE,
            plaza TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS catalogo_presupuesto (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            mes TEXT NOT NULL,
            vendedor TEXT NOT NULL,
            desarrollador TEXT,
            presupuesto NUMERIC NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS uq_catalogo_presupuesto_mes_vendedor_dev
            ON catalogo_presupuesto (mes, vendedor, coalesce(desarrollador, ''));
    """)
    db.commit()

    hay_usuarios = db.execute("SELECT COUNT(*) AS c FROM usuarios").fetchone()["c"]
    admin_inicial = os.environ.get("INITIAL_ADMIN_USER")
    clave_inicial = os.environ.get("INITIAL_ADMIN_PASSWORD")
    if hay_usuarios == 0 and admin_inicial and clave_inicial:
        db.execute(
            "INSERT INTO usuarios (usuario, password_hash, es_admin) VALUES (?, ?, 1)",
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
    filas = db.execute(
        "SELECT vendedor FROM catalogo_vendedores ORDER BY vendedor"
    ).fetchall()
    return [f["vendedor"] for f in filas]


def get_desarrolladores(db):
    filas = db.execute(
        "SELECT desarrollador FROM catalogo_desarrolladores ORDER BY desarrollador"
    ).fetchall()
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


def archivo_reporte_mas_reciente():
    candidatos = [
        f for f in os.listdir(REPORTS_DIR)
        if REPORT_FILENAME_RE.match(f) and os.path.isfile(os.path.join(REPORTS_DIR, f))
    ]
    if not candidatos:
        return None
    candidatos.sort(key=lambda f: os.path.getmtime(os.path.join(REPORTS_DIR, f)), reverse=True)
    return os.path.join(REPORTS_DIR, candidatos[0])


def construir_datos_dashboard():
    ruta_reporte = archivo_reporte_mas_reciente()
    if ruta_reporte is None:
        return None

    db = get_db()
    catalogo_vendedor = {}
    for r in db.execute("SELECT vendedor, plaza FROM catalogo_vendedores"):
        catalogo_vendedor[normalizar(r["vendedor"])] = {"plaza": r["plaza"], "nombre": r["vendedor"]}

    presupuesto_por_mes_vendedor = {}
    nombre_por_norm = {}
    for r in db.execute("SELECT mes, vendedor, presupuesto FROM catalogo_presupuesto"):
        clave = (r["mes"], normalizar(r["vendedor"]))
        presupuesto_por_mes_vendedor[clave] = presupuesto_por_mes_vendedor.get(clave, 0.0) + r["presupuesto"]
        nombre_por_norm.setdefault(normalizar(r["vendedor"]), r["vendedor"])
    db.close()

    wb = openpyxl.load_workbook(ruta_reporte, data_only=True)
    ws = wb.active
    filas_hoja = list(ws.iter_rows(values_only=True))
    header = filas_hoja[2]
    idx = {name: i for i, name in enumerate(header) if name}
    i_fecha = idx["Fecha de creacion"]
    i_vendedor = idx["Vendedor"]
    i_venta = idx["Venta"]
    i_profit = idx["Profit"]
    i_referencia = idx["Referencia"]
    i_ejecutivo = idx["Ejecutivo"]
    i_venta_por = idx["Venta por"]
    i_cliente_servicio = idx["Cliente servicio"]
    i_margen = idx["Margen"]

    agregados = {}
    detalle = []
    for r in filas_hoja[3:]:
        fecha = r[i_fecha]
        vendedor_raw = r[i_vendedor]
        if not isinstance(fecha, datetime) or not isinstance(vendedor_raw, str):
            continue
        mes = fecha.strftime("%Y-%m")
        vkey = normalizar(vendedor_raw)
        nombre_por_norm.setdefault(vkey, vendedor_raw)
        clave = (mes, vkey)
        agg = agregados.setdefault(clave, {"cant_book": 0, "venta": 0.0, "profit": 0.0})
        agg["cant_book"] += 1
        agg["venta"] += float(r[i_venta] or 0)
        agg["profit"] += float(r[i_profit] or 0)

        cat = catalogo_vendedor.get(vkey)
        nombre_canonico = cat["nombre"] if cat else nombre_por_norm[vkey]
        detalle.append({
            "mes": mes,
            "vendedor": nombre_canonico,
            "referencia": r[i_referencia] or "",
            "fecha": fecha.strftime("%Y-%m-%d %H:%M"),
            "ejecutivo": r[i_ejecutivo] or "",
            "venta_por": r[i_venta_por] or "",
            "cliente_servicio": r[i_cliente_servicio] or "",
            "profit": round(float(r[i_profit] or 0), 2),
            "margen": round(float(r[i_margen] or 0), 4),
        })

    for clave in presupuesto_por_mes_vendedor:
        agregados.setdefault(clave, {"cant_book": 0, "venta": 0.0, "profit": 0.0})

    filas = []
    for (mes, vkey), agg in agregados.items():
        cat = catalogo_vendedor.get(vkey)
        plaza = cat["plaza"] if cat else "#N/D"
        nombre = cat["nombre"] if cat else nombre_por_norm.get(vkey, vkey)
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
        "archivo": os.path.basename(ruta_reporte),
        "generado_en": datetime.fromtimestamp(os.path.getmtime(ruta_reporte)).strftime("%d/%m/%Y %H:%M"),
        "filas": filas,
        "detalle": detalle,
        "meses": sorted(set(f["mes"] for f in filas)),
        "plazas": sorted(set(f["plaza"] for f in filas)),
        "vendedores": sorted(set(f["vendedor"] for f in filas)),
    }


init_db()

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
        fila = db.execute("SELECT * FROM usuarios WHERE lower(usuario) = lower(?)", (usuario,)).fetchone()
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

    args = ["python3", SCRIPT_PATH]
    if fecha_inicio:
        if not DATE_RE.match(fecha_inicio):
            session["resultado"] = {"ok": False, "mensaje": "Fecha de inicio inválida."}
            return redirect(url_for("dashboard"))
        args.append(fecha_inicio)
        if fecha_fin:
            if not DATE_RE.match(fecha_fin):
                session["resultado"] = {"ok": False, "mensaje": "Fecha de fin inválida."}
                return redirect(url_for("dashboard"))
            args.append(fecha_fin)

    try:
        entorno = {**os.environ, "REPORTES_DIR": REPORTS_DIR}
        proc = subprocess.run(args, cwd=REPORTS_DIR, env=entorno, capture_output=True, text=True, timeout=300)
    except subprocess.TimeoutExpired:
        session["resultado"] = {"ok": False, "mensaje": "Tiempo de espera agotado al generar el reporte."}
        return redirect(url_for("dashboard"))

    output = (proc.stdout or "") + (proc.stderr or "")
    if proc.returncode != 0:
        session["resultado"] = {"ok": False, "mensaje": "Error al generar el reporte.", "detalle": output[-2000:]}
        return redirect(url_for("dashboard"))

    match = re.search(r"Excel guardado exitosamente en: (.+\.xlsx)", output)
    if not match:
        session["resultado"] = {"ok": False, "mensaje": "No se pudo localizar el archivo generado.", "detalle": output[-2000:]}
        return redirect(url_for("dashboard"))

    filename = os.path.basename(match.group(1).strip())
    if not REPORT_FILENAME_RE.match(filename):
        session["resultado"] = {"ok": False, "mensaje": "Nombre de archivo generado no reconocido."}
        return redirect(url_for("dashboard"))

    session["resultado"] = {"ok": True, "mensaje": "Reporte generado correctamente.", "archivo": filename}
    return redirect(url_for("dashboard"))


@app.route("/descargar/<path:filename>")
@login_required
def descargar(filename):
    if not REPORT_FILENAME_RE.match(filename):
        return "Archivo no válido", 400
    return send_from_directory(REPORTS_DIR, filename, as_attachment=True)


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
                db.execute(
                    "INSERT INTO catalogo_vendedores (vendedor, plaza) VALUES (?, ?)",
                    (vendedor, plaza),
                )
                db.commit()
            except sqlite3.IntegrityError:
                flash("Ese Vendedor ya existe en el catálogo.")
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
                    "UPDATE catalogo_vendedores SET vendedor = ?, plaza = ? WHERE id = ?",
                    (vendedor, plaza, fila_id),
                )
                db.commit()
            except sqlite3.IntegrityError:
                flash("Ese Vendedor ya existe en el catálogo.")
            db.close()
            return redirect(url_for("catalogo_vendedores"))

    fila = db.execute("SELECT * FROM catalogo_vendedores WHERE id = ?", (fila_id,)).fetchone()
    db.close()
    if fila is None:
        return "No encontrado", 404
    return render_template("catalogo_vendedores_editar.html", fila=fila)


@app.route("/catalogos/vendedores/<int:fila_id>/eliminar", methods=["POST"])
@admin_required
def catalogo_vendedores_eliminar(fila_id):
    db = get_db()
    db.execute("DELETE FROM catalogo_vendedores WHERE id = ?", (fila_id,))
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
                db.execute(
                    "INSERT INTO catalogo_desarrolladores (desarrollador, plaza) VALUES (?, ?)",
                    (desarrollador, plaza),
                )
                db.commit()
            except sqlite3.IntegrityError:
                flash("Ese Desarrollador ya existe en el catálogo.")
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
                    "UPDATE catalogo_desarrolladores SET desarrollador = ?, plaza = ? WHERE id = ?",
                    (desarrollador, plaza, fila_id),
                )
                db.commit()
            except sqlite3.IntegrityError:
                flash("Ese Desarrollador ya existe en el catálogo.")
            db.close()
            return redirect(url_for("catalogo_desarrolladores"))

    fila = db.execute("SELECT * FROM catalogo_desarrolladores WHERE id = ?", (fila_id,)).fetchone()
    db.close()
    if fila is None:
        return "No encontrado", 404
    return render_template("catalogo_desarrolladores_editar.html", fila=fila)


@app.route("/catalogos/desarrolladores/<int:fila_id>/eliminar", methods=["POST"])
@admin_required
def catalogo_desarrolladores_eliminar(fila_id):
    db = get_db()
    db.execute("DELETE FROM catalogo_desarrolladores WHERE id = ?", (fila_id,))
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
        es_admin = 1 if request.form.get("es_admin") else 0
        if not usuario or not clave:
            flash("Usuario y contraseña son obligatorios.")
        elif clave != clave_confirmar:
            flash("Las contraseñas no coinciden.")
        else:
            try:
                db.execute(
                    "INSERT INTO usuarios (usuario, password_hash, es_admin) VALUES (?, ?, ?)",
                    (usuario, generate_password_hash(clave, method=HASH_METHOD), es_admin),
                )
                db.commit()
            except sqlite3.IntegrityError:
                flash("Ese usuario ya existe.")
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
        es_admin = 1 if request.form.get("es_admin") else 0
        admins_actuales = db.execute("SELECT COUNT(*) AS c FROM usuarios WHERE es_admin = 1").fetchone()["c"]
        fila_actual = db.execute("SELECT es_admin FROM usuarios WHERE id = ?", (fila_id,)).fetchone()
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
                        "UPDATE usuarios SET usuario = ?, password_hash = ?, es_admin = ? WHERE id = ?",
                        (usuario, generate_password_hash(clave, method=HASH_METHOD), es_admin, fila_id),
                    )
                else:
                    db.execute(
                        "UPDATE usuarios SET usuario = ?, es_admin = ? WHERE id = ?",
                        (usuario, es_admin, fila_id),
                    )
                db.commit()
                if fila_id == session.get("usuario_id"):
                    session["usuario"] = usuario
                    session["es_admin"] = bool(es_admin)
            except sqlite3.IntegrityError:
                flash("Ese usuario ya existe.")
            db.close()
            return redirect(url_for("catalogo_usuarios"))

    fila = db.execute("SELECT id, usuario, es_admin FROM usuarios WHERE id = ?", (fila_id,)).fetchone()
    db.close()
    if fila is None:
        return "No encontrado", 404
    return render_template("catalogo_usuarios_editar.html", fila=fila)


@app.route("/catalogos/usuarios/<int:fila_id>/eliminar", methods=["POST"])
@admin_required
def catalogo_usuarios_eliminar(fila_id):
    db = get_db()
    total = db.execute("SELECT COUNT(*) AS c FROM usuarios").fetchone()["c"]
    admins = db.execute("SELECT COUNT(*) AS c FROM usuarios WHERE es_admin = 1").fetchone()["c"]
    fila = db.execute("SELECT es_admin FROM usuarios WHERE id = ?", (fila_id,)).fetchone()
    if total <= 1:
        flash("No puedes eliminar el único usuario que queda.")
    elif fila_id == session.get("usuario_id"):
        flash("No puedes eliminar el usuario con el que iniciaste sesión.")
    elif fila and fila["es_admin"] and admins <= 1:
        flash("No puedes eliminar al único administrador que queda.")
    else:
        db.execute("DELETE FROM usuarios WHERE id = ?", (fila_id,))
        db.commit()
    db.close()
    return redirect(url_for("catalogo_usuarios"))


@app.route("/catalogos/presupuesto", methods=["GET", "POST"])
@admin_required
def catalogo_presupuesto():
    db = get_db()
    if request.method == "POST":
        mes = request.form.get("mes", "").strip()
        vendedor = request.form.get("vendedor", "").strip()
        desarrollador = request.form.get("desarrollador", "").strip() or None
        presupuesto_raw = request.form.get("presupuesto", "")
        if not mes or not vendedor or not presupuesto_raw:
            flash("Mes, Vendedor y Presupuesto son obligatorios.")
        else:
            try:
                presupuesto = parse_presupuesto(presupuesto_raw)
            except ValueError:
                flash("El presupuesto debe ser un número válido.")
                presupuesto = None
            if presupuesto is not None:
                try:
                    db.execute(
                        "INSERT INTO catalogo_presupuesto (mes, vendedor, desarrollador, presupuesto) VALUES (?, ?, ?, ?)",
                        (mes, vendedor, desarrollador, presupuesto),
                    )
                    db.commit()
                except sqlite3.IntegrityError:
                    flash("Ya existe un presupuesto para ese Mes, Vendedor y Desarrollador.")
        return redirect(url_for("catalogo_presupuesto"))

    filas = db.execute(
        "SELECT * FROM catalogo_presupuesto ORDER BY mes DESC, vendedor"
    ).fetchall()
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
        vendedor = request.form.get("vendedor", "").strip()
        desarrollador = request.form.get("desarrollador", "").strip() or None
        presupuesto_raw = request.form.get("presupuesto", "")
        if not mes or not vendedor or not presupuesto_raw:
            flash("Mes, Vendedor y Presupuesto son obligatorios.")
        else:
            try:
                presupuesto = parse_presupuesto(presupuesto_raw)
            except ValueError:
                flash("El presupuesto debe ser un número válido.")
                presupuesto = None
            if presupuesto is not None:
                try:
                    db.execute(
                        "UPDATE catalogo_presupuesto SET mes = ?, vendedor = ?, desarrollador = ?, presupuesto = ? WHERE id = ?",
                        (mes, vendedor, desarrollador, presupuesto, fila_id),
                    )
                    db.commit()
                except sqlite3.IntegrityError:
                    flash("Ya existe un presupuesto para ese Mes, Vendedor y Desarrollador.")
                db.close()
                return redirect(url_for("catalogo_presupuesto"))

    fila = db.execute("SELECT * FROM catalogo_presupuesto WHERE id = ?", (fila_id,)).fetchone()
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
    db.execute("DELETE FROM catalogo_presupuesto WHERE id = ?", (fila_id,))
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
            vendedor = str(fila.get("vendedor") or "").strip()
            desarrollador = str(fila.get("desarrollador") or "").strip() or None
            presupuesto_raw = fila.get("presupuesto")

            if not mes or not vendedor or presupuesto_raw in (None, ""):
                errores.append(f"Fila {numero_fila}: faltan datos obligatorios (mes, vendedor o presupuesto).")
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
                "SELECT id FROM catalogo_presupuesto WHERE mes = ? AND vendedor = ? AND coalesce(desarrollador, '') = coalesce(?, '')",
                (mes, vendedor, desarrollador),
            ).fetchone()
            if existente:
                db.execute(
                    "UPDATE catalogo_presupuesto SET presupuesto = ? WHERE id = ?",
                    (presupuesto, existente["id"]),
                )
                actualizados += 1
            else:
                db.execute(
                    "INSERT INTO catalogo_presupuesto (mes, vendedor, desarrollador, presupuesto) VALUES (?, ?, ?, ?)",
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
