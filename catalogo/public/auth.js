// Se incluye en todas las paginas protegidas. Verifica la sesion, agrega la
// barra de usuario (nombre + cerrar sesion) y oculta del menu lo que el
// usuario no puede ver. Expone `promesaAuth`, una promesa que resuelve con
// los datos de la sesion (o null si redirigio a login).

// Doble confirmacion para acciones destructivas o irreversibles (Borrar, Listo, etc.):
// primero la pregunta especifica de la accion, luego una confirmacion generica.
function confirmarDoble(mensaje) {
  if (!confirm(mensaje)) return false;
  return confirm('Esta acción no se puede deshacer. ¿Confirmas que deseas continuar?');
}

function tituloDePagina(datos) {
  const archivoActual = window.location.pathname.split('/').pop() || 'index.html';
  const parametrosActuales = new URLSearchParams(window.location.search);
  const tabActual = parametrosActuales.get('tab');
  const subtabActual = parametrosActuales.get('subtab');
  const item = NAV_LATERAL.find((i) => {
    if (i.soloAdmin ? !datos.esAdmin : !i.permiso(datos.permisos)) return false;
    return esItemActivo(i, archivoActual, tabActual, subtabActual);
  });
  if (item) return item.texto;
  const h1 = document.querySelector('.contenedor h1');
  return h1 ? h1.textContent.trim() : document.title;
}

function insertarBarraUsuario(datos) {
  const barra = document.createElement('div');
  barra.className = 'barra-superior';
  barra.innerHTML = `
    <h2 class="barra-superior__titulo">${escaparHtmlLateral(tituloDePagina(datos))}</h2>
    <form id="form-buscador-global" class="buscador-global" role="search">
      <input type="text" autocomplete="off" id="buscador-global-input" placeholder="Buscar contacto, hotel/local u orden..." />
    </form>
    <span>${datos.usuario}${datos.esAdmin ? ' (admin)' : ''}</span>
    <button type="button" id="btn-cerrar-sesion">Cerrar sesión</button>
  `;
  const contenedor = document.querySelector('.contenedor');
  contenedor.insertBefore(barra, contenedor.firstChild);
  document.body.classList.add('con-barra-superior');

  document.getElementById('btn-cerrar-sesion').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' });
    window.location.href = 'login.html';
  });

  // Buscador global: siempre presente en la barra superior, en cualquier pantalla.
  const formBuscadorGlobal = document.getElementById('form-buscador-global');
  const inputBuscadorGlobal = document.getElementById('buscador-global-input');
  const qActual = new URLSearchParams(window.location.search).get('q');
  if (qActual && window.location.pathname.endsWith('buscar-global.html')) {
    inputBuscadorGlobal.value = qActual;
  }
  formBuscadorGlobal.addEventListener('submit', (e) => {
    e.preventDefault();
    const termino = inputBuscadorGlobal.value.trim();
    if (!termino) return;
    window.location.href = `buscar-global.html?q=${encodeURIComponent(termino)}`;
  });
}

function ajustarNavegacion(datos) {
  const puedeVerDatos = datos.permisos.ordenes.ver || datos.permisos.detalle_compra.ver || datos.permisos.catalogos.ver;
  const puedeVerInformacion = datos.permisos.ordenes.ver || datos.permisos.ordenes.editar || datos.permisos.detalle_compra.editar;

  const mapa = {
    'ordenes.html': datos.permisos.ordenes.ver,
    'buscar.html': datos.permisos.ordenes.ver,
    'detalle.html': datos.permisos.detalle_compra.ver,
    'catalogos.html': datos.permisos.catalogos.ver,
    'datos.html': puedeVerDatos,
    'carga.html': datos.permisos.ordenes.editar || datos.permisos.detalle_compra.editar,
    'reportes.html': datos.permisos.ordenes.ver,
    'informacion.html': puedeVerInformacion,
    'informacion-detalle.html': puedeVerDatos,
    'cotizaciones.html': datos.permisos.catalogos.ver,
    'seguimiento-ordenes.html': puedeVerInformacion || puedeVerDatos,
    'seguimiento-cotizaciones.html': datos.permisos.catalogos.ver,
  };

  document.querySelectorAll('.nav-principal a, .tarjeta-enlace[href]').forEach((a) => {
    const href = a.getAttribute('href');
    if (href in mapa) a.hidden = !mapa[href];
  });
}

// ---------- Barra lateral (navegacion global) ----------
// Se agrega como hermano de .contenedor (no lo reemplaza ni lo reordena) y solo empuja el
// contenido con un margin-left via la clase "con-barra-lateral" en <body>, para no arriesgar
// el layout propio de cada pantalla.
const NAV_LATERAL = [
  { grupo: null, texto: 'Inicio', href: 'panel.html', permiso: () => true },
  { grupo: null, texto: 'Órdenes', href: 'ordenes.html', permiso: (p) => p.ordenes.ver },
  { grupo: null, texto: 'Negocios', href: 'cotizaciones.html?tab=negocios', permiso: (p) => p.catalogos.ver },
  { grupo: null, texto: 'Cotizaciones', href: 'cotizaciones.html?tab=visualizacion', permiso: (p) => p.catalogos.ver },
  { grupo: null, texto: 'Detalle de compra', href: 'detalle.html', permiso: (p) => p.detalle_compra.ver },
  { grupo: null, texto: 'Carga inicial', href: 'carga.html', permiso: (p) => p.ordenes.editar || p.detalle_compra.editar },
  { grupo: null, texto: 'Tareas', href: 'index.html', permiso: (p) => p.catalogos.ver },
  { grupo: null, texto: 'Datos', href: 'datos.html', permiso: (p) => p.ordenes.ver || p.detalle_compra.ver || p.catalogos.ver },

  { grupo: 'Catálogos', texto: 'Hoteles / Locales', href: 'catalogos.html?tab=destinos&subtab=lista', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Plaza', href: 'catalogos.html?tab=destinos&subtab=plaza', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Grupo', href: 'catalogos.html?tab=destinos&subtab=grupo', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Cadena', href: 'catalogos.html?tab=destinos&subtab=cadena', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Contactos', href: 'catalogos.html?tab=contactos', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Productos', href: 'catalogos.html?tab=productos', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Estatus', href: 'catalogos.html?tab=estatus', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Estado de la República', href: 'catalogos.html?tab=estado-entrega', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Etapa del Negocio', href: 'catalogos.html?tab=etapa-negocio', permiso: (p) => p.catalogos.ver },
  { grupo: 'Catálogos', texto: 'Actividades', href: 'catalogos.html?tab=actividades', permiso: (p) => p.catalogos.ver },

  { grupo: 'Administración', texto: 'Usuarios', href: 'catalogos.html?tab=usuarios', soloAdmin: true },
  { grupo: 'Administración', texto: 'Representantes', href: 'catalogos.html?tab=usuarios', soloAdmin: true },
  { grupo: 'Administración', texto: 'Almacenamiento', href: 'catalogos.html?tab=almacenamiento', soloAdmin: true },
  { grupo: 'Administración', texto: 'Configuración', href: 'configuracion.html', soloAdmin: true },
];

// Paginas donde varios items de la barra apuntan al mismo archivo con distinto ?tab=: si la URL
// actual no trae ?tab=, hay que saber cual pestana se activa por default para marcar el item
// correcto (si no, ninguno o el equivocado quedaria resaltado).
const TAB_POR_DEFECTO = { 'cotizaciones.html': 'negocios', 'catalogos.html': 'destinos' };

// Igual que TAB_POR_DEFECTO pero un nivel mas abajo: dentro de catalogos.html?tab=destinos,
// varios items (Hoteles/Locales, Plaza, Grupo, Cadena) comparten el mismo tab pero distinto
// ?subtab=. La llave es el tab efectivo (el de la URL, o el default de arriba).
const SUBTAB_POR_DEFECTO = { destinos: 'lista' };

function esItemActivo(item, archivoActual, tabActual, subtabActual) {
  const [archivoItem, queryItem] = item.href.split('?');
  if (archivoItem !== archivoActual) return false;
  if (!queryItem) return true;
  const paramsItem = new URLSearchParams(queryItem);
  const tabItem = paramsItem.get('tab');
  const tabEfectivo = tabActual || TAB_POR_DEFECTO[archivoActual];
  if (tabItem && tabItem !== tabEfectivo) return false;
  const subtabItem = paramsItem.get('subtab');
  if (subtabItem && subtabItem !== (subtabActual || SUBTAB_POR_DEFECTO[tabEfectivo])) return false;
  return true;
}

function insertarBarraLateral(datos) {
  const archivoActual = window.location.pathname.split('/').pop() || 'index.html';
  const parametrosActuales = new URLSearchParams(window.location.search);
  const tabActual = parametrosActuales.get('tab');
  const subtabActual = parametrosActuales.get('subtab');

  const visibles = NAV_LATERAL.filter((item) => (item.soloAdmin ? datos.esAdmin : item.permiso(datos.permisos)));
  const grupos = [{ nombre: null, items: visibles.filter((i) => !i.grupo) }];
  for (const nombreGrupo of ['Catálogos', 'Administración']) {
    const items = visibles.filter((i) => i.grupo === nombreGrupo);
    if (items.length) grupos.push({ nombre: nombreGrupo, items });
  }

  const html = grupos.map((g) => `
    <div class="nav-grupo">
      ${g.nombre ? `<div class="nav-grupo__titulo">${escaparHtmlLateral(g.nombre)}</div>` : ''}
      ${g.items.map((item) => {
        const activo = esItemActivo(item, archivoActual, tabActual, subtabActual);
        return `<a class="nav-item${item.grupo ? ' nav-item--sub' : ''}${activo ? ' activo' : ''}" href="${item.href}"${activo ? ' aria-current="page"' : ''}>${escaparHtmlLateral(item.texto)}</a>`;
      }).join('')}
    </div>
  `).join('');

  const barra = document.createElement('aside');
  barra.className = 'barra-lateral';
  barra.innerHTML = `
    <div class="lateral-marca">
      <div class="lateral-marca__fila">
        <span class="lateral-marca__nombre">GONPAL</span>
        <span class="lateral-marca__sufijo">CRM</span>
      </div>
      <span class="lateral-marca__autor">By Ing Ramón Villanueva</span>
    </div>
    <nav class="nav-lateral" aria-label="Navegación principal">${html}</nav>
  `;
  document.body.insertBefore(barra, document.body.firstChild);
  document.body.classList.add('con-barra-lateral');
}

function escaparHtmlLateral(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

async function iniciarAuth() {
  const res = await fetch('/api/me');
  if (!res.ok) {
    window.location.href = 'login.html';
    return null;
  }

  const datos = await res.json();
  insertarBarraLateral(datos);
  insertarBarraUsuario(datos);
  ajustarNavegacion(datos);
  return datos;
}

const promesaAuth = iniciarAuth();

// ---------- Cierre de sesion por inactividad ----------
// Si no hay ningun movimiento del usuario (mouse, teclado, touch, scroll) durante este tiempo,
// se cierra la sesion y se manda a login. El numero debe coincidir con el maxAge de la cookie
// de sesion en el servidor (server.js), que ademas es la garantia real del lado del servidor
// por si el usuario cierra la pestana o deshabilita JavaScript.
const MINUTOS_INACTIVIDAD = 75;
let temporizadorInactividad = null;

async function cerrarSesionPorInactividad() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (e) {
    // Sin red o sesion ya vencida: igual mandamos a login.
  }
  window.location.href = 'login.html?motivo=inactividad';
}

function reiniciarTemporizadorInactividad() {
  clearTimeout(temporizadorInactividad);
  temporizadorInactividad = setTimeout(cerrarSesionPorInactividad, MINUTOS_INACTIVIDAD * 60 * 1000);
}

['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click'].forEach((evento) => {
  document.addEventListener(evento, reiniciarTemporizadorInactividad, { passive: true });
});
reiniciarTemporizadorInactividad();

// ---------- Actualizaciones en tiempo real (Supabase Realtime) ----------
// La llave publica solo tiene permiso de LECTURA (ver migracion "habilitar_rls_solo_lectura_anon"):
// cualquier escritura sigue pasando por la API de Express, que valida sesion y permisos. Esto
// solo se usa para enterarse de que "algo cambio" y disparar un recargar() ya existente de la
// pantalla (que si pasa por la API autenticada), no para leer/mostrar los datos del propio evento.
const SUPABASE_URL = 'https://lcroyltwviddtdxqwzox.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_-Yxe-JuqvWFRmS0eGnB6Tg_P6pcM5ZV';

const promesaSupabaseRealtime = new Promise((resolve) => {
  const script = document.createElement('script');
  script.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.js';
  script.onload = () => resolve(window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY));
  script.onerror = () => resolve(null);
  document.head.appendChild(script);
});

// Suscribe `recargar` a cualquier INSERT/UPDATE/DELETE en una o mas tablas de Postgres, con un
// pequeno debounce para no disparar varias veces seguidas si llegan varios cambios juntos (ej.
// una carga masiva). Uso: suscribirTiempoReal(['destinos', 'destino_empresas'], cargarDestinos).
function suscribirTiempoReal(tablas, recargar) {
  promesaSupabaseRealtime.then((cliente) => {
    if (!cliente) return;
    let temporizador = null;
    const recargarConDebounce = () => {
      clearTimeout(temporizador);
      temporizador = setTimeout(recargar, 400);
    };
    const canal = cliente.channel(`rt-${tablas.join('-')}-${Math.random().toString(36).slice(2)}`);
    for (const tabla of tablas) {
      canal.on('postgres_changes', { event: '*', schema: 'public', table: tabla }, recargarConDebounce);
    }
    canal.subscribe();
  });
}
