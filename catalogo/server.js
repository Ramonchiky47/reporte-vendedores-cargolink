const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const pgSessionFabrica = require('connect-pg-simple');
const PDFDocument = require('pdfkit');
const { db, pool, transaction } = require('./db');

const MODULOS = ['ordenes', 'detalle_compra', 'catalogos'];

function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verificarPassword(password, almacenado) {
  const [salt, hash] = almacenado.split(':');
  const hashIntento = crypto.scryptSync(password, salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(hashIntento, 'hex'));
}

async function asegurarUsuarioAdmin() {
  const { c } = await db.prepare('SELECT COUNT(*) c FROM usuarios').get();
  if (Number(c) > 0) return;

  const PASSWORD_INICIAL = 'admin123';
  const admin = await db.prepare(
    'INSERT INTO usuarios (usuario, password_hash, es_admin) VALUES (?, ?, 1)'
  ).run('admin', hashPassword(PASSWORD_INICIAL));

  for (const modulo of MODULOS) {
    await db.prepare(
      'INSERT INTO permisos (usuario_id, modulo, puede_ver, puede_editar, puede_borrar) VALUES (?, ?, 1, 1, 1)'
    ).run(admin.lastInsertRowid, modulo);
  }

  console.log('----------------------------------------------------------');
  console.log('Usuario administrador creado. usuario: admin / password: admin123');
  console.log('Cambia esta contraseña desde Usuarios en cuanto inicies sesion.');
  console.log('----------------------------------------------------------');
}
asegurarUsuarioAdmin().catch((e) => console.error('No se pudo verificar/crear el usuario administrador:', e));

const app = express();
app.set('trust proxy', 1);

const PgSession = pgSessionFabrica(session);
// Sin maxAge, la cookie es "de sesion": el navegador la borra al cerrarse por completo, asi
// que volver a abrirlo siempre pide usuario y contrasena. El limite de 75 min de inactividad
// con el navegador abierto lo sigue manejando el cierre de sesion automatico en el cliente.
app.use(session({
  store: new PgSession({ pool, tableName: 'session', ttl: 60 * 60 * 24 }),
  secret: process.env.SESSION_SECRET || 'crm-on-secreto-de-desarrollo-cambia-esto',
  resave: false,
  saveUninitialized: false,
  cookie: {
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
  },
}));
app.use(express.json());
app.use(express.text({ type: 'text/csv', limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Envuelve un route handler asincrono para que sus errores lleguen al middleware de errores
// de Express en vez de quedar como una promesa rechazada sin manejar.
const ar = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

function requireAuth(req, res, next) {
  if (!req.session.usuarioId) return res.status(401).json({ error: 'No autenticado' });
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.usuarioId) return res.status(401).json({ error: 'No autenticado' });
  if (!req.session.esAdmin) return res.status(403).json({ error: 'Requiere permisos de administrador' });
  next();
}

function requirePermiso(modulo, accion) {
  const columna = { ver: 'puede_ver', editar: 'puede_editar', borrar: 'puede_borrar' }[accion];
  return ar(async (req, res, next) => {
    if (!req.session.usuarioId) return res.status(401).json({ error: 'No autenticado' });
    if (req.session.esAdmin) return next();

    const permiso = await db.prepare(
      `SELECT ${columna} AS permitido FROM permisos WHERE usuario_id = ? AND modulo = ?`
    ).get(req.session.usuarioId, modulo);

    if (!permiso || !permiso.permitido) {
      return res.status(403).json({ error: 'No tienes permiso para esta accion' });
    }
    next();
  });
}

async function permisosDe(usuarioId, esAdmin) {
  if (esAdmin) {
    return Object.fromEntries(MODULOS.map((m) => [m, { ver: true, editar: true, borrar: true }]));
  }
  const filas = await db.prepare('SELECT * FROM permisos WHERE usuario_id = ?').all(usuarioId);
  return Object.fromEntries(MODULOS.map((m) => {
    const fila = filas.find((f) => f.modulo === m);
    return [m, {
      ver: Boolean(fila?.puede_ver),
      editar: Boolean(fila?.puede_editar),
      borrar: Boolean(fila?.puede_borrar),
    }];
  }));
}

async function guardarPermisos(usuarioId, permisos) {
  for (const modulo of MODULOS) {
    const p = (permisos && permisos[modulo]) || {};
    await db.prepare(`
      INSERT INTO permisos (usuario_id, modulo, puede_ver, puede_editar, puede_borrar)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(usuario_id, modulo) DO UPDATE SET
        puede_ver = excluded.puede_ver, puede_editar = excluded.puede_editar, puede_borrar = excluded.puede_borrar
    `).run(usuarioId, modulo, p.ver ? 1 : 0, p.editar ? 1 : 0, p.borrar ? 1 : 0);
  }
}

// ---------- Alcance por usuario (Cotizador privado) ----------
// Contactos, Destinos, Negocios y Cotizaciones son privados: cada usuario ve/edita solo lo
// que el mismo creo. Un administrador (es_admin) ve y puede editar todo, sin restriccion.
// Productos/Categorias/Lineas/Marcas/Etapas/Actividades/Ordenes siguen siendo compartidos.
function esDueno(fila, req) {
  return Boolean(req.session.esAdmin) || fila.usuario_id === req.session.usuarioId;
}

// Verifica que un id referenciado (contacto_id, destino_id, negocio_id) pertenezca al usuario
// en sesion (o exista libremente si es admin). id null/undefined siempre se permite.
async function referenciaPropia(tabla, columnaId, id, req) {
  if (!id) return true;
  if (req.session.esAdmin) return true;
  const fila = await db.prepare(`SELECT usuario_id FROM ${tabla} WHERE ${columnaId} = ?`).get(id);
  return Boolean(fila) && fila.usuario_id === req.session.usuarioId;
}

// ---------- Autenticacion ----------

// Bloqueo temporal por intentos fallidos de login (por nombre de usuario). En memoria: en
// un despliegue serverless (varias instancias/invocaciones) no es un conteo perfectamente
// centralizado, pero sigue sirviendo como freno basico contra fuerza bruta.
const intentosLogin = new Map();
const MAX_INTENTOS_LOGIN = 5;
const BLOQUEO_LOGIN_MS = 60 * 60 * 1000; // 60 minutos

app.post('/api/login', ar(async (req, res) => {
  const { usuario, password } = req.body;
  if (!usuario || !password) return res.status(400).json({ error: 'Usuario y password son requeridos' });

  const nombreUsuario = usuario.trim();
  let estado = intentosLogin.get(nombreUsuario);

  if (estado && estado.bloqueadoHasta) {
    if (estado.bloqueadoHasta > Date.now()) {
      const minutos = Math.ceil((estado.bloqueadoHasta - Date.now()) / 60000);
      return res.status(429).json({ error: `Demasiados intentos fallidos. Intenta de nuevo en ${minutos} minuto(s).` });
    }
    intentosLogin.delete(nombreUsuario);
    estado = undefined;
  }

  const u = await db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(nombreUsuario);
  if (!u || !verificarPassword(password, u.password_hash)) {
    const intentos = (estado ? estado.intentos : 0) + 1;
    if (intentos >= MAX_INTENTOS_LOGIN) {
      intentosLogin.set(nombreUsuario, { intentos, bloqueadoHasta: Date.now() + BLOQUEO_LOGIN_MS });
      return res.status(429).json({ error: 'Demasiados intentos fallidos. Intenta de nuevo en 60 minutos.' });
    }
    intentosLogin.set(nombreUsuario, { intentos, bloqueadoHasta: null });
    return res.status(401).json({ error: 'Usuario o password incorrectos' });
  }

  intentosLogin.delete(nombreUsuario);
  req.session.usuarioId = u.id_usuario;
  req.session.usuario = u.usuario;
  req.session.esAdmin = Boolean(u.es_admin);

  res.json({ id_usuario: u.id_usuario, usuario: u.usuario, esAdmin: Boolean(u.es_admin) });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.status(204).end());
});

app.get('/api/me', ar(async (req, res) => {
  if (!req.session.usuarioId) return res.status(401).json({ error: 'No autenticado' });
  res.json({
    id_usuario: req.session.usuarioId,
    usuario: req.session.usuario,
    esAdmin: req.session.esAdmin,
    permisos: await permisosDe(req.session.usuarioId, req.session.esAdmin),
  });
}));

// ---------- Almacenamiento de la base de datos (solo admin) ----------

// Limite de "database size" del plan Free de Supabase: al superarlo el proyecto entra
// en modo de solo lectura. Si el proyecto cambia de plan, actualizar este valor.
const LIMITE_BYTES_ALMACENAMIENTO_BD = 500 * 1024 * 1024;

app.get('/api/sistema/almacenamiento', requireAdmin, ar(async (req, res) => {
  const fila = await db.prepare('SELECT sum(pg_database_size(datname))::bigint AS bytes FROM pg_database').get();
  res.json({
    bytesUsados: Number(fila.bytes || 0),
    bytesLimite: LIMITE_BYTES_ALMACENAMIENTO_BD,
    plan: 'Free',
  });
}));

// ---------- Administracion de usuarios (solo admin) ----------

app.get('/api/usuarios', requireAdmin, ar(async (req, res) => {
  const usuarios = await db.prepare('SELECT id_usuario, usuario, es_admin, creado_en FROM usuarios ORDER BY usuario').all();
  res.json(await Promise.all(usuarios.map(async (u) => ({
    ...u,
    es_admin: Boolean(u.es_admin),
    permisos: await permisosDe(u.id_usuario, u.es_admin),
  }))));
}));

app.post('/api/usuarios', requireAdmin, ar(async (req, res) => {
  const { usuario, password, esAdmin, permisos } = req.body;
  const nombreUsuario = quitarAcentos((usuario || '').trim());
  if (!nombreUsuario) return res.status(400).json({ errores: ['usuario es requerido'] });
  if (!password || password.length < 4) {
    return res.status(400).json({ errores: ['password debe tener al menos 4 caracteres'] });
  }

  let info;
  try {
    info = await db.prepare('INSERT INTO usuarios (usuario, password_hash, es_admin) VALUES (?, ?, ?)')
      .run(nombreUsuario, hashPassword(password), esAdmin ? 1 : 0);
  } catch (e) {
    return res.status(400).json({ errores: ['Ese usuario ya existe'] });
  }

  await guardarPermisos(info.lastInsertRowid, permisos);
  res.status(201).json({ id_usuario: info.lastInsertRowid, usuario: nombreUsuario });
}));

app.put('/api/usuarios/:id', requireAdmin, ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM usuarios WHERE id_usuario = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Usuario no encontrado' });

  const { password, esAdmin, permisos } = req.body;

  if (password) {
    if (password.length < 4) return res.status(400).json({ errores: ['password debe tener al menos 4 caracteres'] });
    await db.prepare('UPDATE usuarios SET password_hash = ? WHERE id_usuario = ?').run(hashPassword(password), req.params.id);
  }
  if (esAdmin !== undefined) {
    await db.prepare('UPDATE usuarios SET es_admin = ? WHERE id_usuario = ?').run(esAdmin ? 1 : 0, req.params.id);
  }
  if (permisos !== undefined) {
    await guardarPermisos(req.params.id, permisos);
  }

  res.status(204).end();
}));

app.delete('/api/usuarios/:id', requireAdmin, ar(async (req, res) => {
  if (Number(req.params.id) === req.session.usuarioId) {
    return res.status(400).json({ error: 'No puedes borrar tu propio usuario' });
  }
  const info = await db.prepare('DELETE FROM usuarios WHERE id_usuario = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
  res.status(204).end();
}));

// ---------- Representantes (Cotizaciones) ----------
// Alta/edicion/borrado solo para administradores; la lista (GET) es visible para cualquier
// usuario con acceso a catalogos, ya que se usa para elegir el Representante en Cotizaciones.

app.get('/api/representantes', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM representantes ORDER BY representante').all());
}));

app.post('/api/representantes', requireAdmin, ar(async (req, res) => {
  const representante = quitarAcentos((req.body.representante || '').trim());
  if (!representante) return res.status(400).json({ errores: ['representante es requerido'] });

  // La firma es texto libre para el pie de las cotizaciones (nombre, puesto, contacto,
  // empresa, direccion en las lineas que el representante decida): no se le quitan acentos,
  // a diferencia del resto de los catalogos, porque va impresa tal cual en un documento oficial.
  const info = await db.prepare(`
    INSERT INTO representantes (representante, correo_electronico, celular, firma) VALUES (?, ?, ?, ?)
  `).run(
    representante,
    (req.body.correo_electronico || '').trim() || null,
    (req.body.celular || '').trim() || null,
    (req.body.firma || '').trim() || null
  );
  res.status(201).json(await db.prepare('SELECT * FROM representantes WHERE id_representante = ?').get(info.lastInsertRowid));
}));

app.put('/api/representantes/:id', requireAdmin, ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM representantes WHERE id_representante = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Representante no encontrado' });

  const representante = quitarAcentos((req.body.representante || '').trim());
  if (!representante) return res.status(400).json({ errores: ['representante es requerido'] });

  await db.prepare(`
    UPDATE representantes SET representante = ?, correo_electronico = ?, celular = ?, firma = ? WHERE id_representante = ?
  `).run(
    representante,
    (req.body.correo_electronico || '').trim() || null,
    (req.body.celular || '').trim() || null,
    (req.body.firma || '').trim() || null,
    req.params.id
  );
  res.json(await db.prepare('SELECT * FROM representantes WHERE id_representante = ?').get(req.params.id));
}));

app.delete('/api/representantes/:id', requireAdmin, ar(async (req, res) => {
  const info = await db.prepare('DELETE FROM representantes WHERE id_representante = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Representante no encontrado' });
  res.status(204).end();
}));

function numeroOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  return Number.isNaN(n) ? undefined : n;
}

function enteroOpcional(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const n = Number(valor);
  return Number.isInteger(n) ? n : undefined;
}

function textoOpcional(valor, maxLen) {
  if (valor === undefined || valor === null) return null;
  const limpio = String(valor).trim();
  if (limpio === '') return null;
  return limpio.length <= maxLen ? limpio : undefined;
}

const MAPA_ACENTOS = {
  á: 'a', é: 'e', í: 'i', ó: 'o', ú: 'u', ü: 'u',
  Á: 'A', É: 'E', Í: 'I', Ó: 'O', Ú: 'U', Ü: 'U',
};

// Quita acentos de las vocales (deja la vocal simple); no toca otras letras (ej. la ñ).
function quitarAcentos(valor) {
  if (typeof valor !== 'string') return valor;
  return valor.replace(/[áéíóúüÁÉÍÓÚÜ]/g, (c) => MAPA_ACENTOS[c]);
}

// Cuenta cuantas ordenes usan un valor de catalogo, para bloquear el borrado con un
// mensaje claro en vez de dejar que falle en silencio por la restriccion de llave foranea.
async function contarOrdenesQueUsan(columna, id) {
  const fila = await db.prepare(`SELECT COUNT(*) c FROM ordenes WHERE ${columna} = ?`).get(id);
  return Number(fila.c);
}

async function contarProductosQueUsan(columna, id) {
  const fila = await db.prepare(`SELECT COUNT(*) c FROM productos WHERE ${columna} = ?`).get(id);
  return Number(fila.c);
}

async function contarNegociosQueUsan(columna, id) {
  const fila = await db.prepare(`SELECT COUNT(*) c FROM negocios WHERE ${columna} = ?`).get(id);
  return Number(fila.c);
}

// Genera un ID unico de 12 digitos (numerico, aleatorio, no incremental) para Negocios.
async function generarIdNegocio() {
  let id;
  do {
    id = Array.from({ length: 12 }, () => crypto.randomInt(0, 10)).join('');
  } while (await db.prepare('SELECT 1 FROM negocios WHERE id_negocio = ?').get(id));
  return id;
}

// Genera un ID unico de 12 digitos (numerico, aleatorio, no incremental) para Contactos.
// Es un campo adicional solo para identificar/mostrar al contacto: no reemplaza id_contacto,
// la llave interna que ya usan Negocios/Cotizaciones/Ordenes.
async function generarIdContacto() {
  let id;
  do {
    id = Array.from({ length: 12 }, () => crypto.randomInt(0, 10)).join('');
  } while (await db.prepare('SELECT 1 FROM contactos WHERE id_publico = ?').get(id));
  return id;
}

// Genera un ID unico de 6 digitos (numerico, aleatorio, no incremental) para Pendientes (Tareas).
async function generarIdPendiente() {
  let id;
  do {
    id = Array.from({ length: 6 }, () => crypto.randomInt(0, 10)).join('');
  } while (await db.prepare('SELECT 1 FROM pendientes WHERE id_pendiente = ?').get(id));
  return id;
}

// Genera un ID unico "COT-" + 12 digitos aleatorios para Cotizaciones.
async function generarIdCotizacion() {
  let id;
  do {
    id = 'COT-' + Array.from({ length: 12 }, () => crypto.randomInt(0, 10)).join('');
  } while (await db.prepare('SELECT 1 FROM cotizaciones WHERE id_cotizacion = ?').get(id));
  return id;
}

// Calculos de una cotizacion a partir de sus partidas:
// Total (por fila) = Cantidad * Precio Unitario
// Sub Total = suma de los totales de fila
// Descuento (monto) = Sub Total * (% Descuento / 100)
// IVA = (Sub Total - Descuento) * 0.16
// Gran Total = (Sub Total - Descuento) + IVA
function calcularTotalesCotizacion(items, descuentoPorcentaje) {
  const subtotal = items.reduce((acc, it) => acc + Number(it.cantidad) * Number(it.precio_unitario), 0);
  const porcentaje = Number(descuentoPorcentaje) || 0;
  const descuentoMonto = subtotal * (porcentaje / 100);
  const base = subtotal - descuentoMonto;
  const iva = base * 0.16;
  const granTotal = base + iva;
  return { subtotal, descuentoMonto, iva, granTotal };
}

// Genera el siguiente ID con prefijo (Cat-00001, Lin-00001, M-00001), buscando el
// numero mas alto ya usado en la tabla y sumando 1 (no se guarda un contador aparte).
async function generarSiguienteIdConPrefijo(tabla, columnaId, prefijo) {
  const filas = await db.prepare(`SELECT ${columnaId} AS id FROM ${tabla}`).all();
  let maxNumero = 0;
  const patron = new RegExp(`^${prefijo}(\\d+)$`);
  for (const fila of filas) {
    const coincide = patron.exec(fila.id);
    if (coincide) maxNumero = Math.max(maxNumero, parseInt(coincide[1], 10));
  }
  return `${prefijo}${String(maxNumero + 1).padStart(5, '0')}`;
}

// Normaliza texto para comparar duplicados "casi iguales": sin acentos, minusculas,
// espacios repetidos colapsados y sin espacios al inicio/final.
function normalizarParaComparar(valor) {
  return quitarAcentos(String(valor || '').trim().toLowerCase()).replace(/\s+/g, ' ');
}

// Normaliza fechas a formato ISO (AAAA-MM-DD). Acepta DD/MM/AA o DD/MM/AAAA de entrada.
function normalizarFecha(valor) {
  if (typeof valor !== 'string') return valor;
  const texto = valor.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(texto)) return texto;

  const m = texto.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return texto;

  const dia = m[1].padStart(2, '0');
  const mes = m[2].padStart(2, '0');
  let anio = m[3];
  if (anio.length === 2) anio = (Number(anio) <= 69 ? '20' : '19') + anio;

  return `${anio}-${mes}-${dia}`;
}

// Parser CSV simple: soporta campos entre comillas con comas y comillas escapadas ("").
function parsearCSV(texto) {
  const filas = [];
  let fila = [];
  let campo = '';
  let dentroComillas = false;

  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];

    if (dentroComillas) {
      if (c === '"') {
        if (texto[i + 1] === '"') {
          campo += '"';
          i++;
        } else {
          dentroComillas = false;
        }
      } else {
        campo += c;
      }
      continue;
    }

    if (c === '"') {
      dentroComillas = true;
    } else if (c === ',') {
      fila.push(campo);
      campo = '';
    } else if (c === '\r') {
      // ignorar, \n maneja el salto de linea
    } else if (c === '\n') {
      fila.push(campo);
      filas.push(fila);
      fila = [];
      campo = '';
    } else {
      campo += c;
    }
  }

  if (campo !== '' || fila.length) {
    fila.push(campo);
    filas.push(fila);
  }

  return filas.filter((f) => !(f.length === 1 && f[0].trim() === ''));
}

function filasCsvAObjetos(filas) {
  if (!filas.length) return [];
  const encabezados = filas[0].map((h) => h.trim().toLowerCase());
  return filas.slice(1).map((fila) => {
    const obj = {};
    encabezados.forEach((h, idx) => {
      const valor = fila[idx] !== undefined ? fila[idx].trim() : '';
      obj[h] = quitarAcentos(valor);
    });
    return obj;
  });
}

// ---------- Destinos ----------
// Las empresas son un catalogo independiente (tabla empresas); destino_empresas
// solo guarda la relacion destino_id <-> empresa_id (3 tablas: Destinos, Empresas, Destino_Empresas).

async function obtenerOCrearEmpresa(nombre, fuente = db) {
  const limpio = quitarAcentos(String(nombre || '').trim());
  if (!limpio) return null;
  const existente = await fuente.prepare('SELECT id_empresa FROM empresas WHERE empresa = ?').get(limpio);
  if (existente) return existente.id_empresa;
  return (await fuente.prepare('INSERT INTO empresas (empresa) VALUES (?)').run(limpio)).lastInsertRowid;
}

async function empresasDeDestino(destinoId) {
  const filas = await db.prepare(`
    SELECT e.empresa FROM destino_empresas de
    JOIN empresas e ON e.id_empresa = de.empresa_id
    WHERE de.destino_id = ?
    ORDER BY de.id
  `).all(destinoId);
  return filas.map((r) => r.empresa);
}

async function destinoConEmpresas(id) {
  const d = await db.prepare('SELECT * FROM destinos WHERE id_destino = ?').get(id);
  if (!d) return null;
  const [empresas, grupos, cadenas] = await Promise.all([
    empresasDeDestino(id),
    gruposDeDestino(id),
    cadenasDeDestino(id),
  ]);
  return { ...d, empresas, grupos, cadenas };
}

// Version en lote de empresasDeDestino: una sola consulta para todos los destinos en vez de
// una por destino (evita N+1 viajes de red a la base de datos al listar).
async function empresasDeDestinosBatch(destinoIds) {
  const mapa = new Map();
  if (!destinoIds.length) return mapa;
  const filas = await db.prepare(`
    SELECT de.destino_id, e.empresa FROM destino_empresas de
    JOIN empresas e ON e.id_empresa = de.empresa_id
    WHERE de.destino_id = ANY(?)
    ORDER BY de.id
  `).all(destinoIds);
  for (const f of filas) {
    if (!mapa.has(f.destino_id)) mapa.set(f.destino_id, []);
    mapa.get(f.destino_id).push(f.empresa);
  }
  return mapa;
}

// Cuenta, para cada destino (hotel/local), cuantas cotizaciones/ordenes tiene y cuantas tareas
// estan asociadas (via la orden del destino; los negocios no referencian destino_id, asi que
// para destinos las tareas solo se derivan por ese camino, a diferencia de los contactos).
async function conteosAsociadosDestinosBatch(destinoIds) {
  const vacio = new Map();
  if (!destinoIds.length) return { cotizaciones: vacio, ordenes: vacio, tareas: vacio };

  const [cotizaciones, ordenes, tareas] = await Promise.all([
    db.prepare('SELECT destino_id, COUNT(*) c FROM cotizaciones WHERE destino_id = ANY(?) GROUP BY destino_id').all(destinoIds),
    db.prepare('SELECT destino_id, COUNT(*) c FROM ordenes WHERE destino_id = ANY(?) GROUP BY destino_id').all(destinoIds),
    db.prepare(`
      SELECT o.destino_id, COUNT(*) c FROM pendientes p
      JOIN ordenes o ON o.id = p.orden_id
      WHERE o.destino_id = ANY(?)
      GROUP BY o.destino_id
    `).all(destinoIds),
  ]);

  const aMapa = (filas) => new Map(filas.map((f) => [f.destino_id, Number(f.c)]));
  return { cotizaciones: aMapa(cotizaciones), ordenes: aMapa(ordenes), tareas: aMapa(tareas) };
}

async function reemplazarEmpresasDestino(destinoId, empresas) {
  await db.prepare('DELETE FROM destino_empresas WHERE destino_id = ?').run(destinoId);
  for (const empresa of empresas || []) {
    const empresaId = await obtenerOCrearEmpresa(empresa);
    if (empresaId) {
      await db.prepare('INSERT INTO destino_empresas (destino_id, empresa_id) VALUES (?, ?) ON CONFLICT (destino_id, empresa_id) DO NOTHING').run(destinoId, empresaId);
    }
  }
}

// Grupo y Cadena son catalogos independientes adicionales al de Plaza (tabla empresas), con el
// mismo patron de 3 tablas cada uno: Grupos/Destino_Grupos y Cadenas/Destino_Cadenas.
async function obtenerOCrearGrupo(nombre, fuente = db) {
  const limpio = quitarAcentos(String(nombre || '').trim());
  if (!limpio) return null;
  const existente = await fuente.prepare('SELECT id_grupo FROM grupos WHERE grupo = ?').get(limpio);
  if (existente) return existente.id_grupo;
  return (await fuente.prepare('INSERT INTO grupos (grupo) VALUES (?)').run(limpio)).lastInsertRowid;
}

async function gruposDeDestino(destinoId) {
  const filas = await db.prepare(`
    SELECT g.grupo FROM destino_grupos dg
    JOIN grupos g ON g.id_grupo = dg.grupo_id
    WHERE dg.destino_id = ?
    ORDER BY dg.id
  `).all(destinoId);
  return filas.map((r) => r.grupo);
}

async function gruposDeDestinosBatch(destinoIds) {
  const mapa = new Map();
  if (!destinoIds.length) return mapa;
  const filas = await db.prepare(`
    SELECT dg.destino_id, g.grupo FROM destino_grupos dg
    JOIN grupos g ON g.id_grupo = dg.grupo_id
    WHERE dg.destino_id = ANY(?)
    ORDER BY dg.id
  `).all(destinoIds);
  for (const f of filas) {
    if (!mapa.has(f.destino_id)) mapa.set(f.destino_id, []);
    mapa.get(f.destino_id).push(f.grupo);
  }
  return mapa;
}

async function reemplazarGruposDestino(destinoId, grupos) {
  await db.prepare('DELETE FROM destino_grupos WHERE destino_id = ?').run(destinoId);
  for (const grupo of grupos || []) {
    const grupoId = await obtenerOCrearGrupo(grupo);
    if (grupoId) {
      await db.prepare('INSERT INTO destino_grupos (destino_id, grupo_id) VALUES (?, ?) ON CONFLICT (destino_id, grupo_id) DO NOTHING').run(destinoId, grupoId);
    }
  }
}

async function obtenerOCrearCadena(nombre, fuente = db) {
  const limpio = quitarAcentos(String(nombre || '').trim());
  if (!limpio) return null;
  const existente = await fuente.prepare('SELECT id_cadena FROM cadenas WHERE cadena = ?').get(limpio);
  if (existente) return existente.id_cadena;
  return (await fuente.prepare('INSERT INTO cadenas (cadena) VALUES (?)').run(limpio)).lastInsertRowid;
}

async function cadenasDeDestino(destinoId) {
  const filas = await db.prepare(`
    SELECT c.cadena FROM destino_cadenas dc
    JOIN cadenas c ON c.id_cadena = dc.cadena_id
    WHERE dc.destino_id = ?
    ORDER BY dc.id
  `).all(destinoId);
  return filas.map((r) => r.cadena);
}

async function cadenasDeDestinosBatch(destinoIds) {
  const mapa = new Map();
  if (!destinoIds.length) return mapa;
  const filas = await db.prepare(`
    SELECT dc.destino_id, c.cadena FROM destino_cadenas dc
    JOIN cadenas c ON c.id_cadena = dc.cadena_id
    WHERE dc.destino_id = ANY(?)
    ORDER BY dc.id
  `).all(destinoIds);
  for (const f of filas) {
    if (!mapa.has(f.destino_id)) mapa.set(f.destino_id, []);
    mapa.get(f.destino_id).push(f.cadena);
  }
  return mapa;
}

async function reemplazarCadenasDestino(destinoId, cadenas) {
  await db.prepare('DELETE FROM destino_cadenas WHERE destino_id = ?').run(destinoId);
  for (const cadena of cadenas || []) {
    const cadenaId = await obtenerOCrearCadena(cadena);
    if (cadenaId) {
      await db.prepare('INSERT INTO destino_cadenas (destino_id, cadena_id) VALUES (?, ?) ON CONFLICT (destino_id, cadena_id) DO NOTHING').run(destinoId, cadenaId);
    }
  }
}

app.get('/api/destinos', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const destinos = req.session.esAdmin
    ? await db.prepare('SELECT * FROM destinos ORDER BY destino').all()
    : await db.prepare('SELECT * FROM destinos WHERE usuario_id = ? ORDER BY destino').all(req.session.usuarioId);
  const destinoIds = destinos.map((d) => d.id_destino);
  const [empresasPorDestino, gruposPorDestino, cadenasPorDestino, conteos] = await Promise.all([
    empresasDeDestinosBatch(destinoIds),
    gruposDeDestinosBatch(destinoIds),
    cadenasDeDestinosBatch(destinoIds),
    conteosAsociadosDestinosBatch(destinoIds),
  ]);
  res.json(destinos.map((d) => ({
    ...d,
    empresas: empresasPorDestino.get(d.id_destino) || [],
    grupos: gruposPorDestino.get(d.id_destino) || [],
    cadenas: cadenasPorDestino.get(d.id_destino) || [],
    cotizaciones_count: conteos.cotizaciones.get(d.id_destino) || 0,
    ordenes_count: conteos.ordenes.get(d.id_destino) || 0,
    tareas_count: conteos.tareas.get(d.id_destino) || 0,
  })));
}));

// Un solo destino con sus conteos de asociados, para la pantalla de detalle (destino-detalle.html).
app.get('/api/destinos/:id', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const destino = await destinoConEmpresas(req.params.id);
  if (!destino || !esDueno(destino, req)) return res.status(404).json({ error: 'Hotel/local no encontrado' });
  const conteos = await conteosAsociadosDestinosBatch([destino.id_destino]);
  res.json({
    ...destino,
    cotizaciones_count: conteos.cotizaciones.get(destino.id_destino) || 0,
    ordenes_count: conteos.ordenes.get(destino.id_destino) || 0,
    tareas_count: conteos.tareas.get(destino.id_destino) || 0,
  });
}));

// Cotizaciones, ordenes, tareas y contactos asociados a un destino (hotel/local), para el
// detalle desde el catalogo de Hoteles/Locales. Igual que en Contactos, las tareas se derivan
// via la orden (los negocios no referencian destino_id).
app.get('/api/destinos/:id/asociados', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const destino = await db.prepare('SELECT * FROM destinos WHERE id_destino = ?').get(req.params.id);
  if (!destino || !esDueno(destino, req)) return res.status(404).json({ error: 'Hotel/local no encontrado' });

  const [cotizaciones, ordenes, tareas, contactos] = await Promise.all([
    db.prepare(`${SELECT_COTIZACIONES} WHERE q.destino_id = ? ORDER BY q.creado_en DESC`).all(req.params.id),
    db.prepare(`${SELECT_ORDENES} WHERE o.destino_id = ? ORDER BY o.creado_en DESC`).all(req.params.id),
    db.prepare(`
      SELECT DISTINCT p.* FROM pendientes p
      LEFT JOIN ordenes o ON o.id = p.orden_id
      WHERE o.destino_id = ? OR p.destino_id = ?
      ORDER BY p.creado_en DESC
    `).all(req.params.id, req.params.id),
    db.prepare(`
      SELECT c.id_contacto, c.nombre, c.apellido, c.correo_electronico FROM contacto_destinos cd
      JOIN contactos c ON c.id_contacto = cd.contacto_id
      WHERE cd.destino_id = ?
      ORDER BY c.nombre, c.apellido
    `).all(req.params.id),
  ]);

  const actividadesPorTarea = await actividadesDePendientesBatch(tareas.map((t) => t.id_pendiente));
  const tareasConActividades = tareas.map((t) => ({ ...t, actividades: actividadesPorTarea.get(t.id_pendiente) || [] }));

  res.json({ cotizaciones: cotizaciones.map(conEstatus), ordenes, tareas: tareasConActividades, contactos });
}));

// Asocia/desasocia un contacto existente a este destino, desde la pantalla de detalle del
// Hotel/Local (el mismo par contacto_destinos que se administra desde el lado de Contactos).
app.post('/api/destinos/:id/contactos', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const destino = await db.prepare('SELECT * FROM destinos WHERE id_destino = ?').get(req.params.id);
  if (!destino || !esDueno(destino, req)) return res.status(404).json({ error: 'Hotel/local no encontrado' });
  if (!(await referenciaPropia('contactos', 'id_contacto', req.body.contacto_id, req)) || !req.body.contacto_id) {
    return res.status(400).json({ errores: ['El contacto seleccionado no existe'] });
  }
  await db.prepare('INSERT INTO contacto_destinos (contacto_id, destino_id) VALUES (?, ?) ON CONFLICT (contacto_id, destino_id) DO NOTHING')
    .run(req.body.contacto_id, req.params.id);
  res.status(201).json({ ok: true });
}));

app.delete('/api/destinos/:id/contactos/:contactoId', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const destino = await db.prepare('SELECT * FROM destinos WHERE id_destino = ?').get(req.params.id);
  if (!destino || !esDueno(destino, req)) return res.status(404).json({ error: 'Hotel/local no encontrado' });
  await db.prepare('DELETE FROM contacto_destinos WHERE destino_id = ? AND contacto_id = ?').run(req.params.id, req.params.contactoId);
  res.status(204).end();
}));

// Catalogos independientes de Plaza (tabla empresas), Grupo y Cadena: se administran tanto desde
// su propia pantalla de catalogo (alta/edicion/borrado) como escribiendo nombres nuevos en el
// formulario de Destino (o con el "+" de alta rapida), que los crea/enlaza automaticamente.
// Cada uno tiene ademas su propia pantalla de detalle (plaza/grupo/cadena-detalle.html) con los
// hoteles/locales asociados y el acumulado de Cotizaciones/Ordenes/Tareas de todos ellos.
async function asociadosDeGrupoCatalogo(tablaJoin, columnaId, id) {
  const enGrupo = `SELECT destino_id FROM ${tablaJoin} WHERE ${columnaId} = ?`;
  const [destinos, cotizaciones, ordenes, tareas] = await Promise.all([
    db.prepare(`SELECT id_destino, destino FROM destinos WHERE id_destino IN (${enGrupo}) ORDER BY destino`).all(id),
    db.prepare(`${SELECT_COTIZACIONES} WHERE q.destino_id IN (${enGrupo}) ORDER BY q.creado_en DESC`).all(id),
    db.prepare(`${SELECT_ORDENES} WHERE o.destino_id IN (${enGrupo}) ORDER BY o.creado_en DESC`).all(id),
    db.prepare(`
      SELECT DISTINCT p.* FROM pendientes p
      JOIN ordenes o ON o.id = p.orden_id
      WHERE o.destino_id IN (${enGrupo})
      ORDER BY p.creado_en DESC
    `).all(id),
  ]);
  return { destinos, cotizaciones: cotizaciones.map(conEstatus), ordenes, tareas };
}

app.get('/api/empresas', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const empresas = await db.prepare(`
    SELECT e.id_empresa, e.empresa, COUNT(de.id) AS destinos_asociados
    FROM empresas e
    LEFT JOIN destino_empresas de ON de.empresa_id = e.id_empresa
    GROUP BY e.id_empresa
    ORDER BY e.empresa
  `).all();
  res.json(empresas);
}));

app.post('/api/empresas', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const empresa = quitarAcentos((req.body.empresa || '').trim());
  if (!empresa) return res.status(400).json({ errores: ['empresa (plaza) es requerida'] });
  try {
    const info = await db.prepare('INSERT INTO empresas (empresa) VALUES (?)').run(empresa);
    res.status(201).json({ id_empresa: info.lastInsertRowid, empresa, destinos_asociados: 0 });
  } catch (e) {
    res.status(400).json({ errores: ['Esa plaza ya existe'] });
  }
}));

app.put('/api/empresas/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const empresa = quitarAcentos((req.body.empresa || '').trim());
  if (!empresa) return res.status(400).json({ errores: ['empresa (plaza) es requerida'] });
  try {
    const info = await db.prepare('UPDATE empresas SET empresa = ? WHERE id_empresa = ?').run(empresa, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Plaza no encontrada' });
    res.json({ id_empresa: Number(req.params.id), empresa });
  } catch (e) {
    res.status(400).json({ errores: ['Esa plaza ya existe'] });
  }
}));

app.delete('/api/empresas/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await db.prepare('SELECT COUNT(*) c FROM destino_empresas WHERE empresa_id = ?').get(req.params.id);
  if (Number(enUso.c) > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso.c} hotel(es)/local(es) usan esta plaza.`] });
  }
  const info = await db.prepare('DELETE FROM empresas WHERE id_empresa = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Plaza no encontrada' });
  res.status(204).end();
}));

app.get('/api/empresas/:id', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const plaza = await db.prepare('SELECT * FROM empresas WHERE id_empresa = ?').get(req.params.id);
  if (!plaza) return res.status(404).json({ error: 'Plaza no encontrada' });
  res.json(plaza);
}));

// Hoteles/locales asociados a esta plaza, y el acumulado de Cotizaciones/Ordenes/Tareas de todos
// ellos, para la pantalla de detalle (plaza-detalle.html).
app.get('/api/empresas/:id/asociados', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await asociadosDeGrupoCatalogo('destino_empresas', 'empresa_id', req.params.id));
}));

// Asociar/desasociar hoteles/locales desde el lado de la Plaza (para completar la asociacion
// sin tener que ir uno por uno al formulario de cada Destino).
app.get('/api/empresas/:id/destinos', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const destinos = await db.prepare(`
    SELECT d.id_destino, d.destino FROM destino_empresas de
    JOIN destinos d ON d.id_destino = de.destino_id
    WHERE de.empresa_id = ?
    ORDER BY d.destino
  `).all(req.params.id);
  res.json(destinos);
}));

app.post('/api/empresas/:id/destinos', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  if (!req.body.destino_id) return res.status(400).json({ errores: ['destino_id es requerido'] });
  await db.prepare('INSERT INTO destino_empresas (destino_id, empresa_id) VALUES (?, ?) ON CONFLICT (destino_id, empresa_id) DO NOTHING')
    .run(req.body.destino_id, req.params.id);
  res.status(201).json({ ok: true });
}));

app.delete('/api/empresas/:id/destinos/:destinoId', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  await db.prepare('DELETE FROM destino_empresas WHERE empresa_id = ? AND destino_id = ?').run(req.params.id, req.params.destinoId);
  res.status(204).end();
}));

app.get('/api/grupos', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const grupos = await db.prepare(`
    SELECT g.id_grupo, g.grupo, COUNT(dg.id) AS destinos_asociados
    FROM grupos g
    LEFT JOIN destino_grupos dg ON dg.grupo_id = g.id_grupo
    GROUP BY g.id_grupo
    ORDER BY g.grupo
  `).all();
  res.json(grupos);
}));

app.post('/api/grupos', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const grupo = quitarAcentos((req.body.grupo || '').trim());
  if (!grupo) return res.status(400).json({ errores: ['grupo es requerido'] });
  try {
    const info = await db.prepare('INSERT INTO grupos (grupo) VALUES (?)').run(grupo);
    res.status(201).json({ id_grupo: info.lastInsertRowid, grupo, destinos_asociados: 0 });
  } catch (e) {
    res.status(400).json({ errores: ['Ese grupo ya existe'] });
  }
}));

app.put('/api/grupos/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const grupo = quitarAcentos((req.body.grupo || '').trim());
  if (!grupo) return res.status(400).json({ errores: ['grupo es requerido'] });
  try {
    const info = await db.prepare('UPDATE grupos SET grupo = ? WHERE id_grupo = ?').run(grupo, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Grupo no encontrado' });
    res.json({ id_grupo: Number(req.params.id), grupo });
  } catch (e) {
    res.status(400).json({ errores: ['Ese grupo ya existe'] });
  }
}));

app.delete('/api/grupos/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await db.prepare('SELECT COUNT(*) c FROM destino_grupos WHERE grupo_id = ?').get(req.params.id);
  if (Number(enUso.c) > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso.c} hotel(es)/local(es) usan este grupo.`] });
  }
  const info = await db.prepare('DELETE FROM grupos WHERE id_grupo = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Grupo no encontrado' });
  res.status(204).end();
}));

app.get('/api/grupos/:id', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const grupo = await db.prepare('SELECT * FROM grupos WHERE id_grupo = ?').get(req.params.id);
  if (!grupo) return res.status(404).json({ error: 'Grupo no encontrado' });
  res.json(grupo);
}));

app.get('/api/grupos/:id/asociados', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await asociadosDeGrupoCatalogo('destino_grupos', 'grupo_id', req.params.id));
}));

// Asociar/desasociar hoteles/locales desde el lado del Grupo.
app.get('/api/grupos/:id/destinos', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const destinos = await db.prepare(`
    SELECT d.id_destino, d.destino FROM destino_grupos dg
    JOIN destinos d ON d.id_destino = dg.destino_id
    WHERE dg.grupo_id = ?
    ORDER BY d.destino
  `).all(req.params.id);
  res.json(destinos);
}));

app.post('/api/grupos/:id/destinos', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  if (!req.body.destino_id) return res.status(400).json({ errores: ['destino_id es requerido'] });
  await db.prepare('INSERT INTO destino_grupos (destino_id, grupo_id) VALUES (?, ?) ON CONFLICT (destino_id, grupo_id) DO NOTHING')
    .run(req.body.destino_id, req.params.id);
  res.status(201).json({ ok: true });
}));

app.delete('/api/grupos/:id/destinos/:destinoId', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  await db.prepare('DELETE FROM destino_grupos WHERE grupo_id = ? AND destino_id = ?').run(req.params.id, req.params.destinoId);
  res.status(204).end();
}));

app.get('/api/cadenas', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const cadenas = await db.prepare(`
    SELECT c.id_cadena, c.cadena, COUNT(dc.id) AS destinos_asociados
    FROM cadenas c
    LEFT JOIN destino_cadenas dc ON dc.cadena_id = c.id_cadena
    GROUP BY c.id_cadena
    ORDER BY c.cadena
  `).all();
  res.json(cadenas);
}));

app.post('/api/cadenas', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const cadena = quitarAcentos((req.body.cadena || '').trim());
  if (!cadena) return res.status(400).json({ errores: ['cadena es requerida'] });
  try {
    const info = await db.prepare('INSERT INTO cadenas (cadena) VALUES (?)').run(cadena);
    res.status(201).json({ id_cadena: info.lastInsertRowid, cadena, destinos_asociados: 0 });
  } catch (e) {
    res.status(400).json({ errores: ['Esa cadena ya existe'] });
  }
}));

app.put('/api/cadenas/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const cadena = quitarAcentos((req.body.cadena || '').trim());
  if (!cadena) return res.status(400).json({ errores: ['cadena es requerida'] });
  try {
    const info = await db.prepare('UPDATE cadenas SET cadena = ? WHERE id_cadena = ?').run(cadena, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Cadena no encontrada' });
    res.json({ id_cadena: Number(req.params.id), cadena });
  } catch (e) {
    res.status(400).json({ errores: ['Esa cadena ya existe'] });
  }
}));

app.delete('/api/cadenas/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await db.prepare('SELECT COUNT(*) c FROM destino_cadenas WHERE cadena_id = ?').get(req.params.id);
  if (Number(enUso.c) > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso.c} hotel(es)/local(es) usan esta cadena.`] });
  }
  const info = await db.prepare('DELETE FROM cadenas WHERE id_cadena = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Cadena no encontrada' });
  res.status(204).end();
}));

app.get('/api/cadenas/:id', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const cadena = await db.prepare('SELECT * FROM cadenas WHERE id_cadena = ?').get(req.params.id);
  if (!cadena) return res.status(404).json({ error: 'Cadena no encontrada' });
  res.json(cadena);
}));

app.get('/api/cadenas/:id/asociados', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await asociadosDeGrupoCatalogo('destino_cadenas', 'cadena_id', req.params.id));
}));

// Asociar/desasociar hoteles/locales desde el lado de la Cadena.
app.get('/api/cadenas/:id/destinos', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const destinos = await db.prepare(`
    SELECT d.id_destino, d.destino FROM destino_cadenas dc
    JOIN destinos d ON d.id_destino = dc.destino_id
    WHERE dc.cadena_id = ?
    ORDER BY d.destino
  `).all(req.params.id);
  res.json(destinos);
}));

app.post('/api/cadenas/:id/destinos', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  if (!req.body.destino_id) return res.status(400).json({ errores: ['destino_id es requerido'] });
  await db.prepare('INSERT INTO destino_cadenas (destino_id, cadena_id) VALUES (?, ?) ON CONFLICT (destino_id, cadena_id) DO NOTHING')
    .run(req.body.destino_id, req.params.id);
  res.status(201).json({ ok: true });
}));

app.delete('/api/cadenas/:id/destinos/:destinoId', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  await db.prepare('DELETE FROM destino_cadenas WHERE cadena_id = ? AND destino_id = ?').run(req.params.id, req.params.destinoId);
  res.status(204).end();
}));

app.post('/api/destinos', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const destino = quitarAcentos((req.body.destino || '').trim());
  if (!destino) return res.status(400).json({ errores: ['destino es requerido'] });

  try {
    const info = await db.prepare('INSERT INTO destinos (destino, usuario_id, ubicacion) VALUES (?, ?, ?)')
      .run(destino, req.session.usuarioId, quitarAcentos((req.body.ubicacion || '').trim()) || null);
    await reemplazarEmpresasDestino(info.lastInsertRowid, req.body.empresas);
    await reemplazarGruposDestino(info.lastInsertRowid, req.body.grupos);
    await reemplazarCadenasDestino(info.lastInsertRowid, req.body.cadenas);
    res.status(201).json(await destinoConEmpresas(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ errores: ['Ese hotel/local ya existe'] });
  }
}));

app.put('/api/destinos/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const destino = quitarAcentos((req.body.destino || '').trim());
  if (!destino) return res.status(400).json({ errores: ['destino es requerido'] });

  const existente = await db.prepare('SELECT * FROM destinos WHERE id_destino = ?').get(req.params.id);
  if (!existente || !esDueno(existente, req)) return res.status(404).json({ error: 'Hotel/local no encontrado' });

  try {
    await db.prepare('UPDATE destinos SET destino = ?, ubicacion = ? WHERE id_destino = ?')
      .run(destino, quitarAcentos((req.body.ubicacion || '').trim()) || null, req.params.id);
    if (req.body.empresas !== undefined) await reemplazarEmpresasDestino(req.params.id, req.body.empresas);
    if (req.body.grupos !== undefined) await reemplazarGruposDestino(req.params.id, req.body.grupos);
    if (req.body.cadenas !== undefined) await reemplazarCadenasDestino(req.params.id, req.body.cadenas);
    res.json(await destinoConEmpresas(req.params.id));
  } catch (e) {
    res.status(400).json({ errores: ['Ese hotel/local ya existe'] });
  }
}));

app.delete('/api/destinos/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM destinos WHERE id_destino = ?').get(req.params.id);
  if (!existente || !esDueno(existente, req)) return res.status(404).json({ error: 'Hotel/local no encontrado' });

  const enUso = await contarOrdenesQueUsan('destino_id', req.params.id);
  if (enUso > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso} orden(es) usan este hotel/local.`] });
  }
  const info = await db.prepare('DELETE FROM destinos WHERE id_destino = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Hotel/local no encontrado' });
  res.status(204).end();
}));

// Unifica los grupos de duplicados que el usuario selecciono manualmente en la app: para cada
// grupo se indica que hotel/local sobrevive (sobreviviente_id) y cuales se eliminan
// (duplicado_ids). Reasigna ordenes y cotizaciones, fusiona (sin perder datos) las plazas/
// grupos/cadenas y los contactos asociados de cada duplicado hacia el sobreviviente.
app.post('/api/destinos/unificar', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const decisiones = Array.isArray(req.body.decisiones) ? req.body.decisiones : [];
  if (!decisiones.length) return res.status(400).json({ errores: ['No hay decisiones de unificacion que aplicar'] });

  const resultado = await transaction(async (db) => {
    let gruposUnificados = 0;
    let duplicadosEliminados = 0;
    let ordenesReasignadas = 0;
    const detalle = [];

    for (const decision of decisiones) {
      const sobreviviente = await db.prepare('SELECT * FROM destinos WHERE id_destino = ?').get(decision.sobreviviente_id);
      const duplicadoIds = Array.isArray(decision.duplicado_ids) ? decision.duplicado_ids : [];
      if (!sobreviviente || !esDueno(sobreviviente, req) || !duplicadoIds.length) continue;

      for (const dupId of duplicadoIds) {
        if (Number(dupId) === Number(decision.sobreviviente_id)) continue;
        const dup = await db.prepare('SELECT * FROM destinos WHERE id_destino = ?').get(dupId);
        // Nunca unificar destinos de otro dueno, aunque el sobreviviente si sea propio.
        if (!dup || dup.usuario_id !== sobreviviente.usuario_id) continue;

        const info = await db.prepare('UPDATE ordenes SET destino_id = ? WHERE destino_id = ?').run(sobreviviente.id_destino, dup.id_destino);
        ordenesReasignadas += info.changes;
        await db.prepare('UPDATE cotizaciones SET destino_id = ? WHERE destino_id = ?').run(sobreviviente.id_destino, dup.id_destino);
        await db.prepare(`
          INSERT INTO contacto_destinos (contacto_id, destino_id)
          SELECT contacto_id, ? FROM contacto_destinos WHERE destino_id = ?
          ON CONFLICT (contacto_id, destino_id) DO NOTHING
        `).run(sobreviviente.id_destino, dup.id_destino);
        await db.prepare(`
          INSERT INTO destino_empresas (destino_id, empresa_id)
          SELECT ?, empresa_id FROM destino_empresas WHERE destino_id = ?
          ON CONFLICT (destino_id, empresa_id) DO NOTHING
        `).run(sobreviviente.id_destino, dup.id_destino);
        await db.prepare(`
          INSERT INTO destino_grupos (destino_id, grupo_id)
          SELECT ?, grupo_id FROM destino_grupos WHERE destino_id = ?
          ON CONFLICT (destino_id, grupo_id) DO NOTHING
        `).run(sobreviviente.id_destino, dup.id_destino);
        await db.prepare(`
          INSERT INTO destino_cadenas (destino_id, cadena_id)
          SELECT ?, cadena_id FROM destino_cadenas WHERE destino_id = ?
          ON CONFLICT (destino_id, cadena_id) DO NOTHING
        `).run(sobreviviente.id_destino, dup.id_destino);
        await db.prepare('DELETE FROM destinos WHERE id_destino = ?').run(dup.id_destino);
        duplicadosEliminados++;
      }

      gruposUnificados++;
      detalle.push({ destino: sobreviviente.destino, duplicadosEliminados: duplicadoIds.length });
    }

    return { gruposUnificados, duplicadosEliminados, ordenesReasignadas, detalle };
  });

  res.json(resultado);
}));

// ---------- Contactos ----------
// Un contacto puede tener varios Destinos asociados (tabla contacto_destinos,
// mismo patron que destino_empresas: solo referencia destino_id, no crea destinos nuevos).

async function destinosDeContacto(contactoId) {
  return db.prepare(`
    SELECT d.id_destino, d.destino FROM contacto_destinos cd
    JOIN destinos d ON d.id_destino = cd.destino_id
    WHERE cd.contacto_id = ?
    ORDER BY d.destino
  `).all(contactoId);
}

// Fecha de ultima actividad: no se guarda, se calcula como la fecha de creacion mas reciente
// entre las ordenes, negocios y cotizaciones que usan a este contacto (o null si no tiene ninguna).
async function fechaUltimaActividadContacto(contactoId) {
  const fila = await db.prepare(`
    SELECT MAX(fecha) AS fecha FROM (
      SELECT creado_en AS fecha FROM ordenes WHERE contacto_id = ?
      UNION ALL
      SELECT creado_en AS fecha FROM negocios WHERE contacto_id = ?
      UNION ALL
      SELECT creado_en AS fecha FROM cotizaciones WHERE contacto_id = ?
    ) t
  `).get(contactoId, contactoId, contactoId);
  return fila.fecha || null;
}

// Versiones en lote de destinosDeContacto/fechaUltimaActividadContacto: una sola consulta
// para todos los contactos en vez de dos por contacto (evita N+1 viajes de red).
async function destinosDeContactosBatch(contactoIds) {
  const mapa = new Map();
  if (!contactoIds.length) return mapa;
  const filas = await db.prepare(`
    SELECT cd.contacto_id, d.id_destino, d.destino FROM contacto_destinos cd
    JOIN destinos d ON d.id_destino = cd.destino_id
    WHERE cd.contacto_id = ANY(?)
    ORDER BY d.destino
  `).all(contactoIds);
  for (const f of filas) {
    if (!mapa.has(f.contacto_id)) mapa.set(f.contacto_id, []);
    mapa.get(f.contacto_id).push({ id_destino: f.id_destino, destino: f.destino });
  }
  return mapa;
}

async function fechasUltimaActividadContactosBatch(contactoIds) {
  const mapa = new Map();
  if (!contactoIds.length) return mapa;
  const filas = await db.prepare(`
    SELECT contacto_id, MAX(fecha) AS fecha FROM (
      SELECT contacto_id, creado_en AS fecha FROM ordenes WHERE contacto_id = ANY(?)
      UNION ALL
      SELECT contacto_id, creado_en AS fecha FROM negocios WHERE contacto_id = ANY(?)
      UNION ALL
      SELECT contacto_id, creado_en AS fecha FROM cotizaciones WHERE contacto_id = ANY(?)
    ) t
    GROUP BY contacto_id
  `).all(contactoIds, contactoIds, contactoIds);
  for (const f of filas) mapa.set(f.contacto_id, f.fecha);
  return mapa;
}

// Cuenta, para cada contacto, cuantas cotizaciones/ordenes tiene y cuantas tareas (pendientes)
// estan asociadas (via el negocio o la orden del contacto). Todo en 3 consultas agrupadas en
// vez de una por contacto (evita N+1).
async function conteosAsociadosContactosBatch(contactoIds) {
  const vacio = new Map();
  if (!contactoIds.length) return { cotizaciones: vacio, ordenes: vacio, tareas: vacio };

  const [cotizaciones, ordenes, tareas] = await Promise.all([
    db.prepare('SELECT contacto_id, COUNT(*) c FROM cotizaciones WHERE contacto_id = ANY(?) GROUP BY contacto_id').all(contactoIds),
    db.prepare('SELECT contacto_id, COUNT(*) c FROM ordenes WHERE contacto_id = ANY(?) GROUP BY contacto_id').all(contactoIds),
    db.prepare(`
      SELECT contacto_id, COUNT(*) c FROM (
        SELECT DISTINCT n.contacto_id, p.id_pendiente FROM pendientes p JOIN negocios n ON n.id_negocio = p.negocio_id WHERE n.contacto_id = ANY(?)
        UNION
        SELECT DISTINCT o.contacto_id, p.id_pendiente FROM pendientes p JOIN ordenes o ON o.id = p.orden_id WHERE o.contacto_id = ANY(?)
      ) t
      GROUP BY contacto_id
    `).all(contactoIds, contactoIds),
  ]);

  const aMapa = (filas) => new Map(filas.map((f) => [f.contacto_id, Number(f.c)]));
  return { cotizaciones: aMapa(cotizaciones), ordenes: aMapa(ordenes), tareas: aMapa(tareas) };
}

async function contactoConDestinos(id) {
  const c = await db.prepare('SELECT * FROM contactos WHERE id_contacto = ?').get(id);
  if (!c) return null;
  return { ...c, destinos: await destinosDeContacto(id), fecha_ultima_actividad: await fechaUltimaActividadContacto(id) };
}

async function reemplazarDestinosContacto(contactoId, destinoIds) {
  await db.prepare('DELETE FROM contacto_destinos WHERE contacto_id = ?').run(contactoId);
  for (const destinoId of destinoIds || []) {
    if (destinoId) {
      await db.prepare('INSERT INTO contacto_destinos (contacto_id, destino_id) VALUES (?, ?) ON CONFLICT (contacto_id, destino_id) DO NOTHING').run(contactoId, destinoId);
    }
  }
}

app.get('/api/contactos', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const contactos = req.session.esAdmin
    ? await db.prepare('SELECT * FROM contactos ORDER BY nombre, apellido').all()
    : await db.prepare('SELECT * FROM contactos WHERE usuario_id = ? ORDER BY nombre, apellido').all(req.session.usuarioId);
  const contactoIds = contactos.map((c) => c.id_contacto);
  const [destinosPorContacto, fechasPorContacto, conteos] = await Promise.all([
    destinosDeContactosBatch(contactoIds),
    fechasUltimaActividadContactosBatch(contactoIds),
    conteosAsociadosContactosBatch(contactoIds),
  ]);
  res.json(contactos.map((c) => {
    const nombreCompleto = [c.nombre, c.apellido].filter(Boolean).join(' ');
    return {
      ...c,
      nombre_completo: nombreCompleto,
      // Version para selects donde se necesita distinguir contactos con el mismo nombre
      // (ej. varias "Paola"): agrega el correo si lo tiene.
      nombre_completo_correo: c.correo_electronico ? `${nombreCompleto} — ${c.correo_electronico}` : nombreCompleto,
      destinos: destinosPorContacto.get(c.id_contacto) || [],
      fecha_ultima_actividad: fechasPorContacto.get(c.id_contacto) || null,
      cotizaciones_count: conteos.cotizaciones.get(c.id_contacto) || 0,
      ordenes_count: conteos.ordenes.get(c.id_contacto) || 0,
      tareas_count: conteos.tareas.get(c.id_contacto) || 0,
    };
  }));
}));

// Un solo contacto con sus conteos de asociados, para la pantalla de detalle (contacto-detalle.html).
app.get('/api/contactos/:id', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const contacto = await contactoConDestinos(req.params.id);
  if (!contacto || !esDueno(contacto, req)) return res.status(404).json({ error: 'Contacto no encontrado' });
  const conteos = await conteosAsociadosContactosBatch([contacto.id_contacto]);
  res.json({
    ...contacto,
    cotizaciones_count: conteos.cotizaciones.get(contacto.id_contacto) || 0,
    ordenes_count: conteos.ordenes.get(contacto.id_contacto) || 0,
    tareas_count: conteos.tareas.get(contacto.id_contacto) || 0,
  });
}));

// El correo (si se captura) es la llave del contacto DENTRO de cada usuario: no puede
// repetirse en otro contacto del mismo dueno (si son de usuarios distintos, no chocan).
async function contactoConEseCorreo(correo, usuarioId, idExcluido) {
  if (!correo) return null;
  const fila = await db.prepare(`
    SELECT id_contacto, nombre, apellido FROM contactos
    WHERE lower(correo_electronico) = lower(?) AND usuario_id = ? AND id_contacto != COALESCE(?, -1)
  `).get(correo, usuarioId, idExcluido || null);
  return fila || null;
}

function nombreCompletoDe(fila) {
  return [fila.nombre, fila.apellido].filter(Boolean).join(' ');
}

// Cotizaciones, ordenes y tareas asociadas a un contacto (para el detalle desde el catalogo
// de Contactos). Las tareas se derivan via el negocio o la orden del contacto (para tareas
// ligadas a esas entidades), y tambien directamente via pendientes.contacto_id (para tareas
// sueltas, ej. Llamada/Correo Electronico/Mensaje de Texto registradas desde Tareas).
app.get('/api/contactos/:id/asociados', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const contacto = await db.prepare('SELECT * FROM contactos WHERE id_contacto = ?').get(req.params.id);
  if (!contacto || !esDueno(contacto, req)) return res.status(404).json({ error: 'Contacto no encontrado' });

  const [cotizaciones, ordenes, tareas] = await Promise.all([
    db.prepare(`${SELECT_COTIZACIONES} WHERE q.contacto_id = ? ORDER BY q.creado_en DESC`).all(req.params.id),
    db.prepare(`${SELECT_ORDENES} WHERE o.contacto_id = ? ORDER BY o.creado_en DESC`).all(req.params.id),
    db.prepare(`
      SELECT DISTINCT p.* FROM pendientes p
      LEFT JOIN negocios n ON n.id_negocio = p.negocio_id
      LEFT JOIN ordenes o ON o.id = p.orden_id
      WHERE n.contacto_id = ? OR o.contacto_id = ? OR p.contacto_id = ?
      ORDER BY p.creado_en DESC
    `).all(req.params.id, req.params.id, req.params.id),
  ]);

  const actividadesPorTarea = await actividadesDePendientesBatch(tareas.map((t) => t.id_pendiente));
  const tareasConActividades = tareas.map((t) => ({ ...t, actividades: actividadesPorTarea.get(t.id_pendiente) || [] }));

  res.json({ cotizaciones: cotizaciones.map(conEstatus), ordenes, tareas: tareasConActividades });
}));

app.post('/api/contactos', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const nombre = quitarAcentos((req.body.nombre || '').trim());
  if (!nombre) return res.status(400).json({ errores: ['nombre es requerido'] });
  const apellido = quitarAcentos((req.body.apellido || '').trim()) || null;

  const correo = (req.body.correo_electronico || '').trim() || null;
  const duplicado = await contactoConEseCorreo(correo, req.session.usuarioId);
  if (duplicado) {
    return res.status(400).json({ errores: [`Ya existe un contacto con ese correo: "${nombreCompletoDe(duplicado)}"`] });
  }

  const info = await db.prepare(`
    INSERT INTO contactos (id_publico, nombre, apellido, correo_electronico, telefono_local, telefono_celular, usuario_id, creado_en)
    VALUES (?, ?, ?, ?, ?, ?, ?, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
  `).run(
    await generarIdContacto(),
    nombre,
    apellido,
    correo,
    (req.body.telefono_local || '').trim() || null,
    (req.body.telefono_celular || '').trim() || null,
    req.session.usuarioId
  );
  await reemplazarDestinosContacto(info.lastInsertRowid, req.body.destinos);
  res.status(201).json(await contactoConDestinos(info.lastInsertRowid));
}));

app.put('/api/contactos/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM contactos WHERE id_contacto = ?').get(req.params.id);
  if (!existente || !esDueno(existente, req)) return res.status(404).json({ error: 'Contacto no encontrado' });

  const nombre = quitarAcentos((req.body.nombre || '').trim());
  if (!nombre) return res.status(400).json({ errores: ['nombre es requerido'] });
  const apellido = quitarAcentos((req.body.apellido || '').trim()) || null;

  const correo = (req.body.correo_electronico || '').trim() || null;
  const duplicado = await contactoConEseCorreo(correo, existente.usuario_id, req.params.id);
  if (duplicado) {
    return res.status(400).json({ errores: [`Ya existe un contacto con ese correo: "${nombreCompletoDe(duplicado)}"`] });
  }

  await db.prepare(`
    UPDATE contactos SET nombre = ?, apellido = ?, correo_electronico = ?, telefono_local = ?, telefono_celular = ?
    WHERE id_contacto = ?
  `).run(
    nombre,
    apellido,
    correo,
    (req.body.telefono_local || '').trim() || null,
    (req.body.telefono_celular || '').trim() || null,
    req.params.id
  );
  if (req.body.destinos !== undefined) await reemplazarDestinosContacto(req.params.id, req.body.destinos);
  res.json(await contactoConDestinos(req.params.id));
}));

app.delete('/api/contactos/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM contactos WHERE id_contacto = ?').get(req.params.id);
  if (!existente || !esDueno(existente, req)) return res.status(404).json({ error: 'Contacto no encontrado' });

  const enUso = await contarOrdenesQueUsan('contacto_id', req.params.id);
  if (enUso > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso} orden(es) usan este contacto.`] });
  }
  const info = await db.prepare('DELETE FROM contactos WHERE id_contacto = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Contacto no encontrado' });
  res.status(204).end();
}));

// Carga masiva de contactos por CSV. Upsert por Nombre + Apellido (comparado sin
// acentos/mayusculas): si ya existe un contacto con ese nombre completo se actualizan sus
// datos y se agregan los destinos nuevos (sin borrar los que ya tenia); si no existe, se crea.
// "destinos" en el CSV va separado por ";" dentro de la celda y los destinos que no existan se autocrean.
app.post('/api/contactos/importar-csv', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) {
    return res.status(400).json({ error: 'Envia el contenido del CSV como texto (Content-Type: text/csv)' });
  }

  const registros = filasCsvAObjetos(parsearCSV(req.body));

  const resultado = await transaction(async (db) => {
    const destinosCreados = new Set();
    const errores = [];
    let insertadas = 0;
    let actualizadas = 0;

    async function obtenerOCrearDestino(nombre) {
      const limpio = quitarAcentos(String(nombre || '').trim());
      if (!limpio) return null;
      const existente = await db.prepare('SELECT id_destino FROM destinos WHERE destino = ? AND usuario_id = ?').get(limpio, req.session.usuarioId);
      if (existente) return existente.id_destino;
      const info = await db.prepare('INSERT INTO destinos (destino, usuario_id) VALUES (?, ?)').run(limpio, req.session.usuarioId);
      destinosCreados.add(limpio);
      return info.lastInsertRowid;
    }

    async function buscarContactoExistente(nombreNormalizado, apellidoNormalizado) {
      const todos = await db.prepare('SELECT id_contacto, nombre, apellido FROM contactos WHERE usuario_id = ?').all(req.session.usuarioId);
      return todos.find((c) => normalizarParaComparar(c.nombre) === nombreNormalizado
        && normalizarParaComparar(c.apellido || '') === apellidoNormalizado);
    }

    for (let indice = 0; indice < registros.length; indice++) {
      const registro = registros[indice];
      const numeroFila = indice + 2;
      try {
        if (!registro.nombre) throw new Error('nombre es requerido');

        const nombreNormalizado = normalizarParaComparar(registro.nombre);
        const apellidoNormalizado = normalizarParaComparar(registro.apellido || '');
        const existente = await buscarContactoExistente(nombreNormalizado, apellidoNormalizado);

        const datos = {
          nombre: registro.nombre,
          apellido: registro.apellido || null,
          correo_electronico: registro.correo_electronico || null,
          telefono_local: registro.telefono_local || null,
          telefono_celular: registro.telefono_celular || null,
        };

        if (datos.correo_electronico) {
          const otroConEseCorreo = await db.prepare('SELECT id_contacto, nombre, apellido FROM contactos WHERE lower(correo_electronico) = lower(?) AND usuario_id = ?').get(datos.correo_electronico, req.session.usuarioId);
          if (otroConEseCorreo && (!existente || otroConEseCorreo.id_contacto !== existente.id_contacto)) {
            throw new Error(`El correo "${datos.correo_electronico}" ya pertenece a otro contacto tuyo ("${nombreCompletoDe(otroConEseCorreo)}")`);
          }
        }

        let contactoId;
        if (existente) {
          await db.prepare(`
            UPDATE contactos SET
              correo_electronico = COALESCE(@correo_electronico, correo_electronico),
              telefono_local = COALESCE(@telefono_local, telefono_local),
              telefono_celular = COALESCE(@telefono_celular, telefono_celular)
            WHERE id_contacto = @id_contacto
          `).run({ ...datos, id_contacto: existente.id_contacto });
          contactoId = existente.id_contacto;
          actualizadas++;
        } else {
          const info = await db.prepare(`
            INSERT INTO contactos (id_publico, nombre, apellido, correo_electronico, telefono_local, telefono_celular, usuario_id, creado_en)
            VALUES (@id_publico, @nombre, @apellido, @correo_electronico, @telefono_local, @telefono_celular, @usuario_id, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))
          `).run({ ...datos, id_publico: await generarIdContacto(), usuario_id: req.session.usuarioId });
          contactoId = info.lastInsertRowid;
          insertadas++;
        }

        const nombresDestinos = (registro.destinos || '').split(';').map((d) => d.trim()).filter(Boolean);
        for (const nombreDestino of nombresDestinos) {
          const destinoId = await obtenerOCrearDestino(nombreDestino);
          if (destinoId) {
            await db.prepare('INSERT INTO contacto_destinos (contacto_id, destino_id) VALUES (?, ?) ON CONFLICT (contacto_id, destino_id) DO NOTHING').run(contactoId, destinoId);
          }
        }
      } catch (e) {
        errores.push({ fila: numeroFila, id: registro.nombre || '(sin nombre)', error: e.message });
      }
    }

    return { insertadas, actualizadas, errores, destinosCreados: [...destinosCreados] };
  });

  res.json({ total: registros.length, ...resultado });
}));

// Unifica los grupos de duplicados que el usuario selecciono manualmente en la app: para cada
// grupo se indica que contacto sobrevive (sobreviviente_id) y cuales se eliminan (duplicado_ids).
app.post('/api/contactos/unificar', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const decisiones = Array.isArray(req.body.decisiones) ? req.body.decisiones : [];
  if (!decisiones.length) return res.status(400).json({ errores: ['No hay decisiones de unificacion que aplicar'] });

  const resultado = await transaction(async (db) => {
    let gruposUnificados = 0;
    let duplicadosEliminados = 0;
    let ordenesReasignadas = 0;
    const detalle = [];

    for (const decision of decisiones) {
      const sobreviviente = await db.prepare('SELECT * FROM contactos WHERE id_contacto = ?').get(decision.sobreviviente_id);
      const duplicadoIds = Array.isArray(decision.duplicado_ids) ? decision.duplicado_ids : [];
      if (!sobreviviente || !esDueno(sobreviviente, req) || !duplicadoIds.length) continue;

      for (const dupId of duplicadoIds) {
        if (Number(dupId) === Number(decision.sobreviviente_id)) continue;
        const dup = await db.prepare('SELECT * FROM contactos WHERE id_contacto = ?').get(dupId);
        // Nunca unificar contactos de otro dueno, aunque el sobreviviente si sea propio.
        if (!dup || dup.usuario_id !== sobreviviente.usuario_id) continue;

        const info = await db.prepare('UPDATE ordenes SET contacto_id = ? WHERE contacto_id = ?').run(sobreviviente.id_contacto, dup.id_contacto);
        ordenesReasignadas += info.changes;
        await db.prepare('UPDATE cotizaciones SET contacto_id = ? WHERE contacto_id = ?').run(sobreviviente.id_contacto, dup.id_contacto);
        await db.prepare('UPDATE negocios SET contacto_id = ? WHERE contacto_id = ?').run(sobreviviente.id_contacto, dup.id_contacto);
        await db.prepare(`
          INSERT INTO contacto_destinos (contacto_id, destino_id)
          SELECT ?, destino_id FROM contacto_destinos WHERE contacto_id = ?
          ON CONFLICT (contacto_id, destino_id) DO NOTHING
        `).run(sobreviviente.id_contacto, dup.id_contacto);
        await db.prepare('DELETE FROM contactos WHERE id_contacto = ?').run(dup.id_contacto);
        duplicadosEliminados++;
      }

      gruposUnificados++;
      detalle.push({ contacto: nombreCompletoDe(sobreviviente), duplicadosEliminados: duplicadoIds.length });
    }

    return { gruposUnificados, duplicadosEliminados, ordenesReasignadas, detalle };
  });

  res.json(resultado);
}));

// ---------- Estatus y Estado de entrega (catalogos) ----------

app.get('/api/estatus', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM estatus_catalogo ORDER BY estatus').all());
}));

app.post('/api/estatus', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const estatus = quitarAcentos((req.body.estatus || '').trim());
  if (!estatus) return res.status(400).json({ errores: ['estatus es requerido'] });

  try {
    const info = await db.prepare('INSERT INTO estatus_catalogo (estatus) VALUES (?)').run(estatus);
    res.status(201).json(await db.prepare('SELECT * FROM estatus_catalogo WHERE id_estatus = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ errores: ['Ese estatus ya existe'] });
  }
}));

app.put('/api/estatus/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const estatus = quitarAcentos((req.body.estatus || '').trim());
  if (!estatus) return res.status(400).json({ errores: ['estatus es requerido'] });

  const existente = await db.prepare('SELECT * FROM estatus_catalogo WHERE id_estatus = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Estatus no encontrado' });

  try {
    await db.prepare('UPDATE estatus_catalogo SET estatus = ? WHERE id_estatus = ?').run(estatus, req.params.id);
    res.json(await db.prepare('SELECT * FROM estatus_catalogo WHERE id_estatus = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ errores: ['Ese estatus ya existe'] });
  }
}));

app.delete('/api/estatus/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await contarOrdenesQueUsan('estatus_id', req.params.id);
  if (enUso > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso} orden(es) usan este estatus.`] });
  }
  const info = await db.prepare('DELETE FROM estatus_catalogo WHERE id_estatus = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Estatus no encontrado' });
  res.status(204).end();
}));

app.get('/api/estados-entrega', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM estados_entrega ORDER BY estado_entrega').all());
}));

app.post('/api/estados-entrega', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const estadoEntrega = quitarAcentos((req.body.estado_entrega || '').trim());
  if (!estadoEntrega) return res.status(400).json({ errores: ['estado_entrega es requerido'] });

  try {
    const info = await db.prepare('INSERT INTO estados_entrega (estado_entrega) VALUES (?)').run(estadoEntrega);
    res.status(201).json(await db.prepare('SELECT * FROM estados_entrega WHERE id_estado_entrega = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ errores: ['Ese estado de la república ya existe'] });
  }
}));

app.put('/api/estados-entrega/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const estadoEntrega = quitarAcentos((req.body.estado_entrega || '').trim());
  if (!estadoEntrega) return res.status(400).json({ errores: ['estado_entrega es requerido'] });

  const existente = await db.prepare('SELECT * FROM estados_entrega WHERE id_estado_entrega = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Estado de la República no encontrado' });

  try {
    await db.prepare('UPDATE estados_entrega SET estado_entrega = ? WHERE id_estado_entrega = ?').run(estadoEntrega, req.params.id);
    res.json(await db.prepare('SELECT * FROM estados_entrega WHERE id_estado_entrega = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ errores: ['Ese estado de la república ya existe'] });
  }
}));

app.delete('/api/estados-entrega/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await contarOrdenesQueUsan('estado_entrega_id', req.params.id);
  if (enUso > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso} orden(es) usan este estado de la república.`] });
  }
  const info = await db.prepare('DELETE FROM estados_entrega WHERE id_estado_entrega = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Estado de la República no encontrado' });
  res.status(204).end();
}));

// ---------- Productos (Cotizaciones): Categoria, Linea, Marca y Productos ----------
// Categoria/Linea/Marca usan un ID de texto con prefijo autogenerado (Cat-00001,
// Lin-00001, M-00001). Productos usa "item" (capturado por el usuario) como llave,
// por eso no puede repetirse.

app.get('/api/categorias', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM categorias ORDER BY categoria').all());
}));

app.post('/api/categorias', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const categoria = quitarAcentos((req.body.categoria || '').trim());
  if (!categoria) return res.status(400).json({ errores: ['categoria es requerida'] });

  try {
    const id = await generarSiguienteIdConPrefijo('categorias', 'id_categoria', 'Cat-');
    await db.prepare('INSERT INTO categorias (id_categoria, categoria) VALUES (?, ?)').run(id, categoria);
    res.status(201).json(await db.prepare('SELECT * FROM categorias WHERE id_categoria = ?').get(id));
  } catch (e) {
    res.status(400).json({ errores: ['Esa categoria ya existe'] });
  }
}));

app.put('/api/categorias/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const categoria = quitarAcentos((req.body.categoria || '').trim());
  if (!categoria) return res.status(400).json({ errores: ['categoria es requerida'] });

  const existente = await db.prepare('SELECT * FROM categorias WHERE id_categoria = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Categoria no encontrada' });

  try {
    await db.prepare('UPDATE categorias SET categoria = ? WHERE id_categoria = ?').run(categoria, req.params.id);
    res.json(await db.prepare('SELECT * FROM categorias WHERE id_categoria = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ errores: ['Esa categoria ya existe'] });
  }
}));

app.delete('/api/categorias/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await contarProductosQueUsan('categoria_id', req.params.id);
  if (enUso > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso} producto(s) usan esta categoria.`] });
  }
  const info = await db.prepare('DELETE FROM categorias WHERE id_categoria = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Categoria no encontrada' });
  res.status(204).end();
}));

app.get('/api/lineas', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM lineas ORDER BY linea').all());
}));

app.post('/api/lineas', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const linea = quitarAcentos((req.body.linea || '').trim());
  if (!linea) return res.status(400).json({ errores: ['linea es requerida'] });

  try {
    const id = await generarSiguienteIdConPrefijo('lineas', 'id_linea', 'Lin-');
    await db.prepare('INSERT INTO lineas (id_linea, linea) VALUES (?, ?)').run(id, linea);
    res.status(201).json(await db.prepare('SELECT * FROM lineas WHERE id_linea = ?').get(id));
  } catch (e) {
    res.status(400).json({ errores: ['Esa linea ya existe'] });
  }
}));

app.put('/api/lineas/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const linea = quitarAcentos((req.body.linea || '').trim());
  if (!linea) return res.status(400).json({ errores: ['linea es requerida'] });

  const existente = await db.prepare('SELECT * FROM lineas WHERE id_linea = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Linea no encontrada' });

  try {
    await db.prepare('UPDATE lineas SET linea = ? WHERE id_linea = ?').run(linea, req.params.id);
    res.json(await db.prepare('SELECT * FROM lineas WHERE id_linea = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ errores: ['Esa linea ya existe'] });
  }
}));

app.delete('/api/lineas/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await contarProductosQueUsan('linea_id', req.params.id);
  if (enUso > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso} producto(s) usan esta linea.`] });
  }
  const info = await db.prepare('DELETE FROM lineas WHERE id_linea = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Linea no encontrada' });
  res.status(204).end();
}));

app.get('/api/marcas', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM marcas ORDER BY marca').all());
}));

app.post('/api/marcas', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const marca = quitarAcentos((req.body.marca || '').trim());
  if (!marca) return res.status(400).json({ errores: ['marca es requerida'] });

  try {
    const id = await generarSiguienteIdConPrefijo('marcas', 'id_marca', 'M-');
    await db.prepare('INSERT INTO marcas (id_marca, marca) VALUES (?, ?)').run(id, marca);
    res.status(201).json(await db.prepare('SELECT * FROM marcas WHERE id_marca = ?').get(id));
  } catch (e) {
    res.status(400).json({ errores: ['Esa marca ya existe'] });
  }
}));

app.put('/api/marcas/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const marca = quitarAcentos((req.body.marca || '').trim());
  if (!marca) return res.status(400).json({ errores: ['marca es requerida'] });

  const existente = await db.prepare('SELECT * FROM marcas WHERE id_marca = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Marca no encontrada' });

  try {
    await db.prepare('UPDATE marcas SET marca = ? WHERE id_marca = ?').run(marca, req.params.id);
    res.json(await db.prepare('SELECT * FROM marcas WHERE id_marca = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ errores: ['Esa marca ya existe'] });
  }
}));

app.delete('/api/marcas/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await contarProductosQueUsan('marca_id', req.params.id);
  if (enUso > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso} producto(s) usan esta marca.`] });
  }
  const info = await db.prepare('DELETE FROM marcas WHERE id_marca = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Marca no encontrada' });
  res.status(204).end();
}));

const SELECT_PRODUCTOS = `
  SELECT p.*, c.categoria AS categoria_nombre, l.linea AS linea_nombre, m.marca AS marca_nombre
  FROM productos p
  LEFT JOIN categorias c ON c.id_categoria = p.categoria_id
  LEFT JOIN lineas l ON l.id_linea = p.linea_id
  LEFT JOIN marcas m ON m.id_marca = p.marca_id
`;

// Buscador de productos: se usa antes de dar de alta un articulo para evitar
// duplicados (el frontend pide a partir de 3 letras, aqui se busca por item o descripcion).
app.get('/api/productos', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const q = (req.query.q || '').trim();
  if (!q) {
    return res.json(await db.prepare(`${SELECT_PRODUCTOS} ORDER BY p.item`).all());
  }
  const like = `%${q}%`;
  res.json(await db.prepare(`
    ${SELECT_PRODUCTOS}
    WHERE p.item ILIKE ? OR p.descripcion ILIKE ?
    ORDER BY p.item
  `).all(like, like));
}));

app.post('/api/productos', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const item = (req.body.item || '').trim();
  if (!item) return res.status(400).json({ errores: ['item es requerido'] });

  const precioUsd = req.body.precio_usd;
  if (precioUsd === undefined || precioUsd === null || precioUsd === '' || Number.isNaN(Number(precioUsd))) {
    return res.status(400).json({ errores: ['precio_usd es requerido'] });
  }

  const erroresCatalogo = [];
  if (!req.body.categoria_id) erroresCatalogo.push('La categoría es requerida');
  if (!req.body.linea_id) erroresCatalogo.push('La línea es requerida');
  if (!req.body.marca_id) erroresCatalogo.push('La marca es requerida');
  if (erroresCatalogo.length) return res.status(400).json({ errores: erroresCatalogo });

  const existente = await db.prepare('SELECT item FROM productos WHERE item = ?').get(item);
  if (existente) return res.status(400).json({ errores: ['Ya existe un producto con ese Item'] });

  await db.prepare(`
    INSERT INTO productos (item, descripcion, categoria_id, linea_id, marca_id, precio_usd, precio_mxn)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    item,
    (req.body.descripcion || '').trim() || null,
    req.body.categoria_id || null,
    req.body.linea_id || null,
    req.body.marca_id || null,
    Number(precioUsd),
    req.body.precio_mxn !== undefined && req.body.precio_mxn !== '' ? Number(req.body.precio_mxn) : null
  );
  res.status(201).json(await db.prepare(`${SELECT_PRODUCTOS} WHERE p.item = ?`).get(item));
}));

app.put('/api/productos/:item', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM productos WHERE item = ?').get(req.params.item);
  if (!existente) return res.status(404).json({ error: 'Producto no encontrado' });

  const precioUsd = req.body.precio_usd;
  if (precioUsd === undefined || precioUsd === null || precioUsd === '' || Number.isNaN(Number(precioUsd))) {
    return res.status(400).json({ errores: ['precio_usd es requerido'] });
  }

  const erroresCatalogo = [];
  if (!req.body.categoria_id) erroresCatalogo.push('La categoría es requerida');
  if (!req.body.linea_id) erroresCatalogo.push('La línea es requerida');
  if (!req.body.marca_id) erroresCatalogo.push('La marca es requerida');
  if (erroresCatalogo.length) return res.status(400).json({ errores: erroresCatalogo });

  const nuevoItem = (req.body.item || '').trim();
  const cambiaItem = nuevoItem && nuevoItem !== req.params.item;
  if (cambiaItem && !req.session.esAdmin) {
    return res.status(403).json({ errores: ['Solo un administrador puede modificar el codigo del producto'] });
  }
  if (cambiaItem) {
    const yaExiste = await db.prepare('SELECT item FROM productos WHERE item = ?').get(nuevoItem);
    if (yaExiste) return res.status(400).json({ errores: ['Ya existe un producto con ese Item'] });
  }

  const descripcion = (req.body.descripcion || '').trim() || null;
  const categoriaId = req.body.categoria_id || null;
  const lineaId = req.body.linea_id || null;
  const marcaId = req.body.marca_id || null;
  const precioMxn = req.body.precio_mxn !== undefined && req.body.precio_mxn !== '' ? Number(req.body.precio_mxn) : null;
  const itemFinal = cambiaItem ? nuevoItem : req.params.item;

  if (cambiaItem) {
    // productos.item es PK referenciada por cotizacion_items.producto_item (FK sin ON UPDATE CASCADE),
    // por lo que se inserta el nuevo item, se reasignan los items de cotizacion y hasta entonces se borra el anterior.
    await transaction(async (db) => {
      await db.prepare(`
        INSERT INTO productos (item, descripcion, categoria_id, linea_id, marca_id, precio_usd, precio_mxn)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(nuevoItem, descripcion, categoriaId, lineaId, marcaId, Number(precioUsd), precioMxn);
      await db.prepare('UPDATE cotizacion_items SET producto_item = ? WHERE producto_item = ?').run(nuevoItem, req.params.item);
      await db.prepare('DELETE FROM productos WHERE item = ?').run(req.params.item);
    });
  } else {
    await db.prepare(`
      UPDATE productos SET descripcion = ?, categoria_id = ?, linea_id = ?, marca_id = ?, precio_usd = ?, precio_mxn = ?
      WHERE item = ?
    `).run(descripcion, categoriaId, lineaId, marcaId, Number(precioUsd), precioMxn, req.params.item);
  }

  res.json(await db.prepare(`${SELECT_PRODUCTOS} WHERE p.item = ?`).get(itemFinal));
}));

app.delete('/api/productos/:item', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const info = await db.prepare('DELETE FROM productos WHERE item = ?').run(req.params.item);
  if (info.changes === 0) return res.status(404).json({ error: 'Producto no encontrado' });
  res.status(204).end();
}));

// Carga masiva de productos por CSV. Upsert por "item" (llave del producto): si ya existe se
// actualiza, si no se inserta. Categoria/Linea/Marca se autocrean por nombre si no existen,
// igual que en la carga de Ordenes con Destino/Contacto.
app.post('/api/productos/importar-csv', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) {
    return res.status(400).json({ error: 'Envia el contenido del CSV como texto (Content-Type: text/csv)' });
  }

  const registros = filasCsvAObjetos(parsearCSV(req.body));

  const resultado = await transaction(async (db) => {
    const categoriasCreadas = new Set();
    const lineasCreadas = new Set();
    const marcasCreadas = new Set();
    const errores = [];
    let insertadas = 0;
    let actualizadas = 0;

    async function obtenerOCrearCategoria(nombre) {
      const limpio = quitarAcentos(String(nombre || '').trim());
      if (!limpio) return null;
      const existente = await db.prepare('SELECT id_categoria FROM categorias WHERE categoria = ?').get(limpio);
      if (existente) return existente.id_categoria;
      const id = await generarSiguienteIdConPrefijo('categorias', 'id_categoria', 'Cat-');
      await db.prepare('INSERT INTO categorias (id_categoria, categoria) VALUES (?, ?)').run(id, limpio);
      categoriasCreadas.add(limpio);
      return id;
    }

    async function obtenerOCrearLinea(nombre) {
      const limpio = quitarAcentos(String(nombre || '').trim());
      if (!limpio) return null;
      const existente = await db.prepare('SELECT id_linea FROM lineas WHERE linea = ?').get(limpio);
      if (existente) return existente.id_linea;
      const id = await generarSiguienteIdConPrefijo('lineas', 'id_linea', 'Lin-');
      await db.prepare('INSERT INTO lineas (id_linea, linea) VALUES (?, ?)').run(id, limpio);
      lineasCreadas.add(limpio);
      return id;
    }

    async function obtenerOCrearMarca(nombre) {
      const limpio = quitarAcentos(String(nombre || '').trim());
      if (!limpio) return null;
      const existente = await db.prepare('SELECT id_marca FROM marcas WHERE marca = ?').get(limpio);
      if (existente) return existente.id_marca;
      const id = await generarSiguienteIdConPrefijo('marcas', 'id_marca', 'M-');
      await db.prepare('INSERT INTO marcas (id_marca, marca) VALUES (?, ?)').run(id, limpio);
      marcasCreadas.add(limpio);
      return id;
    }

    for (let indice = 0; indice < registros.length; indice++) {
      const registro = registros[indice];
      const numeroFila = indice + 2;
      try {
        if (!registro.item) throw new Error('item es requerido');
        if (!registro.categoria) throw new Error('categoria es requerida');
        if (!registro.linea) throw new Error('linea es requerida');
        if (!registro.marca) throw new Error('marca es requerida');

        const precioUsd = numeroOpcional(registro.precio_usd);
        if (!registro.precio_usd) throw new Error('precio_usd es requerido');
        if (precioUsd === undefined) throw new Error('precio_usd debe ser numerico');

        const precioMxn = registro.precio_mxn ? numeroOpcional(registro.precio_mxn) : null;
        if (precioMxn === undefined) throw new Error('precio_mxn debe ser numerico');

        const datos = {
          item: registro.item,
          descripcion: registro.descripcion || null,
          categoria_id: registro.categoria ? await obtenerOCrearCategoria(registro.categoria) : null,
          linea_id: registro.linea ? await obtenerOCrearLinea(registro.linea) : null,
          marca_id: registro.marca ? await obtenerOCrearMarca(registro.marca) : null,
          precio_usd: precioUsd,
          precio_mxn: precioMxn,
        };

        const existeProducto = await db.prepare('SELECT item FROM productos WHERE item = ?').get(registro.item);
        if (existeProducto) {
          await db.prepare(`
            UPDATE productos SET descripcion = @descripcion, categoria_id = @categoria_id, linea_id = @linea_id,
              marca_id = @marca_id, precio_usd = @precio_usd, precio_mxn = @precio_mxn
            WHERE item = @item
          `).run(datos);
          actualizadas++;
        } else {
          await db.prepare(`
            INSERT INTO productos (item, descripcion, categoria_id, linea_id, marca_id, precio_usd, precio_mxn)
            VALUES (@item, @descripcion, @categoria_id, @linea_id, @marca_id, @precio_usd, @precio_mxn)
          `).run(datos);
          insertadas++;
        }
      } catch (e) {
        errores.push({ fila: numeroFila, id: registro.item || '(sin item)', error: e.message });
      }
    }

    return {
      insertadas, actualizadas, errores,
      categoriasCreadas: [...categoriasCreadas], lineasCreadas: [...lineasCreadas], marcasCreadas: [...marcasCreadas],
    };
  });

  res.json({ total: registros.length, ...resultado });
}));

// ---------- Cotizaciones: Etapa del Negocio (catalogo) ----------

app.get('/api/etapas-negocio', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM etapas_negocio ORDER BY id_etapa').all());
}));

app.post('/api/etapas-negocio', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const etapa = quitarAcentos((req.body.etapa || '').trim());
  if (!etapa) return res.status(400).json({ errores: ['etapa es requerida'] });

  try {
    const info = await db.prepare('INSERT INTO etapas_negocio (etapa) VALUES (?)').run(etapa);
    res.status(201).json(await db.prepare('SELECT * FROM etapas_negocio WHERE id_etapa = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ errores: ['Esa etapa ya existe'] });
  }
}));

app.put('/api/etapas-negocio/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const etapa = quitarAcentos((req.body.etapa || '').trim());
  if (!etapa) return res.status(400).json({ errores: ['etapa es requerida'] });

  const existente = await db.prepare('SELECT * FROM etapas_negocio WHERE id_etapa = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Etapa no encontrada' });

  try {
    await db.prepare('UPDATE etapas_negocio SET etapa = ? WHERE id_etapa = ?').run(etapa, req.params.id);
    res.json(await db.prepare('SELECT * FROM etapas_negocio WHERE id_etapa = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ errores: ['Esa etapa ya existe'] });
  }
}));

app.delete('/api/etapas-negocio/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const enUso = await contarNegociosQueUsan('etapa_id', req.params.id);
  if (enUso > 0) {
    return res.status(400).json({ errores: [`No se puede borrar: ${enUso} negocio(s) usan esta etapa.`] });
  }
  const info = await db.prepare('DELETE FROM etapas_negocio WHERE id_etapa = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Etapa no encontrada' });
  res.status(204).end();
}));

// ---------- Cotizaciones: Negocios ----------
// Un negocio puede tener varias cotizaciones asociadas. Importe USD/MXN es la sumatoria del
// Sub Total de sus cotizaciones, agrupada por moneda.

const SELECT_NEGOCIOS = `
  SELECT n.*, TRIM(c.nombre || ' ' || COALESCE(c.apellido, '')) AS contacto_nombre, e.etapa AS etapa_nombre
  FROM negocios n
  LEFT JOIN contactos c ON c.id_contacto = n.contacto_id
  LEFT JOIN etapas_negocio e ON e.id_etapa = n.etapa_id
`;

// Estatus de un negocio: "Vencido" solo si TODAS sus cotizaciones estan vencidas; si tiene al
// menos una vigente (o no tiene cotizaciones), el negocio es "Vigente".
async function estatusNegocio(negocioId) {
  const vencimientos = await db.prepare('SELECT fecha_vencimiento FROM cotizaciones WHERE negocio_id = ?').all(negocioId);
  if (vencimientos.length === 0) return 'Vigente';
  const todasVencidas = vencimientos.every((v) => estatusCotizacion(v.fecha_vencimiento) === 'Vencido');
  return todasVencidas ? 'Vencido' : 'Vigente';
}

async function negocioConImportes(fila) {
  if (!fila) return fila;
  const importes = await db.prepare(`
    SELECT moneda, SUM(subtotal) AS importe
    FROM cotizaciones WHERE negocio_id = ?
    GROUP BY moneda
  `).all(fila.id_negocio);
  const importeUsd = importes.find((i) => i.moneda === 'USD');
  const importeMxn = importes.find((i) => i.moneda === 'MXN');
  const tienePendiente = await db.prepare('SELECT 1 FROM pendientes WHERE negocio_id = ? LIMIT 1').get(fila.id_negocio);
  return {
    ...fila,
    importe_usd: importeUsd ? importeUsd.importe : 0,
    importe_mxn: importeMxn ? importeMxn.importe : 0,
    estatus: await estatusNegocio(fila.id_negocio),
    tiene_tarea_activa: Boolean(tienePendiente),
  };
}

// Version en lote de negocioConImportes: dos consultas para todos los negocios en vez de
// dos por negocio (evita N+1 viajes de red).
async function negociosConImportesBatch(filas) {
  const negocioIds = filas.map((f) => f.id_negocio);
  if (!negocioIds.length) return [];

  const [importes, vencimientos, conTarea] = await Promise.all([
    db.prepare(`
      SELECT negocio_id, moneda, SUM(subtotal) AS importe
      FROM cotizaciones WHERE negocio_id = ANY(?)
      GROUP BY negocio_id, moneda
    `).all(negocioIds),
    db.prepare('SELECT negocio_id, fecha_vencimiento FROM cotizaciones WHERE negocio_id = ANY(?)').all(negocioIds),
    db.prepare('SELECT DISTINCT negocio_id FROM pendientes WHERE negocio_id = ANY(?)').all(negocioIds),
  ]);

  const importesPorNegocio = new Map();
  for (const i of importes) {
    if (!importesPorNegocio.has(i.negocio_id)) importesPorNegocio.set(i.negocio_id, {});
    importesPorNegocio.get(i.negocio_id)[i.moneda] = i.importe;
  }
  const vencimientosPorNegocio = new Map();
  for (const v of vencimientos) {
    if (!vencimientosPorNegocio.has(v.negocio_id)) vencimientosPorNegocio.set(v.negocio_id, []);
    vencimientosPorNegocio.get(v.negocio_id).push(v.fecha_vencimiento);
  }
  const idsConTarea = new Set(conTarea.map((f) => f.negocio_id));

  return filas.map((fila) => {
    const importesNegocio = importesPorNegocio.get(fila.id_negocio) || {};
    const vencimientosNegocio = vencimientosPorNegocio.get(fila.id_negocio) || [];
    const estatus = vencimientosNegocio.length === 0
      ? 'Vigente'
      : (vencimientosNegocio.every((v) => estatusCotizacion(v) === 'Vencido') ? 'Vencido' : 'Vigente');
    return {
      ...fila,
      importe_usd: importesNegocio.USD || 0,
      importe_mxn: importesNegocio.MXN || 0,
      estatus,
      tiene_tarea_activa: idsConTarea.has(fila.id_negocio),
    };
  });
}

app.get('/api/negocios', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const negocios = req.session.esAdmin
    ? await db.prepare(`${SELECT_NEGOCIOS} ORDER BY n.creado_en DESC`).all()
    : await db.prepare(`${SELECT_NEGOCIOS} WHERE n.usuario_id = ? ORDER BY n.creado_en DESC`).all(req.session.usuarioId);
  res.json(await negociosConImportesBatch(negocios));
}));

app.post('/api/negocios', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const negocio = (req.body.negocio || '').trim();
  if (!negocio) return res.status(400).json({ errores: ['negocio es requerido'] });
  if (!(await referenciaPropia('contactos', 'id_contacto', req.body.contacto_id, req))) {
    return res.status(400).json({ errores: ['El contacto seleccionado no existe'] });
  }

  const id = await generarIdNegocio();
  await db.prepare(`
    INSERT INTO negocios (id_negocio, negocio, contacto_id, etapa_id, motivo_perdida, usuario_id, fecha_estimada_cierre) VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, negocio, req.body.contacto_id || null, req.body.etapa_id || null, (req.body.motivo_perdida || '').trim() || null,
    req.session.usuarioId, req.body.fecha_estimada_cierre || null
  );

  res.status(201).json(await negocioConImportes(await db.prepare(`${SELECT_NEGOCIOS} WHERE n.id_negocio = ?`).get(id)));
}));

app.put('/api/negocios/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM negocios WHERE id_negocio = ?').get(req.params.id);
  if (!existente || !esDueno(existente, req)) return res.status(404).json({ error: 'Negocio no encontrado' });

  const negocio = (req.body.negocio || '').trim();
  if (!negocio) return res.status(400).json({ errores: ['negocio es requerido'] });
  if (!(await referenciaPropia('contactos', 'id_contacto', req.body.contacto_id, req))) {
    return res.status(400).json({ errores: ['El contacto seleccionado no existe'] });
  }

  await db.prepare(`
    UPDATE negocios SET negocio = ?, contacto_id = ?, etapa_id = ?, motivo_perdida = ?, fecha_estimada_cierre = ? WHERE id_negocio = ?
  `).run(
    negocio, req.body.contacto_id || null, req.body.etapa_id || null, (req.body.motivo_perdida || '').trim() || null,
    req.body.fecha_estimada_cierre || null, req.params.id
  );

  res.json(await negocioConImportes(await db.prepare(`${SELECT_NEGOCIOS} WHERE n.id_negocio = ?`).get(req.params.id)));
}));

// Borrar un negocio SI se permite aunque tenga cotizaciones: es la unica forma de eliminar su
// ultima cotizacion, ya que un negocio no puede quedarse sin ninguna (ver DELETE /api/cotizaciones).
// Al borrar el negocio se borran tambien todas sus cotizaciones (y sus partidas, en cascada).
app.delete('/api/negocios/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const negocio = await db.prepare('SELECT * FROM negocios WHERE id_negocio = ?').get(req.params.id);
  if (!negocio || !esDueno(negocio, req)) return res.status(404).json({ error: 'Negocio no encontrado' });

  await transaction(async (db) => {
    await db.prepare('DELETE FROM cotizaciones WHERE negocio_id = ?').run(req.params.id);
    await db.prepare('DELETE FROM negocios WHERE id_negocio = ?').run(req.params.id);
  });

  res.status(204).end();
}));

// Notas de seguimiento de un negocio: bitacora de solo agregar (sin editar/borrar), sin
// limite de longitud, cada una con su fecha y hora de captura.
app.get('/api/negocios/:id/notas', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const negocio = await db.prepare('SELECT * FROM negocios WHERE id_negocio = ?').get(req.params.id);
  if (!negocio || !esDueno(negocio, req)) return res.status(404).json({ error: 'Negocio no encontrado' });

  const notas = await db.prepare(`
    SELECT * FROM negocio_notas WHERE negocio_id = ? ORDER BY creado_en DESC, id DESC
  `).all(req.params.id);
  res.json(notas);
}));

app.post('/api/negocios/:id/notas', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const nota = (req.body.nota || '').trim();
  if (!nota) return res.status(400).json({ errores: ['nota es requerida'] });

  const negocio = await db.prepare('SELECT * FROM negocios WHERE id_negocio = ?').get(req.params.id);
  if (!negocio || !esDueno(negocio, req)) return res.status(404).json({ error: 'Negocio no encontrado' });

  const info = await db.prepare('INSERT INTO negocio_notas (negocio_id, nota) VALUES (?, ?)').run(req.params.id, nota);
  res.status(201).json(await db.prepare('SELECT * FROM negocio_notas WHERE id = ?').get(info.lastInsertRowid));
}));

// ---------- Cotizaciones ----------
// Regla: una cotizacion usa una sola moneda para todas sus partidas. El Precio Unitario de
// cada partida se sugiere desde el Catalogo de Productos (precio_usd o precio_mxn segun la
// moneda de la cotizacion) pero se puede editar libremente en la captura.

const SELECT_COTIZACIONES = `
  SELECT q.*, n.negocio AS negocio_nombre, TRIM(c.nombre || ' ' || COALESCE(c.apellido, '')) AS contacto_nombre,
    c.correo_electronico AS contacto_correo, d.destino AS destino_nombre,
    r.representante AS representante_nombre, r.correo_electronico AS representante_correo, r.celular AS representante_celular,
    r.firma AS representante_firma
  FROM cotizaciones q
  LEFT JOIN negocios n ON n.id_negocio = q.negocio_id
  LEFT JOIN contactos c ON c.id_contacto = q.contacto_id
  LEFT JOIN destinos d ON d.id_destino = q.destino_id
  LEFT JOIN representantes r ON r.id_representante = q.representante_id
`;

// Estatus de una cotizacion: "Vencido" si hoy es posterior a su Fecha de vencimiento,
// "Vigente" en cualquier otro caso (incluida una cotizacion sin vencimiento capturado).
function estatusCotizacion(fechaVencimiento) {
  if (!fechaVencimiento) return 'Vigente';
  const hoy = new Date().toISOString().slice(0, 10);
  return hoy > fechaVencimiento ? 'Vencido' : 'Vigente';
}

function conEstatus(fila) {
  return { ...fila, estatus: estatusCotizacion(fila.fecha_vencimiento) };
}

async function itemsDeCotizacion(cotizacionId) {
  const filas = await db.prepare(`
    SELECT ci.*, p.descripcion AS producto_descripcion
    FROM cotizacion_items ci
    LEFT JOIN productos p ON p.item = ci.producto_item
    WHERE ci.cotizacion_id = ?
    ORDER BY ci.id
  `).all(cotizacionId);
  return filas.map((it) => ({ ...it, total: it.cantidad * it.precio_unitario }));
}

async function cotizacionConDetalle(id) {
  const cabecera = await db.prepare(`${SELECT_COTIZACIONES} WHERE q.id_cotizacion = ?`).get(id);
  if (!cabecera) return null;
  return { ...conEstatus(cabecera), items: await itemsDeCotizacion(id) };
}

async function validarItems(items) {
  if (!Array.isArray(items) || items.length === 0) return ['Agrega al menos un producto'];
  for (const it of items) {
    if (!it.producto_item) return ['Cada partida debe tener un producto'];
    if (!(await db.prepare('SELECT 1 FROM productos WHERE item = ?').get(it.producto_item))) {
      return [`No existe un producto con el código "${it.producto_item}"`];
    }
    if (!(Number(it.cantidad) > 0)) return ['La cantidad de cada partida debe ser mayor a 0'];
    if (Number(it.precio_unitario) < 0 || Number.isNaN(Number(it.precio_unitario))) {
      return ['El precio unitario de cada partida debe ser un numero valido'];
    }
  }
  return [];
}

// Si TODAS las cotizaciones de un negocio quedan en etapa "Ganada" (y tiene al menos una),
// el negocio avanza automaticamente a la etapa del catalogo cuyo nombre contenga "ganado"
// (ej. "Cierre Ganado"). Es de un solo sentido: no revierte la etapa si despues deja de
// cumplirse la condicion (ej. se agrega una cotizacion nueva en Negociacion).
async function avanzarNegocioSiTodoGanado(db, negocioId) {
  if (!negocioId) return;
  const cotizaciones = await db.prepare('SELECT etapa FROM cotizaciones WHERE negocio_id = ?').all(negocioId);
  if (!cotizaciones.length || !cotizaciones.every((c) => c.etapa === 'Ganada')) return;

  const etapaGanada = await db.prepare("SELECT id_etapa FROM etapas_negocio WHERE etapa ILIKE '%ganado%' ORDER BY id_etapa LIMIT 1").get();
  if (!etapaGanada) return;

  await db.prepare('UPDATE negocios SET etapa_id = ? WHERE id_negocio = ? AND etapa_id IS DISTINCT FROM ?')
    .run(etapaGanada.id_etapa, negocioId, etapaGanada.id_etapa);
}

async function guardarItems(db, cotizacionId, items) {
  await db.prepare('DELETE FROM cotizacion_items WHERE cotizacion_id = ?').run(cotizacionId);
  for (const it of items) {
    await db.prepare(`
      INSERT INTO cotizacion_items (cotizacion_id, producto_item, cantidad, precio_unitario) VALUES (?, ?, ?, ?)
    `).run(cotizacionId, it.producto_item, Number(it.cantidad), Number(it.precio_unitario));
  }
}

app.get('/api/cotizaciones', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const condiciones = [];
  const parametros = [];
  if (req.query.negocio) {
    condiciones.push('q.negocio_id = ?');
    parametros.push(req.query.negocio);
  }
  if (!req.session.esAdmin) {
    condiciones.push('q.usuario_id = ?');
    parametros.push(req.session.usuarioId);
  }
  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const filas = await db.prepare(`${SELECT_COTIZACIONES} ${where} ORDER BY q.creado_en DESC`).all(...parametros);
  res.json(filas.map(conEstatus));
}));

app.get('/api/cotizaciones/:id', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const cotizacion = await cotizacionConDetalle(req.params.id);
  if (!cotizacion || !esDueno(cotizacion, req)) return res.status(404).json({ error: 'Cotizacion no encontrada' });
  res.json(cotizacion);
}));

// Valida los campos de texto de captura libre (Metodo de pago, Lugar y Tiempo de entrega) y
// la Fecha de vencimiento (si se envia, debe ser una fecha AAAA-MM-DD valida).
function validarCamposCotizacion(body) {
  const errores = [];
  if (body.metodo_pago && String(body.metodo_pago).trim().length > 50) {
    errores.push('metodo_pago no puede tener mas de 50 caracteres');
  }
  if (body.lugar_entrega && String(body.lugar_entrega).trim().length > 50) {
    errores.push('lugar_entrega no puede tener mas de 50 caracteres');
  }
  if (body.tiempo_entrega && String(body.tiempo_entrega).trim().length > 50) {
    errores.push('tiempo_entrega no puede tener mas de 50 caracteres');
  }
  if (body.fecha_vencimiento && !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha_vencimiento)) {
    errores.push('fecha_vencimiento debe tener el formato AAAA-MM-DD');
  }
  if (body.fecha_seguimiento && !/^\d{4}-\d{2}-\d{2}$/.test(body.fecha_seguimiento)) {
    errores.push('fecha_seguimiento debe tener el formato AAAA-MM-DD');
  }
  return errores;
}

app.post('/api/cotizaciones', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ errores: ['nombre es requerido'] });
  if (!req.body.negocio_id) return res.status(400).json({ errores: ['negocio es requerido'] });
  if (!['USD', 'MXN'].includes(req.body.moneda)) return res.status(400).json({ errores: ['moneda debe ser USD o MXN'] });
  const etapa = req.body.etapa || 'Negociacion';
  if (!['Negociacion', 'Ganada', 'Perdida'].includes(etapa)) {
    return res.status(400).json({ errores: ['etapa debe ser Negociacion, Ganada o Perdida'] });
  }

  const negocio = await db.prepare('SELECT * FROM negocios WHERE id_negocio = ?').get(req.body.negocio_id);
  if (!negocio || !esDueno(negocio, req)) return res.status(400).json({ errores: ['El negocio seleccionado no existe'] });
  if (!(await referenciaPropia('contactos', 'id_contacto', req.body.contacto_id, req))
    || !(await referenciaPropia('destinos', 'id_destino', req.body.destino_id, req))) {
    return res.status(400).json({ errores: ['El contacto o el hotel/local seleccionado no existe'] });
  }

  const erroresItems = await validarItems(req.body.items);
  if (erroresItems.length) return res.status(400).json({ errores: erroresItems });

  const erroresCampos = validarCamposCotizacion(req.body);
  if (erroresCampos.length) return res.status(400).json({ errores: erroresCampos });

  const { subtotal, descuentoMonto, iva, granTotal } = calcularTotalesCotizacion(req.body.items, req.body.descuento_porcentaje);
  const id = await generarIdCotizacion();

  await transaction(async (db) => {
    await db.prepare(`
      INSERT INTO cotizaciones (
        id_cotizacion, negocio_id, nombre, contacto_id, destino_id, moneda, etapa,
        descuento_porcentaje, subtotal, descuento_monto, iva, gran_total, fecha_creacion,
        fecha_vencimiento, fecha_seguimiento, metodo_pago, lugar_entrega, tiempo_entrega, observaciones,
        usuario_id, representante_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, (CURRENT_DATE)::text, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id, req.body.negocio_id, nombre, req.body.contacto_id || null, req.body.destino_id || null, req.body.moneda, etapa,
      Number(req.body.descuento_porcentaje) || 0, subtotal, descuentoMonto, iva, granTotal,
      req.body.fecha_vencimiento || null,
      req.body.fecha_seguimiento || null,
      (req.body.metodo_pago || '').trim() || null,
      (req.body.lugar_entrega || '').trim() || null,
      (req.body.tiempo_entrega || '').trim() || null,
      (req.body.observaciones || '').trim() || null,
      req.session.usuarioId,
      req.body.representante_id || null
    );
    await guardarItems(db, id, req.body.items);
    await avanzarNegocioSiTodoGanado(db, req.body.negocio_id);
  });

  res.status(201).json(await cotizacionConDetalle(id));
}));

app.put('/api/cotizaciones/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM cotizaciones WHERE id_cotizacion = ?').get(req.params.id);
  if (!existente || !esDueno(existente, req)) return res.status(404).json({ error: 'Cotizacion no encontrada' });

  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ errores: ['nombre es requerido'] });
  if (!req.body.negocio_id) return res.status(400).json({ errores: ['negocio es requerido'] });
  if (!['USD', 'MXN'].includes(req.body.moneda)) return res.status(400).json({ errores: ['moneda debe ser USD o MXN'] });
  const etapa = req.body.etapa || 'Negociacion';
  if (!['Negociacion', 'Ganada', 'Perdida'].includes(etapa)) {
    return res.status(400).json({ errores: ['etapa debe ser Negociacion, Ganada o Perdida'] });
  }

  const negocio = await db.prepare('SELECT * FROM negocios WHERE id_negocio = ?').get(req.body.negocio_id);
  if (!negocio || !esDueno(negocio, req)) return res.status(400).json({ errores: ['El negocio seleccionado no existe'] });
  if (!(await referenciaPropia('contactos', 'id_contacto', req.body.contacto_id, req))
    || !(await referenciaPropia('destinos', 'id_destino', req.body.destino_id, req))) {
    return res.status(400).json({ errores: ['El contacto o el hotel/local seleccionado no existe'] });
  }

  const erroresItems = await validarItems(req.body.items);
  if (erroresItems.length) return res.status(400).json({ errores: erroresItems });

  const erroresCampos = validarCamposCotizacion(req.body);
  if (erroresCampos.length) return res.status(400).json({ errores: erroresCampos });

  const { subtotal, descuentoMonto, iva, granTotal } = calcularTotalesCotizacion(req.body.items, req.body.descuento_porcentaje);

  await transaction(async (db) => {
    await db.prepare(`
      UPDATE cotizaciones SET
        negocio_id = ?, nombre = ?, contacto_id = ?, destino_id = ?, moneda = ?, etapa = ?,
        descuento_porcentaje = ?, subtotal = ?, descuento_monto = ?, iva = ?, gran_total = ?,
        fecha_vencimiento = ?, fecha_seguimiento = ?, metodo_pago = ?, lugar_entrega = ?,
        tiempo_entrega = ?, observaciones = ?, representante_id = ?
      WHERE id_cotizacion = ?
    `).run(
      req.body.negocio_id, nombre, req.body.contacto_id || null, req.body.destino_id || null, req.body.moneda, etapa,
      Number(req.body.descuento_porcentaje) || 0, subtotal, descuentoMonto, iva, granTotal,
      req.body.fecha_vencimiento || null,
      req.body.fecha_seguimiento || null,
      (req.body.metodo_pago || '').trim() || null,
      (req.body.lugar_entrega || '').trim() || null,
      (req.body.tiempo_entrega || '').trim() || null,
      (req.body.observaciones || '').trim() || null,
      req.body.representante_id || null,
      req.params.id
    );
    await guardarItems(db, req.params.id, req.body.items);
    await avanzarNegocioSiTodoGanado(db, req.body.negocio_id);
  });

  res.json(await cotizacionConDetalle(req.params.id));
}));

// Un negocio no puede quedarse sin cotizaciones: si esta es la unica del negocio, no se puede
// borrar aqui (hay que borrar el negocio completo, que se lleva su ultima cotizacion consigo).
app.delete('/api/cotizaciones/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const cotizacion = await db.prepare('SELECT * FROM cotizaciones WHERE id_cotizacion = ?').get(req.params.id);
  if (!cotizacion || !esDueno(cotizacion, req)) return res.status(404).json({ error: 'Cotizacion no encontrada' });

  const totalDelNegocioFila = await db.prepare('SELECT COUNT(*) c FROM cotizaciones WHERE negocio_id = ?').get(cotizacion.negocio_id);
  if (Number(totalDelNegocioFila.c) <= 1) {
    return res.status(400).json({
      errores: ['No se puede borrar: es la única cotización de este negocio. Borra el negocio si deseas eliminarla.'],
    });
  }

  await transaction(async (db) => {
    await db.prepare('DELETE FROM cotizaciones WHERE id_cotizacion = ?').run(req.params.id);
    await avanzarNegocioSiTodoGanado(db, cotizacion.negocio_id);
  });
  res.status(204).end();
}));

// Mismos datos de emisor/empresa que usa la vista HTML de "Ver" (cotizaciones.js,
// EMISOR_COTIZACION), para que el PDF descargado se vea consistente con esa vista.
const EMISOR_COTIZACION = {
  nombre: 'Ramón Villanueva',
  puesto: 'Ventas',
  correo: 'rvillanueva@gonpal.com.mx',
  telefono: '+528183660778',
  empresa: 'Comercializadora Gonpal',
  direccion: 'Calle Tauro 205, Nueva Linda Vista, Guadalupe, N.L. 67110, México',
};

const MESES_LARGO_PDF = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function fechaLargaPdf(fechaISO) {
  if (!fechaISO) return '-';
  const [y, m, d] = fechaISO.split('-').map(Number);
  return `${d} de ${MESES_LARGO_PDF[m - 1]} de ${y}`;
}

function referenciaCotizacionPdf(cotizacion) {
  const digitos = String(cotizacion.creado_en || '').replace(/\D/g, '');
  return digitos ? `${digitos}000` : cotizacion.id_cotizacion;
}

function formatoMoneda(valor) {
  const n = Number(valor) || 0;
  return `$${n.toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// Genera el documento PDF de una cotizacion y lo transmite directo a la respuesta.
// inline (Ver) muestra el PDF en el navegador; attachment (Descargar) fuerza la descarga.
function generarPdfCotizacion(cotizacion, res, { descargar }) {
  const doc = new PDFDocument({ size: 'LETTER', margin: 50 });
  const nombreArchivo = `${cotizacion.id_cotizacion}.pdf`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${descargar ? 'attachment' : 'inline'}; filename="${nombreArchivo}"`);
  // El PDF se genera al vuelo con los datos actuales de la cotizacion: nunca debe quedar en
  // cache (ni del navegador ni de la red de Vercel), o una edicion posterior no se refleja.
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  doc.pipe(res);

  const rojoGonpal = '#c0392b';
  const inicioTabla = 50;
  const finTabla = 545;

  doc.fontSize(16).font('Helvetica-Bold').fillColor(rojoGonpal).text('GONPAL');
  doc.fillColor('#000');
  doc.moveDown(0.6);
  doc.fontSize(15).font('Helvetica-Bold').text(cotizacion.nombre);
  doc.moveDown(0.4);

  const yInfo = doc.y;
  doc.fontSize(10).font('Helvetica-Bold').text(cotizacion.negocio_nombre || '', inicioTabla, yInfo, { width: 260 });
  doc.font('Helvetica').text(cotizacion.destino_nombre || '', { width: 260 });
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').text(cotizacion.contacto_nombre || '', { width: 260 });
  doc.font('Helvetica').text(cotizacion.contacto_correo || '', { width: 260 });

  doc.fontSize(9).font('Helvetica').fillColor('#333');
  doc.text(`Referencia: ${referenciaCotizacionPdf(cotizacion)}`, 340, yInfo, { width: 205, align: 'right' });
  doc.text(`Creación: ${fechaLargaPdf(cotizacion.fecha_creacion)}`, { width: 205, align: 'right' });
  doc.text(`Caducidad: ${fechaLargaPdf(cotizacion.fecha_vencimiento)}`, { width: 205, align: 'right' });
  doc.text(`Presupuesto por: ${cotizacion.representante_nombre || EMISOR_COTIZACION.nombre}`, { width: 205, align: 'right' });
  doc.text(cotizacion.representante_correo || EMISOR_COTIZACION.correo, { width: 205, align: 'right' });
  doc.fillColor('#000');

  doc.y = Math.max(doc.y, yInfo + 90);
  doc.moveDown(0.8);

  doc.font('Helvetica-Bold').fontSize(10).text('Comentarios');
  doc.font('Helvetica').fontSize(9);
  doc.text(`Cotización basada en: ${cotizacion.moneda}`);
  if (cotizacion.metodo_pago) doc.text(`Condiciones de pago: ${cotizacion.metodo_pago}`);
  if (cotizacion.lugar_entrega) doc.text(`Lugar de envío: ${cotizacion.lugar_entrega}`);
  if (cotizacion.tiempo_entrega) doc.text(`Tiempo de entrega: ${cotizacion.tiempo_entrega}`);
  if (cotizacion.observaciones) {
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#000').text('Observaciones:');
    // La clausula de "reportar daño en 24 horas" se resalta en rojo/negrita/mas grande que el
    // resto del texto, sin importar en que parte de Observaciones venga escrita.
    const CLAUSULA_DANIO_24H = /mercanc[ií]a con da[ñn]o debe reportarse/i;
    for (const linea of cotizacion.observaciones.split('\n')) {
      if (CLAUSULA_DANIO_24H.test(linea)) {
        doc.font('Helvetica-Bold').fontSize(11).fillColor(rojoGonpal).text(linea);
      } else {
        doc.font('Helvetica').fontSize(9).fillColor('#000').text(linea);
      }
    }
    doc.fillColor('#000');
  }
  doc.moveDown(0.8);

  const columnas = [
    { etiqueta: 'Producto', ancho: 195 },
    { etiqueta: 'Cant.', ancho: 60 },
    { etiqueta: 'P. Unitario', ancho: 120 },
    { etiqueta: 'Total', ancho: 120 },
  ];

  function encabezadoTabla() {
    let x = inicioTabla;
    const y = doc.y;
    doc.font('Helvetica-Bold').fontSize(9);
    for (const c of columnas) { doc.text(c.etiqueta, x, y, { width: c.ancho, align: c.etiqueta === 'Producto' ? 'left' : 'right' }); x += c.ancho; }
    doc.y = y + 14;
    doc.moveTo(inicioTabla, doc.y).lineTo(finTabla, doc.y).strokeColor('#333').lineWidth(1).stroke();
    doc.moveDown(0.3);
  }

  encabezadoTabla();
  doc.font('Helvetica').fontSize(9);
  for (const it of cotizacion.items) {
    if (doc.y > 660) { doc.addPage(); encabezadoTabla(); }
    const y = doc.y;
    let x = inicioTabla;
    doc.font('Helvetica-Bold').text(it.producto_item || '', x, y, { width: columnas[0].ancho });
    if (it.producto_descripcion) {
      doc.font('Helvetica').fontSize(8).fillColor('#666').text(it.producto_descripcion, x, doc.y, { width: columnas[0].ancho });
      doc.fillColor('#000').fontSize(9);
    }
    const yFilaFinal = doc.y;
    x += columnas[0].ancho;
    doc.font('Helvetica').text(String(it.cantidad), x, y, { width: columnas[1].ancho, align: 'right' });
    x += columnas[1].ancho;
    doc.text(formatoMoneda(it.precio_unitario), x, y, { width: columnas[2].ancho, align: 'right' });
    x += columnas[2].ancho;
    doc.text(formatoMoneda(it.total), x, y, { width: columnas[3].ancho, align: 'right' });
    doc.y = Math.max(yFilaFinal, y + 12);
    doc.moveDown(0.5);
    doc.moveTo(inicioTabla, doc.y).lineTo(finTabla, doc.y).strokeColor('#eee').lineWidth(0.5).stroke();
    doc.moveDown(0.3);
  }

  doc.moveDown(0.5);
  const anchoTotales = 220;
  const xTotales = finTabla - anchoTotales;
  doc.fontSize(9).font('Helvetica');
  doc.text(`Subtotal: ${formatoMoneda(cotizacion.subtotal)}`, xTotales, doc.y, { width: anchoTotales, align: 'right' });
  if (Number(cotizacion.descuento_monto) > 0) {
    doc.text(`Descuento (${cotizacion.descuento_porcentaje}%): -${formatoMoneda(cotizacion.descuento_monto)}`, xTotales, doc.y, { width: anchoTotales, align: 'right' });
  }
  doc.text(`IVA (16%): ${formatoMoneda(cotizacion.iva)}`, xTotales, doc.y, { width: anchoTotales, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(11).text(`Total: ${formatoMoneda(cotizacion.gran_total)}`, xTotales, doc.y, { width: anchoTotales, align: 'right' });

  doc.moveDown(1.5);
  doc.fontSize(7.5).font('Helvetica-Bold').text('Condiciones de compra');
  doc.font('Helvetica').fillColor('#444').text(
    'NOTA: TODA NUESTRA MERCANCÍA ESTA ASEGURADA EN TRANSPORTE, CUALQUIER INCIDENCIA SE DEBE REPORTAR EN LAS PRIMERAS '
    + '24 HORAS DE LA RECEPCIÓN PARA APLICAR EL SEGURO YA QUE DE LO CONTRARIO EL TRANSPORTE DEJA DE HACERSE RESPONSABLE.'
  );
  doc.fillColor('#000');

  if (doc.y > 680) doc.addPage();
  doc.moveDown(1);
  doc.fontSize(9).font('Helvetica-Bold').text('¿Tienes alguna pregunta? Ponte en contacto conmigo');
  doc.font('Helvetica').fontSize(9);
  // La firma del representante seleccionado (texto libre, tal cual la capturo) reemplaza el
  // bloque fijo de Ramon Villanueva/Gonpal cuando esta capturada; si no, se usa ese bloque como
  // respaldo para no dejar el pie de la cotizacion en blanco.
  const lineasFirma = (cotizacion.representante_firma || '').trim()
    ? cotizacion.representante_firma.split('\n').map((l) => l.trim()).filter(Boolean)
    : [EMISOR_COTIZACION.nombre, EMISOR_COTIZACION.puesto, EMISOR_COTIZACION.correo, EMISOR_COTIZACION.telefono, EMISOR_COTIZACION.empresa, EMISOR_COTIZACION.direccion];
  lineasFirma.forEach((linea) => doc.text(linea));
  doc.fillColor('#000');

  doc.end();
}

app.get('/api/cotizaciones/:id/pdf', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const cotizacion = await cotizacionConDetalle(req.params.id);
  if (!cotizacion || !esDueno(cotizacion, req)) return res.status(404).json({ error: 'Cotizacion no encontrada' });
  generarPdfCotizacion(cotizacion, res, { descargar: req.query.descargar === '1' });
}));

// ---------- Ordenes ----------

const SELECT_ORDENES = `
  SELECT o.*, d.destino AS destino_nombre, TRIM(c.nombre || ' ' || COALESCE(c.apellido, '')) AS contacto_nombre,
    ec.estatus AS estatus_nombre, ee.estado_entrega AS estado_entrega_nombre,
    EXISTS(SELECT 1 FROM pendientes p WHERE p.orden_id = o.id) AS tiene_tarea_activa
  FROM ordenes o
  LEFT JOIN destinos d ON d.id_destino = o.destino_id
  LEFT JOIN contactos c ON c.id_contacto = o.contacto_id
  LEFT JOIN estatus_catalogo ec ON ec.id_estatus = o.estatus_id
  LEFT JOIN estados_entrega ee ON ee.id_estado_entrega = o.estado_entrega_id
`;

function validarOrden(body, { parcial = false } = {}) {
  const errores = [];
  const {
    id, fecha, destino_id, contacto_id, moneda, importe, importe_moneda_extranjera,
    estatus_id, estado_entrega_id,
  } = body;

  if (!parcial) {
    if (typeof id !== 'string' || id.trim() === '') errores.push('id es requerido y debe ser texto no vacio');
    if (typeof fecha !== 'string' || fecha.trim() === '') errores.push('fecha es requerida');
  }

  if (destino_id !== undefined && enteroOpcional(destino_id) === undefined) {
    errores.push('destino_id debe ser un numero entero');
  }
  if (contacto_id !== undefined && enteroOpcional(contacto_id) === undefined) {
    errores.push('contacto_id debe ser un numero entero');
  }
  if (estatus_id !== undefined && enteroOpcional(estatus_id) === undefined) {
    errores.push('estatus_id debe ser un numero entero');
  }
  if (estado_entrega_id !== undefined && enteroOpcional(estado_entrega_id) === undefined) {
    errores.push('estado_entrega_id debe ser un numero entero');
  }
  if (moneda !== undefined && textoOpcional(moneda, 5) === undefined) {
    errores.push('moneda debe ser texto de maximo 5 caracteres');
  }
  if (importe !== undefined && numeroOpcional(importe) === undefined) errores.push('importe debe ser numerico');
  if (importe_moneda_extranjera !== undefined && numeroOpcional(importe_moneda_extranjera) === undefined) {
    errores.push('importe_moneda_extranjera debe ser numerico');
  }

  return errores;
}

app.get('/api/ordenes', requirePermiso('ordenes', 'ver'), ar(async (req, res) => {
  const { q, estatus } = req.query;
  const condiciones = [];
  const parametros = [];

  if (q) {
    condiciones.push(`(
      o.id ILIKE ? OR o.nombre ILIKE ? OR o.numero_oc ILIKE ? OR d.destino ILIKE ?
      OR o.id IN (SELECT id FROM detalle_de_compra WHERE articulo ILIKE ?)
    )`);
    parametros.push(`%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`, `%${q}%`);
  }
  if (estatus) {
    const ids = String(estatus).split(',').map((v) => v.trim()).filter(Boolean);
    if (ids.length) {
      condiciones.push(`o.estatus_id IN (${ids.map(() => '?').join(',')})`);
      parametros.push(...ids);
    }
  }

  const where = condiciones.length ? `WHERE ${condiciones.join(' AND ')}` : '';
  const rows = await db.prepare(`${SELECT_ORDENES} ${where} ORDER BY o.fecha DESC`).all(...parametros);
  res.json(rows);
}));

app.get('/api/ordenes/:id', requirePermiso('ordenes', 'ver'), ar(async (req, res) => {
  const row = await db.prepare(`${SELECT_ORDENES} WHERE o.id = ?`).get(req.params.id);
  if (!row) return res.status(404).json({ error: 'Orden no encontrada' });
  res.json(row);
}));

app.post('/api/ordenes', requirePermiso('ordenes', 'editar'), ar(async (req, res) => {
  const errores = validarOrden(req.body);
  if (errores.length) return res.status(400).json({ errores });

  const b = req.body;
  const idLimpio = quitarAcentos(b.id.trim());
  const existente = await db.prepare('SELECT id FROM ordenes WHERE id = ?').get(idLimpio);
  if (existente) return res.status(400).json({ errores: ['Ya existe una orden con ese ID'] });

  await db.prepare(`
    INSERT INTO ordenes (
      id, fecha, imprimir, nombre, numero_oc, estatus_sistema, numero_seguimiento, nota,
      moneda, importe_moneda_extranjera, importe, estatus_id, observaciones,
      destino_id, contacto_id, estado_entrega_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    idLimpio, normalizarFecha(b.fecha), quitarAcentos(b.imprimir) || null, quitarAcentos(b.nombre) || null, quitarAcentos(b.numero_oc) || null,
    quitarAcentos(b.estatus_sistema) || null, quitarAcentos(b.numero_seguimiento) || null, quitarAcentos(b.nota) || null,
    textoOpcional(quitarAcentos(b.moneda), 5), numeroOpcional(b.importe_moneda_extranjera), numeroOpcional(b.importe),
    enteroOpcional(b.estatus_id), quitarAcentos(b.observaciones) || null,
    enteroOpcional(b.destino_id), enteroOpcional(b.contacto_id), enteroOpcional(b.estado_entrega_id)
  );

  res.status(201).json(await db.prepare(`${SELECT_ORDENES} WHERE o.id = ?`).get(idLimpio));
}));

app.put('/api/ordenes/:id', requirePermiso('ordenes', 'editar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM ordenes WHERE id = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Orden no encontrada' });

  const errores = validarOrden(req.body, { parcial: true });
  if (errores.length) return res.status(400).json({ errores });

  const b = req.body;
  const campo = (nombre, transform = quitarAcentos) => (b[nombre] !== undefined ? transform(b[nombre]) : existente[nombre]);

  await db.prepare(`
    UPDATE ordenes SET
      fecha = ?, imprimir = ?, nombre = ?, numero_oc = ?, estatus_sistema = ?, numero_seguimiento = ?, nota = ?,
      moneda = ?, importe_moneda_extranjera = ?, importe = ?, estatus_id = ?, observaciones = ?,
      destino_id = ?, contacto_id = ?, estado_entrega_id = ?
    WHERE id = ?
  `).run(
    campo('fecha', normalizarFecha), campo('imprimir'), campo('nombre'), campo('numero_oc'), campo('estatus_sistema'),
    campo('numero_seguimiento'), campo('nota'),
    campo('moneda', (v) => textoOpcional(quitarAcentos(v), 5)), campo('importe_moneda_extranjera', numeroOpcional), campo('importe', numeroOpcional),
    campo('estatus_id', enteroOpcional), campo('observaciones'),
    campo('destino_id', enteroOpcional), campo('contacto_id', enteroOpcional), campo('estado_entrega_id', enteroOpcional),
    req.params.id
  );

  res.json(await db.prepare(`${SELECT_ORDENES} WHERE o.id = ?`).get(req.params.id));
}));

app.delete('/api/ordenes/:id', requirePermiso('ordenes', 'borrar'), ar(async (req, res) => {
  const info = await db.prepare('DELETE FROM ordenes WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Orden no encontrada' });
  res.status(204).end();
}));

// Carga inicial masiva por CSV. Columnas esperadas (encabezado, sin importar mayusculas):
// id, fecha, imprimir, nombre, numero_oc, estatus_sistema, numero_seguimiento, nota,
// moneda, importe_moneda_extranjera, importe, estatus, observaciones, destino, contacto, empresa, estado_entrega
// "destino" y "contacto" van como texto; si no existen en su catalogo se crean automaticamente.
// Si "destino" trae "empresa", esa empresa se agrega al catalogo de ese destino (sin duplicar).
app.post('/api/ordenes/importar-csv', requirePermiso('ordenes', 'editar'), ar(async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) {
    return res.status(400).json({ error: 'Envia el contenido del CSV como texto (Content-Type: text/csv)' });
  }

  const registros = filasCsvAObjetos(parsearCSV(req.body));

  const resultado = await transaction(async (db) => {
    const destinosCreados = new Set();
    const contactosCreados = new Set();
    const empresasAgregadas = new Set();
    const estatusCreados = new Set();
    const estadosEntregaCreados = new Set();
    const errores = [];
    let insertadas = 0;
    let actualizadas = 0;

    async function obtenerOCrearDestino(nombre) {
      const limpio = nombre.trim();
      if (!limpio) return null;
      const existente = await db.prepare('SELECT id_destino FROM destinos WHERE destino = ?').get(limpio);
      if (existente) return existente.id_destino;
      const info = await db.prepare('INSERT INTO destinos (destino) VALUES (?)').run(limpio);
      destinosCreados.add(limpio);
      return info.lastInsertRowid;
    }

    async function obtenerOCrearContacto(nombre) {
      const limpio = nombre.trim();
      if (!limpio) return null;
      const existente = await db.prepare('SELECT id_contacto FROM contactos WHERE nombre = ?').get(limpio);
      if (existente) return existente.id_contacto;
      const info = await db.prepare("INSERT INTO contactos (id_publico, nombre, creado_en) VALUES (?, ?, to_char(now(), 'YYYY-MM-DD HH24:MI:SS'))").run(await generarIdContacto(), limpio);
      contactosCreados.add(limpio);
      return info.lastInsertRowid;
    }

    async function agregarEmpresaSiNoExiste(destinoId, empresa) {
      const limpio = (empresa || '').trim();
      if (!limpio || !destinoId) return;
      const empresaId = await obtenerOCrearEmpresa(limpio, db);
      const existente = await db.prepare('SELECT id FROM destino_empresas WHERE destino_id = ? AND empresa_id = ?').get(destinoId, empresaId);
      if (!existente) {
        await db.prepare('INSERT INTO destino_empresas (destino_id, empresa_id) VALUES (?, ?)').run(destinoId, empresaId);
        empresasAgregadas.add(limpio);
      }
    }

    async function obtenerOCrearEstatus(nombre) {
      const limpio = nombre.trim();
      if (!limpio) return null;
      const existente = await db.prepare('SELECT id_estatus FROM estatus_catalogo WHERE estatus = ?').get(limpio);
      if (existente) return existente.id_estatus;
      const info = await db.prepare('INSERT INTO estatus_catalogo (estatus) VALUES (?)').run(limpio);
      estatusCreados.add(limpio);
      return info.lastInsertRowid;
    }

    async function obtenerOCrearEstadoEntrega(nombre) {
      const limpio = nombre.trim();
      if (!limpio) return null;
      const existente = await db.prepare('SELECT id_estado_entrega FROM estados_entrega WHERE estado_entrega = ?').get(limpio);
      if (existente) return existente.id_estado_entrega;
      const info = await db.prepare('INSERT INTO estados_entrega (estado_entrega) VALUES (?)').run(limpio);
      estadosEntregaCreados.add(limpio);
      return info.lastInsertRowid;
    }

    for (let indice = 0; indice < registros.length; indice++) {
      const registro = registros[indice];
      const numeroFila = indice + 2; // +1 por encabezado, +1 por indice base 1
      try {
        if (!registro.id) throw new Error('id es requerido');
        if (!registro.fecha) throw new Error('fecha es requerida');

        const moneda = textoOpcional(registro.moneda, 5);
        if (moneda === undefined) throw new Error('moneda debe ser texto de maximo 5 caracteres');
        const importeMonedaExtranjera = registro.importe_moneda_extranjera
          ? numeroOpcional(registro.importe_moneda_extranjera) : null;
        if (importeMonedaExtranjera === undefined) throw new Error('importe_moneda_extranjera debe ser numerico');
        const importe = registro.importe ? numeroOpcional(registro.importe) : null;
        if (importe === undefined) throw new Error('importe debe ser numerico');

        const yaExiste = Boolean(await db.prepare('SELECT id FROM ordenes WHERE id = ?').get(registro.id));
        const estatusId = registro.estatus ? await obtenerOCrearEstatus(registro.estatus) : null;

        if (yaExiste) {
          await db.prepare(`
            UPDATE ordenes SET
              fecha = @fecha, imprimir = @imprimir, nombre = @nombre, numero_oc = @numero_oc,
              estatus_sistema = @estatus_sistema, numero_seguimiento = @numero_seguimiento, nota = @nota,
              moneda = @moneda, importe_moneda_extranjera = @importe_moneda_extranjera, importe = @importe,
              estatus_id = @estatus_id
            WHERE id = @id
          `).run({
            id: registro.id,
            fecha: normalizarFecha(registro.fecha),
            imprimir: registro.imprimir || null,
            nombre: registro.nombre || null,
            numero_oc: registro.numero_oc || null,
            estatus_sistema: registro.estatus_sistema || null,
            numero_seguimiento: registro.numero_seguimiento || null,
            nota: registro.nota || null,
            moneda,
            importe_moneda_extranjera: importeMonedaExtranjera,
            importe,
            estatus_id: estatusId,
          });
          actualizadas++;
        } else {
          const destinoId = registro.destino ? await obtenerOCrearDestino(registro.destino) : null;
          const contactoId = registro.contacto ? await obtenerOCrearContacto(registro.contacto) : null;
          const estadoEntregaId = registro.estado_entrega ? await obtenerOCrearEstadoEntrega(registro.estado_entrega) : null;
          if (destinoId && registro.empresa) await agregarEmpresaSiNoExiste(destinoId, registro.empresa);

          await db.prepare(`
            INSERT INTO ordenes (
              id, fecha, imprimir, nombre, numero_oc, estatus_sistema, numero_seguimiento, nota,
              moneda, importe_moneda_extranjera, importe, estatus_id, observaciones,
              destino_id, contacto_id, estado_entrega_id
            ) VALUES (
              @id, @fecha, @imprimir, @nombre, @numero_oc, @estatus_sistema, @numero_seguimiento, @nota,
              @moneda, @importe_moneda_extranjera, @importe, @estatus_id, @observaciones,
              @destino_id, @contacto_id, @estado_entrega_id
            )
          `).run({
            id: registro.id,
            fecha: normalizarFecha(registro.fecha),
            imprimir: registro.imprimir || null,
            nombre: registro.nombre || null,
            numero_oc: registro.numero_oc || null,
            estatus_sistema: registro.estatus_sistema || null,
            numero_seguimiento: registro.numero_seguimiento || null,
            nota: registro.nota || null,
            moneda,
            importe_moneda_extranjera: importeMonedaExtranjera,
            importe,
            estatus_id: estatusId,
            observaciones: registro.observaciones || null,
            destino_id: destinoId,
            contacto_id: contactoId,
            estado_entrega_id: estadoEntregaId,
          });
          insertadas++;
        }
      } catch (e) {
        errores.push({ fila: numeroFila, id: registro.id || '(sin id)', error: e.message });
      }
    }

    return {
      insertadas, actualizadas, errores,
      destinosCreados: [...destinosCreados], contactosCreados: [...contactosCreados],
      empresasAgregadas: [...empresasAgregadas], estatusCreados: [...estatusCreados],
      estadosEntregaCreados: [...estadosEntregaCreados],
    };
  });

  res.json({ total: registros.length, ...resultado });
}));

// ---------- Integracion con Google Tasks ----------
//
// Sincroniza las Tareas (pendientes) del CRM con una sola lista de Google Tasks compartida
// (una unica cuenta de Google autoriza el acceso, ver /api/google-tasks/conectar). La Tasks API
// de Google no tiene webhooks/notificaciones push, asi que el sentido CRM->Google es inmediato
// (al crear/editar/borrar un pendiente) y el sentido Google->CRM se resuelve bajo demanda via
// POST /api/pendientes/sincronizar-google (se llama al abrir Tareas y con el boton "Sincronizar").
// Borrar un pendiente en el CRM (= ya se resolvio) marca la tarea como completada en Google, no la
// borra. Completar una tarea en Google (o borrarla) se traduce a borrar el pendiente en el CRM.
// Tareas creadas directo en Google (sin pasar por el CRM) se ignoran: un pendiente del CRM
// requiere Negocio y Actividades, datos que esas tareas no tienen.

const GOOGLE_TASKS_SCOPE = 'https://www.googleapis.com/auth/tasks';
const GOOGLE_TASKS_NOMBRE_LISTA = 'CRM-ON';

function googleTasksConfigurado() {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

function googleRedirectUri(req) {
  return `${req.protocol}://${req.get('host')}/api/google-tasks/callback`;
}

async function obtenerConexionGoogle() {
  return db.prepare('SELECT * FROM google_tasks_conexion WHERE id = 1').get();
}

// Devuelve un access_token vigente (lo refresca si esta por expirar). null si no hay conexion.
async function accessTokenGoogleValido() {
  const conexion = await obtenerConexionGoogle();
  if (!conexion || !conexion.refresh_token) return null;

  const expiraEn = conexion.token_expira_en ? new Date(conexion.token_expira_en).getTime() : 0;
  if (conexion.access_token && expiraEn > Date.now() + 60000) return conexion.access_token;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      refresh_token: conexion.refresh_token,
      grant_type: 'refresh_token',
    }),
  });
  if (!resp.ok) {
    console.error('No se pudo refrescar el token de Google Tasks:', await resp.text().catch(() => ''));
    return null;
  }
  const datos = await resp.json();
  const expiraEnNueva = new Date(Date.now() + datos.expires_in * 1000);
  await db.prepare('UPDATE google_tasks_conexion SET access_token = ?, token_expira_en = ? WHERE id = 1')
    .run(datos.access_token, expiraEnNueva.toISOString());
  return datos.access_token;
}

async function googleTasksApi(metodo, ruta, cuerpo) {
  const token = await accessTokenGoogleValido();
  if (!token) return null;
  const resp = await fetch(`https://tasks.googleapis.com/tasks/v1${ruta}`, {
    method: metodo,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: cuerpo ? JSON.stringify(cuerpo) : undefined,
  });
  if (resp.status === 404 || resp.status === 410) return { noEncontrada: true };
  if (!resp.ok) {
    console.error(`Google Tasks API ${metodo} ${ruta} -> ${resp.status}:`, await resp.text().catch(() => ''));
    return null;
  }
  if (resp.status === 204) return {};
  return resp.json();
}

function fechaLimiteGoogle(fechaCompromiso) {
  return fechaCompromiso ? `${fechaCompromiso}T00:00:00.000Z` : null;
}

function notasTareaGoogle(pendiente) {
  const actividades = (pendiente.actividades || []).map((a) => a.actividad).join(', ');
  return `Sincronizado desde CRM-ON (ID ${pendiente.id_pendiente})${actividades ? `\nActividades: ${actividades}` : ''}`;
}

// Las siguientes tres funciones son "best-effort": si Google no esta conectado o la llamada
// falla, no deben interrumpir el flujo normal del CRM (solo queda sin sincronizar esa tarea).

async function sincronizarCreacionPendienteGoogle(pendiente) {
  const conexion = await obtenerConexionGoogle();
  if (!conexion || !conexion.tasklist_id) return;
  try {
    const tarea = await googleTasksApi('POST', `/lists/${conexion.tasklist_id}/tasks`, {
      title: pendiente.nombre,
      notes: notasTareaGoogle(pendiente),
      due: fechaLimiteGoogle(pendiente.fecha_compromiso),
    });
    if (tarea && tarea.id) {
      await db.prepare('UPDATE pendientes SET google_task_id = ? WHERE id_pendiente = ?').run(tarea.id, pendiente.id_pendiente);
    }
  } catch (e) {
    console.error('No se pudo crear la tarea en Google Tasks:', e);
  }
}

async function sincronizarEdicionPendienteGoogle(pendiente) {
  if (!pendiente.google_task_id) return sincronizarCreacionPendienteGoogle(pendiente);
  const conexion = await obtenerConexionGoogle();
  if (!conexion || !conexion.tasklist_id) return;
  try {
    await googleTasksApi('PATCH', `/lists/${conexion.tasklist_id}/tasks/${pendiente.google_task_id}`, {
      title: pendiente.nombre,
      notes: notasTareaGoogle(pendiente),
      due: fechaLimiteGoogle(pendiente.fecha_compromiso),
    });
  } catch (e) {
    console.error('No se pudo actualizar la tarea en Google Tasks:', e);
  }
}

async function sincronizarBorradoPendienteGoogle(googleTaskId) {
  if (!googleTaskId) return;
  const conexion = await obtenerConexionGoogle();
  if (!conexion || !conexion.tasklist_id) return;
  try {
    await googleTasksApi('PATCH', `/lists/${conexion.tasklist_id}/tasks/${googleTaskId}`, { status: 'completed' });
  } catch (e) {
    console.error('No se pudo marcar como completada la tarea en Google Tasks:', e);
  }
}

app.get('/api/google-tasks/estado', requireAdmin, ar(async (req, res) => {
  const conexion = await obtenerConexionGoogle();
  res.json({
    disponible: googleTasksConfigurado(),
    conectado: Boolean(conexion && conexion.refresh_token),
    conectadoPor: conexion?.conectado_por || null,
    conectadoEn: conexion?.conectado_en || null,
  });
}));

app.get('/api/google-tasks/conectar', requireAdmin, (req, res) => {
  if (!googleTasksConfigurado()) {
    return res.status(400).send('Google Tasks no esta configurado (faltan las variables de entorno GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).');
  }
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleOauthState = state;
  const params = new URLSearchParams({
    client_id: process.env.GOOGLE_CLIENT_ID,
    redirect_uri: googleRedirectUri(req),
    response_type: 'code',
    scope: GOOGLE_TASKS_SCOPE,
    access_type: 'offline',
    prompt: 'consent',
    state,
  });
  res.redirect(`https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`);
});

app.get('/api/google-tasks/callback', requireAdmin, ar(async (req, res) => {
  const { code, state, error } = req.query;
  if (error) return res.redirect('/configuracion.html?google_tasks=error');
  if (!code || !state || state !== req.session.googleOauthState) {
    return res.status(400).send('Solicitud invalida (state no coincide).');
  }
  delete req.session.googleOauthState;

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: process.env.GOOGLE_CLIENT_ID,
      client_secret: process.env.GOOGLE_CLIENT_SECRET,
      code,
      grant_type: 'authorization_code',
      redirect_uri: googleRedirectUri(req),
    }),
  });
  if (!resp.ok) {
    console.error('Error al intercambiar el codigo de Google:', await resp.text().catch(() => ''));
    return res.redirect('/configuracion.html?google_tasks=error');
  }
  const datos = await resp.json();
  const expiraEn = new Date(Date.now() + datos.expires_in * 1000);

  await db.prepare(`
    INSERT INTO google_tasks_conexion (id, access_token, refresh_token, token_expira_en, conectado_por, conectado_en)
    VALUES (1, ?, ?, ?, ?, now())
    ON CONFLICT (id) DO UPDATE SET
      access_token = EXCLUDED.access_token,
      refresh_token = COALESCE(EXCLUDED.refresh_token, google_tasks_conexion.refresh_token),
      token_expira_en = EXCLUDED.token_expira_en,
      conectado_por = EXCLUDED.conectado_por,
      conectado_en = now()
  `).run(datos.access_token, datos.refresh_token || null, expiraEn.toISOString(), req.session.usuario || null);

  const listas = await googleTasksApi('GET', '/users/@me/lists');
  let lista = listas?.items?.find((l) => l.title === GOOGLE_TASKS_NOMBRE_LISTA);
  if (!lista) lista = await googleTasksApi('POST', '/users/@me/lists', { title: GOOGLE_TASKS_NOMBRE_LISTA });
  if (lista && lista.id) {
    await db.prepare('UPDATE google_tasks_conexion SET tasklist_id = ? WHERE id = 1').run(lista.id);
  }

  res.redirect('/configuracion.html?google_tasks=ok');
}));

app.post('/api/google-tasks/desconectar', requireAdmin, ar(async (req, res) => {
  await db.prepare('DELETE FROM google_tasks_conexion WHERE id = 1').run();
  res.status(204).end();
}));

// Sentido Google -> CRM: revisa cada pendiente ya enlazado a una tarea de Google; si esa tarea
// esta completada o ya no existe, borra el pendiente del CRM (se considera resuelto).
app.post('/api/pendientes/sincronizar-google', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const conexion = await obtenerConexionGoogle();
  if (!conexion || !conexion.tasklist_id) return res.json({ conectado: false, eliminados: [], exportados: 0 });

  // Push: pendientes que todavia no tienen tarea en Google (creados antes de conectar, o cuando
  // la conexion estaba caida) se exportan ahora.
  const pendientesSinGoogle = await db.prepare(
    'SELECT id_pendiente FROM pendientes WHERE google_task_id IS NULL'
  ).all();
  for (const p of pendientesSinGoogle) {
    await sincronizarCreacionPendienteGoogle(await pendienteConActividades(p.id_pendiente));
  }

  // Pull: pendientes ya enlazados cuya tarea en Google ya se completo o se borro, se dan por
  // resueltos y se borran del CRM. IMPORTANTE: si la consulta a Google falla por cualquier otro
  // motivo (red, rate limit, token, etc.) NO se borra nada; "no se pudo verificar" nunca debe
  // tratarse como "ya se resolvio" (un bug anterior aqui borro tareas reales por esta confusion).
  const pendientesConGoogle = await db.prepare(
    'SELECT id_pendiente, nombre, google_task_id FROM pendientes WHERE google_task_id IS NOT NULL'
  ).all();

  const eliminados = [];
  for (const p of pendientesConGoogle) {
    const tarea = await googleTasksApi('GET', `/lists/${conexion.tasklist_id}/tasks/${p.google_task_id}`);
    if (!tarea) continue; // no se pudo verificar el estado: se deja intacta, no se asume nada.
    const resuelta = tarea.noEncontrada || tarea.status === 'completed';
    if (resuelta) {
      await db.prepare('DELETE FROM pendientes WHERE id_pendiente = ?').run(p.id_pendiente);
      eliminados.push({ id_pendiente: p.id_pendiente, nombre: p.nombre });
    }
  }
  res.json({ conectado: true, eliminados, exportados: pendientesSinGoogle.length });
}));

// ---------- Tareas: Actividades (catalogo) y Pendientes ----------

app.get('/api/actividades', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  res.json(await db.prepare('SELECT * FROM actividades ORDER BY actividad').all());
}));

app.post('/api/actividades', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const actividad = quitarAcentos((req.body.actividad || '').trim());
  if (!actividad) return res.status(400).json({ errores: ['actividad es requerida'] });

  try {
    const info = await db.prepare('INSERT INTO actividades (actividad) VALUES (?)').run(actividad);
    res.status(201).json(await db.prepare('SELECT * FROM actividades WHERE id_actividad = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ errores: ['Esa actividad ya existe'] });
  }
}));

app.put('/api/actividades/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const actividad = quitarAcentos((req.body.actividad || '').trim());
  if (!actividad) return res.status(400).json({ errores: ['actividad es requerida'] });

  const existente = await db.prepare('SELECT * FROM actividades WHERE id_actividad = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Actividad no encontrada' });

  try {
    await db.prepare('UPDATE actividades SET actividad = ? WHERE id_actividad = ?').run(actividad, req.params.id);
    res.json(await db.prepare('SELECT * FROM actividades WHERE id_actividad = ?').get(req.params.id));
  } catch (e) {
    res.status(400).json({ errores: ['Esa actividad ya existe'] });
  }
}));

app.delete('/api/actividades/:id', requirePermiso('catalogos', 'borrar'), ar(async (req, res) => {
  const info = await db.prepare('DELETE FROM actividades WHERE id_actividad = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Actividad no encontrada' });
  res.status(204).end();
}));

async function actividadesDePendiente(pendienteId) {
  return db.prepare(`
    SELECT a.id_actividad, a.actividad FROM pendiente_actividades pa
    JOIN actividades a ON a.id_actividad = pa.actividad_id
    WHERE pa.pendiente_id = ?
    ORDER BY a.actividad
  `).all(pendienteId);
}

async function pendienteConActividades(id) {
  const p = await db.prepare('SELECT * FROM pendientes WHERE id_pendiente = ?').get(id);
  if (!p) return null;
  return { ...p, actividades: await actividadesDePendiente(id) };
}

async function reemplazarActividadesPendiente(pendienteId, actividadIds) {
  await db.prepare('DELETE FROM pendiente_actividades WHERE pendiente_id = ?').run(pendienteId);
  for (const actividadId of actividadIds || []) {
    if (actividadId) {
      await db.prepare('INSERT INTO pendiente_actividades (pendiente_id, actividad_id) VALUES (?, ?) ON CONFLICT (pendiente_id, actividad_id) DO NOTHING').run(pendienteId, actividadId);
    }
  }
}

async function contarNotasPendiente(pendienteId) {
  const fila = await db.prepare('SELECT COUNT(*) c FROM pendiente_notas WHERE pendiente_id = ?').get(pendienteId);
  return Number(fila.c);
}

// Versiones en lote de actividadesDePendiente/contarNotasPendiente: evita N+1 al listar.
async function actividadesDePendientesBatch(pendienteIds) {
  const mapa = new Map();
  if (!pendienteIds.length) return mapa;
  const filas = await db.prepare(`
    SELECT pa.pendiente_id, a.id_actividad, a.actividad FROM pendiente_actividades pa
    JOIN actividades a ON a.id_actividad = pa.actividad_id
    WHERE pa.pendiente_id = ANY(?)
    ORDER BY a.actividad
  `).all(pendienteIds);
  for (const f of filas) {
    if (!mapa.has(f.pendiente_id)) mapa.set(f.pendiente_id, []);
    mapa.get(f.pendiente_id).push({ id_actividad: f.id_actividad, actividad: f.actividad });
  }
  return mapa;
}

async function conteosNotasPendientesBatch(pendienteIds) {
  const mapa = new Map();
  if (!pendienteIds.length) return mapa;
  const filas = await db.prepare('SELECT pendiente_id, COUNT(*) c FROM pendiente_notas WHERE pendiente_id = ANY(?) GROUP BY pendiente_id').all(pendienteIds);
  for (const f of filas) mapa.set(f.pendiente_id, Number(f.c));
  return mapa;
}

app.get('/api/pendientes', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const pendientes = await db.prepare('SELECT * FROM pendientes ORDER BY fecha_compromiso IS NULL, fecha_compromiso, nombre').all();
  const pendienteIds = pendientes.map((p) => p.id_pendiente);
  const [actividadesPorPendiente, notasPorPendiente] = await Promise.all([
    actividadesDePendientesBatch(pendienteIds),
    conteosNotasPendientesBatch(pendienteIds),
  ]);
  res.json(pendientes.map((p) => ({
    ...p,
    actividades: actividadesPorPendiente.get(p.id_pendiente) || [],
    tiene_notas: (notasPorPendiente.get(p.id_pendiente) || 0) > 0,
  })));
}));

// Llamada, Correo Electronico y Mensaje de Texto son actividades de comunicacion: siempre
// deben quedar ligadas a un Contacto o un Hotel/Local, para que se puedan ver despues en el
// historial de ese catalogo (no se checa por ID de actividad porque esos IDs no son fijos,
// se busca por nombre normalizado).
const ACTIVIDADES_COMUNICACION = ['llamada', 'correo electronico', 'mensaje de texto'];

async function esActividadDeComunicacion(actividadIds) {
  if (!actividadIds || !actividadIds.length) return false;
  const filas = await db.prepare('SELECT actividad FROM actividades WHERE id_actividad = ANY(?)').all(actividadIds);
  return filas.some((f) => ACTIVIDADES_COMUNICACION.includes(quitarAcentos(f.actividad || '').toLowerCase()));
}

app.post('/api/pendientes', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ errores: ['nombre es requerido'] });
  if (!Array.isArray(req.body.actividades) || req.body.actividades.length === 0) {
    return res.status(400).json({ errores: ['Selecciona al menos una actividad'] });
  }
  if (!(await referenciaPropia('negocios', 'id_negocio', req.body.negocio_id, req))) {
    return res.status(400).json({ errores: ['El negocio seleccionado no existe'] });
  }
  if (req.body.orden_id && !(await db.prepare('SELECT 1 FROM ordenes WHERE id = ?').get(req.body.orden_id))) {
    return res.status(400).json({ errores: ['La orden seleccionada no existe'] });
  }
  if (!(await referenciaPropia('contactos', 'id_contacto', req.body.contacto_id, req))) {
    return res.status(400).json({ errores: ['El contacto seleccionado no existe'] });
  }
  if (!(await referenciaPropia('destinos', 'id_destino', req.body.destino_id, req))) {
    return res.status(400).json({ errores: ['El hotel/local seleccionado no existe'] });
  }
  if (!req.body.contacto_id && !req.body.destino_id && await esActividadDeComunicacion(req.body.actividades)) {
    return res.status(400).json({ errores: ['Para Llamada, Correo Electrónico o Mensaje de Texto, selecciona un Contacto o un Hotel/Local'] });
  }

  const id = await generarIdPendiente();
  await db.prepare(`
    INSERT INTO pendientes (id_pendiente, nombre, fecha_compromiso, negocio_id, orden_id, contacto_id, destino_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, nombre, req.body.fecha_compromiso || null, req.body.negocio_id || null, req.body.orden_id || null,
    req.body.contacto_id || null, req.body.destino_id || null
  );
  await reemplazarActividadesPendiente(id, req.body.actividades);
  const pendiente = await pendienteConActividades(id);
  await sincronizarCreacionPendienteGoogle(pendiente);
  res.status(201).json(await pendienteConActividades(id));
}));

app.put('/api/pendientes/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT id_pendiente FROM pendientes WHERE id_pendiente = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Pendiente no encontrado' });

  const nombre = (req.body.nombre || '').trim();
  if (!nombre) return res.status(400).json({ errores: ['nombre es requerido'] });
  if (!Array.isArray(req.body.actividades) || req.body.actividades.length === 0) {
    return res.status(400).json({ errores: ['Selecciona al menos una actividad'] });
  }
  if (!(await referenciaPropia('contactos', 'id_contacto', req.body.contacto_id, req))) {
    return res.status(400).json({ errores: ['El contacto seleccionado no existe'] });
  }
  if (!(await referenciaPropia('destinos', 'id_destino', req.body.destino_id, req))) {
    return res.status(400).json({ errores: ['El hotel/local seleccionado no existe'] });
  }
  if (!req.body.contacto_id && !req.body.destino_id && await esActividadDeComunicacion(req.body.actividades)) {
    return res.status(400).json({ errores: ['Para Llamada, Correo Electrónico o Mensaje de Texto, selecciona un Contacto o un Hotel/Local'] });
  }

  await db.prepare(`
    UPDATE pendientes SET nombre = ?, fecha_compromiso = ?, contacto_id = ?, destino_id = ? WHERE id_pendiente = ?
  `).run(nombre, req.body.fecha_compromiso || null, req.body.contacto_id || null, req.body.destino_id || null, req.params.id);
  await reemplazarActividadesPendiente(req.params.id, req.body.actividades);
  const pendiente = await pendienteConActividades(req.params.id);
  await sincronizarEdicionPendienteGoogle(pendiente);
  res.json(await pendienteConActividades(req.params.id));
}));

app.delete('/api/pendientes/:id', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT google_task_id FROM pendientes WHERE id_pendiente = ?').get(req.params.id);
  if (!existente) return res.status(404).json({ error: 'Pendiente no encontrado' });
  await db.prepare('DELETE FROM pendientes WHERE id_pendiente = ?').run(req.params.id);
  await sincronizarBorradoPendienteGoogle(existente.google_task_id);
  res.status(204).end();
}));

// Notas de seguimiento de una tarea: bitacora de solo agregar (sin editar/borrar), sin
// limite de longitud, cada una con su fecha y hora de captura.
app.get('/api/pendientes/:id/notas', requirePermiso('catalogos', 'ver'), ar(async (req, res) => {
  const notas = await db.prepare(`
    SELECT * FROM pendiente_notas WHERE pendiente_id = ? ORDER BY creado_en DESC, id DESC
  `).all(req.params.id);
  res.json(notas);
}));

app.post('/api/pendientes/:id/notas', requirePermiso('catalogos', 'editar'), ar(async (req, res) => {
  const nota = (req.body.nota || '').trim();
  if (!nota) return res.status(400).json({ errores: ['nota es requerida'] });

  const pendiente = await db.prepare('SELECT id_pendiente FROM pendientes WHERE id_pendiente = ?').get(req.params.id);
  if (!pendiente) return res.status(404).json({ error: 'Pendiente no encontrado' });

  const info = await db.prepare('INSERT INTO pendiente_notas (pendiente_id, nota) VALUES (?, ?)').run(req.params.id, nota);
  res.status(201).json(await db.prepare('SELECT * FROM pendiente_notas WHERE id = ?').get(info.lastInsertRowid));
}));

// ---------- Reportes ----------

// Cantidades por Hotel (destino) + Articulo, para ordenes en un estatus determinado
// (por defecto "Pendiente" si existe en el catalogo). Filtro opcional por texto de articulo.
app.get('/api/reportes/articulos', requirePermiso('ordenes', 'ver'), ar(async (req, res) => {
  const { estatus, articulo, hotel } = req.query;

  let estatusIds;
  if (estatus !== undefined) {
    estatusIds = String(estatus).split(',').map((v) => v.trim()).filter(Boolean);
  } else {
    const pendiente = await db.prepare("SELECT id_estatus FROM estatus_catalogo WHERE estatus = 'Pendiente'").get();
    estatusIds = pendiente ? [String(pendiente.id_estatus)] : [];
  }

  const condiciones = ["dc.articulo IS NOT NULL", "dc.articulo != ''"];
  const parametros = [];

  if (estatusIds.length) {
    condiciones.push(`o.estatus_id IN (${estatusIds.map(() => '?').join(',')})`);
    parametros.push(...estatusIds);
  }
  if (articulo) {
    condiciones.push('dc.articulo ILIKE ?');
    parametros.push(`%${articulo}%`);
  }
  if (hotel) {
    condiciones.push('d.destino ILIKE ?');
    parametros.push(`%${hotel}%`);
  }

  const where = `WHERE ${condiciones.join(' AND ')}`;
  const filas = await db.prepare(`
    SELECT
      d.destino AS hotel,
      dc.articulo,
      SUM(dc.cantidad_vendida) AS cantidad_total,
      SUM(dc.importe) AS importe_total,
      COUNT(DISTINCT dc.id) AS num_ordenes
    FROM detalle_de_compra dc
    JOIN ordenes o ON o.id = dc.id
    LEFT JOIN destinos d ON d.id_destino = o.destino_id
    ${where}
    GROUP BY d.destino, dc.articulo
    ORDER BY d.destino, dc.articulo
  `).all(...parametros);

  res.json({ estatusUsados: estatusIds, filas });
}));

// Ordenes que forman una combinacion Hotel+Articulo del reporte anterior (para mostrarlas como tarjetas).
app.get('/api/reportes/ordenes', requirePermiso('ordenes', 'ver'), ar(async (req, res) => {
  const { hotel, articulo, estatus } = req.query;
  if (!articulo) return res.status(400).json({ error: 'articulo es requerido' });

  let estatusIds;
  if (estatus !== undefined) {
    estatusIds = String(estatus).split(',').map((v) => v.trim()).filter(Boolean);
  } else {
    const pendiente = await db.prepare("SELECT id_estatus FROM estatus_catalogo WHERE estatus = 'Pendiente'").get();
    estatusIds = pendiente ? [String(pendiente.id_estatus)] : [];
  }

  const condiciones = ['dc.articulo = ?'];
  const parametros = [articulo];

  if (hotel) {
    condiciones.push('d.destino = ?');
    parametros.push(hotel);
  } else {
    condiciones.push('o.destino_id IS NULL');
  }

  if (estatusIds.length) {
    condiciones.push(`o.estatus_id IN (${estatusIds.map(() => '?').join(',')})`);
    parametros.push(...estatusIds);
  }

  const where = `WHERE ${condiciones.join(' AND ')}`;
  const rows = await db.prepare(`
    SELECT DISTINCT o.*, d.destino AS destino_nombre, TRIM(c.nombre || ' ' || COALESCE(c.apellido, '')) AS contacto_nombre,
      ec.estatus AS estatus_nombre, ee.estado_entrega AS estado_entrega_nombre
    FROM ordenes o
    JOIN detalle_de_compra dc ON dc.id = o.id
    LEFT JOIN destinos d ON d.id_destino = o.destino_id
    LEFT JOIN contactos c ON c.id_contacto = o.contacto_id
    LEFT JOIN estatus_catalogo ec ON ec.id_estatus = o.estatus_id
    LEFT JOIN estados_entrega ee ON ee.id_estado_entrega = o.estado_entrega_id
    ${where}
    ORDER BY o.fecha DESC
  `).all(...parametros);

  res.json(rows);
}));

// ---------- Detalle de compra ----------
// "id" enlaza con ordenes.id pero NO es unico aqui: una orden puede tener varios articulos.

const SELECT_DETALLE = `
  SELECT dc.*, o.nombre AS orden_nombre, o.fecha AS orden_fecha
  FROM detalle_de_compra dc
  LEFT JOIN ordenes o ON o.id = dc.id
`;

function validarDetalle(body, { parcial = false } = {}) {
  const errores = [];
  const { id, cantidad_vendida, importe } = body;

  if (!parcial && (typeof id !== 'string' || id.trim() === '')) {
    errores.push('id es requerido y debe ser texto no vacio');
  }
  if (cantidad_vendida !== undefined && numeroOpcional(cantidad_vendida) === undefined) {
    errores.push('cantidad_vendida debe ser numerico');
  }
  if (importe !== undefined && numeroOpcional(importe) === undefined) {
    errores.push('importe debe ser numerico');
  }

  return errores;
}

app.get('/api/detalle-compra', requirePermiso('detalle_compra', 'ver'), ar(async (req, res) => {
  const { id, q } = req.query;
  let rows;
  if (id) {
    rows = await db.prepare(`${SELECT_DETALLE} WHERE dc.id = ? ORDER BY dc.id_detalle_compra`).all(id);
  } else if (q) {
    rows = await db.prepare(`${SELECT_DETALLE} WHERE dc.id ILIKE ? OR dc.articulo ILIKE ? OR dc.numero_serie ILIKE ? ORDER BY dc.fecha DESC`)
      .all(`%${q}%`, `%${q}%`, `%${q}%`);
  } else {
    rows = await db.prepare(`${SELECT_DETALLE} ORDER BY dc.fecha DESC`).all();
  }
  res.json(rows);
}));

app.get('/api/detalle-compra/:idDetalle', requirePermiso('detalle_compra', 'ver'), ar(async (req, res) => {
  const row = await db.prepare(`${SELECT_DETALLE} WHERE dc.id_detalle_compra = ?`).get(req.params.idDetalle);
  if (!row) return res.status(404).json({ error: 'Detalle no encontrado' });
  res.json(row);
}));

app.post('/api/detalle-compra', requirePermiso('detalle_compra', 'editar'), ar(async (req, res) => {
  const errores = validarDetalle(req.body);
  if (errores.length) return res.status(400).json({ errores });

  const b = req.body;
  const info = await db.prepare(`
    INSERT INTO detalle_de_compra (id, articulo, tipo, fecha, numero_serie, cantidad_vendida, importe)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    quitarAcentos(b.id.trim()),
    quitarAcentos(b.articulo) || null,
    quitarAcentos(b.tipo) || null,
    normalizarFecha(b.fecha) || null,
    quitarAcentos(b.numero_serie) || null,
    numeroOpcional(b.cantidad_vendida),
    numeroOpcional(b.importe)
  );

  res.status(201).json(await db.prepare(`${SELECT_DETALLE} WHERE dc.id_detalle_compra = ?`).get(info.lastInsertRowid));
}));

app.put('/api/detalle-compra/:idDetalle', requirePermiso('detalle_compra', 'editar'), ar(async (req, res) => {
  const existente = await db.prepare('SELECT * FROM detalle_de_compra WHERE id_detalle_compra = ?').get(req.params.idDetalle);
  if (!existente) return res.status(404).json({ error: 'Detalle no encontrado' });

  const errores = validarDetalle(req.body, { parcial: true });
  if (errores.length) return res.status(400).json({ errores });

  const b = req.body;
  const campo = (nombre, transform = quitarAcentos) => (b[nombre] !== undefined ? transform(b[nombre]) : existente[nombre]);

  await db.prepare(`
    UPDATE detalle_de_compra SET
      id = ?, articulo = ?, tipo = ?, fecha = ?, numero_serie = ?, cantidad_vendida = ?, importe = ?
    WHERE id_detalle_compra = ?
  `).run(
    campo('id'), campo('articulo'), campo('tipo'), campo('fecha', normalizarFecha), campo('numero_serie'),
    campo('cantidad_vendida', numeroOpcional), campo('importe', numeroOpcional),
    req.params.idDetalle
  );

  res.json(await db.prepare(`${SELECT_DETALLE} WHERE dc.id_detalle_compra = ?`).get(req.params.idDetalle));
}));

app.delete('/api/detalle-compra/:idDetalle', requirePermiso('detalle_compra', 'borrar'), ar(async (req, res) => {
  const info = await db.prepare('DELETE FROM detalle_de_compra WHERE id_detalle_compra = ?').run(req.params.idDetalle);
  if (info.changes === 0) return res.status(404).json({ error: 'Detalle no encontrado' });
  res.status(204).end();
}));

// Carga masiva por CSV. Columnas esperadas: id, articulo, tipo, fecha, numero_serie, cantidad_vendida, importe.
// "id" no es unico: cada fila se inserta (una orden puede repetirse con varios articulos).
app.post('/api/detalle-compra/importar-csv', requirePermiso('detalle_compra', 'editar'), ar(async (req, res) => {
  if (typeof req.body !== 'string' || !req.body.trim()) {
    return res.status(400).json({ error: 'Envia el contenido del CSV como texto (Content-Type: text/csv)' });
  }

  const registros = filasCsvAObjetos(parsearCSV(req.body));

  const resultado = await transaction(async (db) => {
    const errores = [];
    let insertadas = 0;

    for (let indice = 0; indice < registros.length; indice++) {
      const registro = registros[indice];
      const numeroFila = indice + 2;
      try {
        if (!registro.id) throw new Error('id es requerido');

        const cantidadVendida = registro.cantidad_vendida ? numeroOpcional(registro.cantidad_vendida) : null;
        if (cantidadVendida === undefined) throw new Error('cantidad_vendida debe ser numerico');
        const importe = registro.importe ? numeroOpcional(registro.importe) : null;
        if (importe === undefined) throw new Error('importe debe ser numerico');

        await db.prepare(`
          INSERT INTO detalle_de_compra (id, articulo, tipo, fecha, numero_serie, cantidad_vendida, importe)
          VALUES (@id, @articulo, @tipo, @fecha, @numero_serie, @cantidad_vendida, @importe)
        `).run({
          id: registro.id,
          articulo: registro.articulo || null,
          tipo: registro.tipo || null,
          fecha: registro.fecha ? normalizarFecha(registro.fecha) : null,
          numero_serie: registro.numero_serie || null,
          cantidad_vendida: cantidadVendida,
          importe,
        });

        insertadas++;
      } catch (e) {
        errores.push({ fila: numeroFila, id: registro.id || '(sin id)', error: e.message });
      }
    }

    return { insertadas, errores };
  });

  res.json({ total: registros.length, ...resultado });
}));

// ---------- Buscador global ----------
// Busca por nombre de Contacto, Destino o ID/nombre de Orden, y regresa junto con cada
// coincidencia todos sus registros asociados (ordenes, cotizaciones, negocios).
app.get('/api/buscar-global', ar(async (req, res) => {
  if (!req.session.usuarioId) return res.status(401).json({ error: 'No autenticado' });
  if (!req.session.esAdmin) {
    const permisos = await permisosDe(req.session.usuarioId, false);
    if (!permisos.ordenes.ver && !permisos.catalogos.ver) {
      return res.status(403).json({ error: 'No tienes permiso para esta accion' });
    }
  }

  const q = (req.query.q || '').trim();
  if (q.length < 2) return res.json({ contactos: [], destinos: [], ordenes: [], productos: [], plazas: [], grupos: [], cadenas: [] });
  const like = `%${q}%`;
  const soloPropios = !req.session.esAdmin;

  const contactos = soloPropios
    ? await db.prepare(`
        SELECT * FROM contactos
        WHERE usuario_id = ? AND (nombre ILIKE ? OR apellido ILIKE ? OR correo_electronico ILIKE ? OR id_publico ILIKE ?)
        ORDER BY nombre, apellido
      `).all(req.session.usuarioId, like, like, like, like)
    : await db.prepare(`
        SELECT * FROM contactos
        WHERE nombre ILIKE ? OR apellido ILIKE ? OR correo_electronico ILIKE ? OR id_publico ILIKE ?
        ORDER BY nombre, apellido
      `).all(like, like, like, like);

  const destinos = soloPropios
    ? await db.prepare('SELECT * FROM destinos WHERE usuario_id = ? AND destino ILIKE ? ORDER BY destino').all(req.session.usuarioId, like)
    : await db.prepare('SELECT * FROM destinos WHERE destino ILIKE ? ORDER BY destino').all(like);

  // Plaza/Grupo/Cadena son catalogos compartidos (sin usuario_id), igual que Productos: no se
  // filtran por dueno.
  const plazas = await db.prepare(`
    SELECT e.id_empresa, e.empresa, COUNT(de.id) AS destinos_asociados
    FROM empresas e LEFT JOIN destino_empresas de ON de.empresa_id = e.id_empresa
    WHERE e.empresa ILIKE ?
    GROUP BY e.id_empresa
    ORDER BY e.empresa
  `).all(like);
  const grupos = await db.prepare(`
    SELECT g.id_grupo, g.grupo, COUNT(dg.id) AS destinos_asociados
    FROM grupos g LEFT JOIN destino_grupos dg ON dg.grupo_id = g.id_grupo
    WHERE g.grupo ILIKE ?
    GROUP BY g.id_grupo
    ORDER BY g.grupo
  `).all(like);
  const cadenas = await db.prepare(`
    SELECT c.id_cadena, c.cadena, COUNT(dc.id) AS destinos_asociados
    FROM cadenas c LEFT JOIN destino_cadenas dc ON dc.cadena_id = c.id_cadena
    WHERE c.cadena ILIKE ?
    GROUP BY c.id_cadena
    ORDER BY c.cadena
  `).all(like);

  const ordenes = await db.prepare(`${SELECT_ORDENES} WHERE o.id ILIKE ? OR o.nombre ILIKE ? ORDER BY o.creado_en DESC`).all(like, like);

  const productos = await db.prepare(`${SELECT_PRODUCTOS} WHERE p.item ILIKE ? OR p.descripcion ILIKE ? ORDER BY p.item`).all(like, like);

  const contactosConRegistros = await Promise.all(contactos.map(async (c) => ({
    ...c,
    nombre_completo: [c.nombre, c.apellido].filter(Boolean).join(' '),
    ordenes: await db.prepare(`${SELECT_ORDENES} WHERE o.contacto_id = ? ORDER BY o.creado_en DESC`).all(c.id_contacto),
    cotizaciones: (await db.prepare(`${SELECT_COTIZACIONES} WHERE q.contacto_id = ? ORDER BY q.creado_en DESC`).all(c.id_contacto)).map(conEstatus),
    negocios: await negociosConImportesBatch(await db.prepare(`${SELECT_NEGOCIOS} WHERE n.contacto_id = ? ORDER BY n.creado_en DESC`).all(c.id_contacto)),
  })));

  const destinosConRegistros = await Promise.all(destinos.map(async (d) => ({
    ...d,
    ordenes: await db.prepare(`${SELECT_ORDENES} WHERE o.destino_id = ? ORDER BY o.creado_en DESC`).all(d.id_destino),
    cotizaciones: (await db.prepare(`${SELECT_COTIZACIONES} WHERE q.destino_id = ? ORDER BY q.creado_en DESC`).all(d.id_destino)).map(conEstatus),
    contactos: (await db.prepare(`
      SELECT c.* FROM contacto_destinos cd JOIN contactos c ON c.id_contacto = cd.contacto_id WHERE cd.destino_id = ?
      ORDER BY c.nombre, c.apellido
    `).all(d.id_destino)).map((c) => ({ ...c, nombre_completo: [c.nombre, c.apellido].filter(Boolean).join(' ') })),
  })));

  // Historial de un producto: en que cotizaciones se ha incluido (por producto_item, exacto) y
  // en que ordenes aparece en Detalle de compra (por texto de Articulo, coincidencia aproximada
  // ya que ese campo es libre y no esta ligado al catalogo de Productos).
  const productosConHistorial = await Promise.all(productos.map(async (p) => ({
    ...p,
    // El historial de cotizaciones de un producto solo muestra las propias (o todas si admin):
    // aunque el producto es compartido, el detalle de cada cotizacion es privado de su dueno.
    cotizaciones: soloPropios
      ? await db.prepare(`
          SELECT ci.cantidad, ci.precio_unitario, q.id_cotizacion, q.nombre, q.fecha_creacion, q.moneda, q.etapa,
            n.negocio AS negocio_nombre
          FROM cotizacion_items ci
          JOIN cotizaciones q ON q.id_cotizacion = ci.cotizacion_id
          LEFT JOIN negocios n ON n.id_negocio = q.negocio_id
          WHERE ci.producto_item = ? AND q.usuario_id = ?
          ORDER BY q.creado_en DESC
        `).all(p.item, req.session.usuarioId)
      : await db.prepare(`
          SELECT ci.cantidad, ci.precio_unitario, q.id_cotizacion, q.nombre, q.fecha_creacion, q.moneda, q.etapa,
            n.negocio AS negocio_nombre
          FROM cotizacion_items ci
          JOIN cotizaciones q ON q.id_cotizacion = ci.cotizacion_id
          LEFT JOIN negocios n ON n.id_negocio = q.negocio_id
          WHERE ci.producto_item = ?
          ORDER BY q.creado_en DESC
        `).all(p.item),
    ventas: await db.prepare(`
      SELECT dc.*, o.nombre AS orden_nombre
      FROM detalle_de_compra dc
      LEFT JOIN ordenes o ON o.id = dc.id
      WHERE dc.articulo ILIKE ?
      ORDER BY dc.fecha DESC
    `).all(`%${p.item}%`),
  })));

  res.json({ contactos: contactosConRegistros, destinos: destinosConRegistros, ordenes, productos: productosConHistorial, plazas, grupos, cadenas });
}));

// ---------- Panel General (pantalla de inicio) ----------
// Cada bloque solo se calcula/incluye si el usuario tiene permiso de ver el modulo del que
// viene (catalogos para Negocios/Cotizaciones, ordenes para Ordenes/Ventas, detalle_compra para
// Top articulos), igual que el resto de la app oculta secciones sin permiso en vez de fallar.
app.get('/api/panel/resumen', ar(async (req, res) => {
  if (!req.session.usuarioId) return res.status(401).json({ error: 'No autenticado' });
  const permisos = await permisosDe(req.session.usuarioId, req.session.esAdmin);
  const soloPropios = !req.session.esAdmin;
  const usuarioId = req.session.usuarioId;
  // CURRENT_DATE de Postgres (zona horaria America/Mexico_City) en vez de new Date() de Node
  // (que siempre es UTC): evita que "hoy" se adelante un dia por la tarde/noche en Mexico.
  const { hoy } = await db.prepare('SELECT (CURRENT_DATE)::text AS hoy').get();
  const inicioMes = `${hoy.slice(0, 7)}-01`;
  const fechaFiltro = (req.query.fecha || hoy).slice(0, 10);
  const resultado = {};

  if (permisos.catalogos.ver) {
    const negocios = soloPropios
      ? await db.prepare(`${SELECT_NEGOCIOS} WHERE n.usuario_id = ?`).all(usuarioId)
      : await db.prepare(SELECT_NEGOCIOS).all();
    const etapasCatalogo = await db.prepare('SELECT id_etapa, etapa FROM etapas_negocio ORDER BY id_etapa').all();
    const conteoPorEtapa = new Map();
    for (const n of negocios) {
      const nombre = n.etapa_nombre || 'Sin etapa';
      conteoPorEtapa.set(nombre, (conteoPorEtapa.get(nombre) || 0) + 1);
    }
    const etapasCierre = ['Cierre Ganado', 'Cierre Perdido'];
    resultado.negociosActivos = negocios.filter((n) => !etapasCierre.includes(n.etapa_nombre)).length;
    resultado.negociosCerradosMes = negocios.filter((n) => etapasCierre.includes(n.etapa_nombre) && (n.creado_en || '') >= inicioMes).length;
    resultado.pipeline = etapasCatalogo.map((e) => ({ etapa: e.etapa, cantidad: conteoPorEtapa.get(e.etapa) || 0 }));

    const cotizaciones = (soloPropios
      ? await db.prepare(`${SELECT_COTIZACIONES} WHERE q.usuario_id = ?`).all(usuarioId)
      : await db.prepare(SELECT_COTIZACIONES).all()
    ).map(conEstatus);
    resultado.cotizacionesVigentes = cotizaciones.filter((c) => c.estatus === 'Vigente').length;
    resultado.cotizacionesPorVencer = cotizaciones
      .filter((c) => c.estatus === 'Vigente' && c.fecha_vencimiento)
      .sort((a, b) => a.fecha_vencimiento.localeCompare(b.fecha_vencimiento))
      .slice(0, 6)
      .map((c) => ({
        id_cotizacion: c.id_cotizacion, nombre: c.nombre, destino_nombre: c.destino_nombre,
        contacto_nombre: c.contacto_nombre, gran_total: c.gran_total, moneda: c.moneda,
        fecha_vencimiento: c.fecha_vencimiento,
      }));

    resultado.tareasHoy = await db.prepare(`
      SELECT id_pendiente, nombre, fecha_compromiso FROM pendientes
      WHERE fecha_compromiso = ? ORDER BY nombre
    `).all(hoy);

    // Cotizaciones del dia (filtro por Fecha de creacion, default hoy): cuantas se hicieron,
    // su importe por moneda (USD y MXN se suman aparte, no se mezclan), y de esas cuantas ya
    // estan en etapa Ganada/Perdida.
    const sumaPorMoneda = (lista, moneda) => lista
      .filter((c) => c.moneda === moneda)
      .reduce((acc, c) => acc + Number(c.gran_total || 0), 0);

    const cotizacionesDelDia = cotizaciones.filter((c) => c.fecha_creacion === fechaFiltro);
    const cotizacionesGanadasDelDia = cotizacionesDelDia.filter((c) => c.etapa === 'Ganada');

    resultado.filtroFecha = fechaFiltro;
    resultado.cotizacionesRealizadas = cotizacionesDelDia.length;
    resultado.cotizacionesRealizadasImporteUsd = sumaPorMoneda(cotizacionesDelDia, 'USD');
    resultado.cotizacionesRealizadasImporteMxn = sumaPorMoneda(cotizacionesDelDia, 'MXN');
    resultado.cotizacionesGanadas = cotizacionesGanadasDelDia.length;
    resultado.cotizacionesGanadasImporteUsd = sumaPorMoneda(cotizacionesGanadasDelDia, 'USD');
    resultado.cotizacionesGanadasImporteMxn = sumaPorMoneda(cotizacionesGanadasDelDia, 'MXN');
    resultado.cotizacionesPerdidas = cotizacionesDelDia.filter((c) => c.etapa === 'Perdida').length;
  }

  if (permisos.ordenes.ver) {
    const enUso = await db.prepare(`
      SELECT COUNT(*) c, COALESCE(SUM(o.importe), 0) ventas
      FROM ordenes o JOIN estatus_catalogo e ON e.id_estatus = o.estatus_id
      WHERE e.estatus = 'Pendiente'
    `).get();
    resultado.ordenesPendientes = Number(enUso.c);
    const ventasMes = await db.prepare('SELECT COALESCE(SUM(importe), 0) ventas FROM ordenes WHERE fecha >= ?').get(inicioMes);
    resultado.ventasMes = Number(ventasMes.ventas);
  }

  if (permisos.detalle_compra.ver) {
    resultado.topArticulos = await db.prepare(`
      SELECT articulo, SUM(cantidad_vendida) AS total
      FROM detalle_de_compra
      WHERE articulo IS NOT NULL AND fecha >= ?
      GROUP BY articulo
      ORDER BY total DESC
      LIMIT 6
    `).all(inicioMes);
  }

  res.json(resultado);
}));

// ---------- Agente de seguimiento proactivo (Vercel Cron, 1x al dia) ----------
// Revisa negocios activos sin actividad reciente y cotizaciones vigentes por vencer, y crea
// una Tarea (actividad "Seguimiento") para que el vendedor la trabaje. No hace nada hacia
// afuera (no llama, no manda correos ni mensajes): las llamadas se siguen haciendo desde el
// telefono y se transcriben a mano, esto solo evita que un negocio se quede sin ver.
const DIAS_SIN_ACTIVIDAD_NEGOCIO = 5;
const DIAS_ANTES_DE_VENCER_COTIZACION = 3;

app.get('/api/cron/seguimiento', ar(async (req, res) => {
  if (!process.env.CRON_SECRET || req.headers.authorization !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }

  const seguimiento = await db.prepare(`SELECT id_actividad FROM actividades WHERE actividad = 'Seguimiento'`).get();
  if (!seguimiento) {
    return res.json({ creadas: [], aviso: 'No existe la actividad "Seguimiento" en Catálogos → Actividades.' });
  }

  const { hoy } = await db.prepare('SELECT (CURRENT_DATE)::text AS hoy').get();
  const fechaDia = (valor) => (valor || '').slice(0, 10);
  const diasDesde = (fecha) => Math.floor((new Date(hoy) - new Date(fecha)) / 86400000);
  const ETAPAS_CIERRE = ['Cierre Ganado', 'Cierre Perdido'];

  const [negocios, cotizaciones, pendientesConNegocio] = await Promise.all([
    db.prepare(SELECT_NEGOCIOS).all(),
    db.prepare(SELECT_COTIZACIONES).all(),
    db.prepare('SELECT negocio_id, creado_en FROM pendientes WHERE negocio_id IS NOT NULL').all(),
  ]);

  const negociosConSeguimientoAbierto = new Set(
    (await db.prepare(`
      SELECT DISTINCT p.negocio_id FROM pendientes p
      JOIN pendiente_actividades pa ON pa.pendiente_id = p.id_pendiente
      WHERE pa.actividad_id = ? AND p.negocio_id IS NOT NULL
    `).all(seguimiento.id_actividad)).map((f) => f.negocio_id)
  );

  const ultimaCotizacionPorNegocio = new Map();
  for (const c of cotizaciones) {
    const fecha = fechaDia(c.fecha_creacion || c.creado_en);
    if (!ultimaCotizacionPorNegocio.has(c.negocio_id) || fecha > ultimaCotizacionPorNegocio.get(c.negocio_id)) {
      ultimaCotizacionPorNegocio.set(c.negocio_id, fecha);
    }
  }
  const ultimaTareaPorNegocio = new Map();
  for (const p of pendientesConNegocio) {
    const fecha = fechaDia(p.creado_en);
    if (!ultimaTareaPorNegocio.has(p.negocio_id) || fecha > ultimaTareaPorNegocio.get(p.negocio_id)) {
      ultimaTareaPorNegocio.set(p.negocio_id, fecha);
    }
  }

  // Negocios activos (no cerrados) sin ninguna actividad conocida en los ultimos N dias, y que
  // todavia no tengan una tarea de Seguimiento abierta esperando.
  const negociosInactivos = negocios.filter((n) => {
    if (ETAPAS_CIERRE.includes(n.etapa_nombre)) return false;
    if (negociosConSeguimientoAbierto.has(n.id_negocio)) return false;
    const fechas = [fechaDia(n.creado_en), ultimaCotizacionPorNegocio.get(n.id_negocio), ultimaTareaPorNegocio.get(n.id_negocio)].filter(Boolean);
    return diasDesde(fechas.sort().pop()) >= DIAS_SIN_ACTIVIDAD_NEGOCIO;
  });
  const idsNegociosInactivos = new Set(negociosInactivos.map((n) => n.id_negocio));

  // Cotizaciones vigentes (etapa Negociacion) que vencen pronto, cuyo negocio no vaya a recibir
  // ya una tarea por inactividad y que tampoco tenga una de Seguimiento abierta.
  const cotizacionesPorVencer = cotizaciones.filter((c) => {
    if (!c.negocio_id || !c.fecha_vencimiento || c.etapa !== 'Negociacion') return false;
    if (idsNegociosInactivos.has(c.negocio_id) || negociosConSeguimientoAbierto.has(c.negocio_id)) return false;
    const dias = diasDesde(c.fecha_vencimiento) * -1;
    return dias >= 0 && dias <= DIAS_ANTES_DE_VENCER_COTIZACION;
  });

  const creadas = [];
  async function crearSeguimiento(nombreNegocio, negocioId, contactoId, motivo) {
    const id = await generarIdPendiente();
    await db.prepare(`
      INSERT INTO pendientes (id_pendiente, nombre, fecha_compromiso, negocio_id, contacto_id) VALUES (?, ?, ?, ?, ?)
    `).run(id, `Seguimiento: ${nombreNegocio}`, hoy, negocioId, contactoId || null);
    await reemplazarActividadesPendiente(id, [seguimiento.id_actividad]);
    creadas.push({ id_pendiente: id, negocio: nombreNegocio, motivo });
  }

  for (const n of negociosInactivos) {
    await crearSeguimiento(n.negocio, n.id_negocio, n.contacto_id, `sin actividad hace ${DIAS_SIN_ACTIVIDAD_NEGOCIO}+ días`);
  }
  for (const c of cotizacionesPorVencer) {
    await crearSeguimiento(c.negocio_nombre || c.nombre, c.negocio_id, c.contacto_id, 'cotización por vencer');
  }

  res.json({ creadas, revisados: { negocios: negocios.length, cotizaciones: cotizaciones.length } });
}));

// Middleware final de manejo de errores (rutas envueltas con ar()).
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Error interno del servidor' });
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`CRM-ON escuchando en http://localhost:${PORT}`);
  });
}

module.exports = app;
