function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function fechaDe(iso) {
  if (!iso) return '';
  return String(iso).slice(0, 10);
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function campoFicha(etiqueta, valor) {
  return `<div><span>${escaparHtml(etiqueta)}</span><p>${valor !== null && valor !== undefined && valor !== '' ? escaparHtml(String(valor)) : '-'}</p></div>`;
}

const idDestino = new URLSearchParams(window.location.search).get('id');
let permisosCatalogos = { ver: false, editar: false, borrar: false };
let destinoActual = null;
let asociadosActual = { cotizaciones: [], ordenes: [], tareas: [], contactos: [] };

const destinoFicha = document.getElementById('destino-ficha');
const tituloDestino = document.getElementById('titulo-destino');
const btnEditarDestino = document.getElementById('btn-editar-destino');
const formEditarDestino = document.getElementById('form-editar-destino');
const btnCancelarEditarDestino = document.getElementById('btn-cancelar-editar-destino');
const editarDestinoNombre = document.getElementById('editar-destino-nombre');
const editarDestinoUbicacion = document.getElementById('editar-destino-ubicacion');

// Mismo widget reutilizable de catalogos.js: boton + panel de checkboxes buscable para elegir
// uno o mas valores de un catalogo (Plaza/Grupo/Cadena), con seleccion rastreada por nombre.
function crearMultiSelectCatalogo({ wrapId, btnId, panelId, etiquetaVacio, etiquetaVarios }) {
  const wrap = document.getElementById(wrapId);
  const btn = document.getElementById(btnId);
  const panel = document.getElementById(panelId);
  const seleccionados = new Set();
  let opciones = [];

  function actualizarBoton() {
    if (seleccionados.size === 0) btn.textContent = etiquetaVacio;
    else if (seleccionados.size === 1) btn.textContent = [...seleccionados][0];
    else btn.textContent = `${seleccionados.size} ${etiquetaVarios}`;
  }

  function renderizar() {
    panel.innerHTML = opciones.length
      ? `
        <input type="text" autocomplete="off" class="multi-select-buscador" placeholder="Buscar..." />
        <div class="multi-select-opciones">
          ${opciones.map((nombre) => `
            <label class="multi-select-opcion">
              <input type="checkbox" value="${escaparHtml(nombre)}" ${seleccionados.has(nombre) ? 'checked' : ''} /> <span>${escaparHtml(nombre)}</span>
            </label>
          `).join('')}
        </div>
      `
      : `<p class="pista">Nada capturado todavía. Usa el botón "+" para agregar.</p>`;
  }

  panel.addEventListener('input', (e) => {
    if (!e.target.classList.contains('multi-select-buscador')) return;
    const filtro = e.target.value.trim().toLowerCase();
    panel.querySelectorAll('.multi-select-opcion').forEach((label) => {
      label.hidden = !label.textContent.toLowerCase().includes(filtro);
    });
  });

  btn.addEventListener('click', () => {
    panel.hidden = !panel.hidden;
    if (!panel.hidden) {
      const buscador = panel.querySelector('.multi-select-buscador');
      if (buscador) {
        buscador.value = '';
        panel.querySelectorAll('.multi-select-opcion').forEach((label) => { label.hidden = false; });
        buscador.focus();
      }
    }
  });

  panel.addEventListener('change', (e) => {
    if (e.target.type !== 'checkbox') return;
    if (e.target.checked) seleccionados.add(e.target.value);
    else seleccionados.delete(e.target.value);
    actualizarBoton();
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) panel.hidden = true;
  });

  return {
    async cargar(url, campoNombre) {
      const res = await fetch(url);
      const filas = await res.json();
      opciones = filas.map((f) => f[campoNombre]);
      renderizar();
      actualizarBoton();
    },
    marcar(nombres) {
      seleccionados.clear();
      for (const n of nombres || []) seleccionados.add(n);
      renderizar();
      actualizarBoton();
    },
    obtenerSeleccionados() {
      return [...seleccionados];
    },
    agregarSeleccionado(nombre) {
      if (!opciones.includes(nombre)) opciones.push(nombre);
      seleccionados.add(nombre);
      renderizar();
      actualizarBoton();
    },
  };
}

const multiSelectPlaza = crearMultiSelectCatalogo({ wrapId: 'editar-destino-plaza-wrap', btnId: 'editar-destino-plaza-btn', panelId: 'editar-destino-plaza-panel', etiquetaVacio: 'Sin plazas', etiquetaVarios: 'plazas seleccionadas' });
const multiSelectGrupo = crearMultiSelectCatalogo({ wrapId: 'editar-destino-grupo-wrap', btnId: 'editar-destino-grupo-btn', panelId: 'editar-destino-grupo-panel', etiquetaVacio: 'Sin grupos', etiquetaVarios: 'grupos seleccionados' });
const multiSelectCadena = crearMultiSelectCatalogo({ wrapId: 'editar-destino-cadena-wrap', btnId: 'editar-destino-cadena-btn', panelId: 'editar-destino-cadena-panel', etiquetaVacio: 'Sin cadenas', etiquetaVarios: 'cadenas seleccionadas' });

function refrescarMultiSelectsDestino() {
  multiSelectPlaza.cargar('/api/empresas', 'empresa');
  multiSelectGrupo.cargar('/api/grupos', 'grupo');
  multiSelectCadena.cargar('/api/cadenas', 'cadena');
}

// ---- Alta rapida de Plaza/Grupo/Cadena (boton "+" junto a cada multi-select) ----

const modalRapidoCatalogoDestinoOverlay = document.getElementById('modal-rapido-catalogo-destino-overlay');
const modalRapidoCatalogoDestinoCerrar = document.getElementById('modal-rapido-catalogo-destino-cerrar');
const modalRapidoCatalogoDestinoTitulo = document.getElementById('modal-rapido-catalogo-destino-titulo');
const modalRapidoCatalogoDestinoNombre = document.getElementById('modal-rapido-catalogo-destino-nombre');
const formRapidoCatalogoDestino = document.getElementById('form-rapido-catalogo-destino');

const CATALOGOS_DESTINO = {
  plaza: { titulo: 'Nueva plaza', url: '/api/empresas', campo: 'empresa', multiSelect: multiSelectPlaza },
  grupo: { titulo: 'Nuevo grupo', url: '/api/grupos', campo: 'grupo', multiSelect: multiSelectGrupo },
  cadena: { titulo: 'Nueva cadena', url: '/api/cadenas', campo: 'cadena', multiSelect: multiSelectCadena },
};
let catalogoDestinoActual = null;

document.querySelectorAll('.btn-agregar-catalogo').forEach((boton) => {
  boton.addEventListener('click', () => {
    catalogoDestinoActual = boton.dataset.catalogo;
    modalRapidoCatalogoDestinoTitulo.textContent = CATALOGOS_DESTINO[catalogoDestinoActual].titulo;
    formRapidoCatalogoDestino.reset();
    modalRapidoCatalogoDestinoOverlay.hidden = false;
    modalRapidoCatalogoDestinoNombre.focus();
  });
});

function cerrarModalRapidoCatalogoDestino() {
  modalRapidoCatalogoDestinoOverlay.hidden = true;
}
modalRapidoCatalogoDestinoCerrar.addEventListener('click', cerrarModalRapidoCatalogoDestino);
modalRapidoCatalogoDestinoOverlay.addEventListener('click', (e) => {
  if (e.target === modalRapidoCatalogoDestinoOverlay) cerrarModalRapidoCatalogoDestino();
});

formRapidoCatalogoDestino.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = modalRapidoCatalogoDestinoNombre.value.trim();
  if (!nombre || !catalogoDestinoActual) return;
  const config = CATALOGOS_DESTINO[catalogoDestinoActual];

  const res = await fetch(config.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ [config.campo]: nombre }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  const creado = await res.json();
  config.multiSelect.agregarSeleccionado(creado[config.campo]);
  cerrarModalRapidoCatalogoDestino();
});

async function cargarDestino() {
  const res = await fetch(`/api/destinos/${encodeURIComponent(idDestino)}`);
  if (!res.ok) {
    destinoFicha.innerHTML = '<p>Hotel/local no encontrado.</p>';
    return;
  }
  destinoActual = await res.json();
  tituloDestino.textContent = destinoActual.destino;
  document.title = `${destinoActual.destino} · CRM-ON`;
  destinoFicha.innerHTML = `
    ${campoFicha('Nombre', destinoActual.destino)}
    ${campoFicha('Plaza', (destinoActual.empresas || []).join(', '))}
    ${campoFicha('Grupo', (destinoActual.grupos || []).join(', '))}
    ${campoFicha('Cadena', (destinoActual.cadenas || []).join(', '))}
    ${campoFicha('Ubicación', destinoActual.ubicacion)}
  `;
}

btnEditarDestino.addEventListener('click', () => {
  editarDestinoNombre.value = destinoActual.destino || '';
  editarDestinoUbicacion.value = destinoActual.ubicacion || '';
  multiSelectPlaza.marcar(destinoActual.empresas);
  multiSelectGrupo.marcar(destinoActual.grupos);
  multiSelectCadena.marcar(destinoActual.cadenas);
  formEditarDestino.hidden = false;
  btnEditarDestino.hidden = true;
});

btnCancelarEditarDestino.addEventListener('click', () => {
  formEditarDestino.hidden = true;
  btnEditarDestino.hidden = false;
});

formEditarDestino.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    destino: editarDestinoNombre.value.trim(),
    ubicacion: editarDestinoUbicacion.value.trim(),
    empresas: multiSelectPlaza.obtenerSeleccionados(),
    grupos: multiSelectGrupo.obtenerSeleccionados(),
    cadenas: multiSelectCadena.obtenerSeleccionados(),
  };
  const res = await fetch(`/api/destinos/${encodeURIComponent(idDestino)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  formEditarDestino.hidden = true;
  btnEditarDestino.hidden = false;
  await cargarDestino();
});

// ---------- Contactos: agregar por buscador, quitar con boton ----------

const listaContactosDestino = document.getElementById('lista-contactos-destino');
const contadorContactos = document.getElementById('contador-contactos');
const buscarContactoAgregar = document.getElementById('buscar-contacto-agregar');
const opcionesContactoAgregar = document.getElementById('opciones-contacto-agregar');
let contactosDisponiblesCache = [];

async function cargarContactosDisponibles() {
  const res = await fetch('/api/contactos');
  contactosDisponiblesCache = await res.json();
}

function renderizarContactosDestino() {
  const contactos = asociadosActual.contactos || [];
  contadorContactos.textContent = `(${contactos.length})`;
  listaContactosDestino.innerHTML = contactos.length
    ? contactos.map((c) => `
        <div class="tarjeta-item">
          <a href="contacto-detalle.html?id=${c.id_contacto}">${escaparHtml([c.nombre, c.apellido].filter(Boolean).join(' '))}</a>
          ${permisosCatalogos.editar ? `<button type="button" class="btn-mini btn-quitar-contacto" data-id="${c.id_contacto}">Quitar</button>` : ''}
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin contactos asociados.</p>';
}

buscarContactoAgregar.addEventListener('input', () => {
  const filtro = buscarContactoAgregar.value.trim().toLowerCase();
  if (!filtro) {
    opcionesContactoAgregar.hidden = true;
    opcionesContactoAgregar.innerHTML = '';
    return;
  }
  const yaAsociados = new Set((asociadosActual.contactos || []).map((c) => c.id_contacto));
  const coincidencias = contactosDisponiblesCache
    .filter((c) => !yaAsociados.has(c.id_contacto) && c.nombre_completo_correo.toLowerCase().includes(filtro))
    .slice(0, 20);
  opcionesContactoAgregar.innerHTML = coincidencias.length
    ? coincidencias.map((c) => `<button type="button" data-id="${c.id_contacto}">${escaparHtml(c.nombre_completo_correo)}</button>`).join('')
    : '<button type="button" disabled>Sin resultados</button>';
  opcionesContactoAgregar.hidden = false;
});

opcionesContactoAgregar.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  const res = await fetch(`/api/destinos/${encodeURIComponent(idDestino)}/contactos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contacto_id: Number(id) }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  buscarContactoAgregar.value = '';
  opcionesContactoAgregar.hidden = true;
  await cargarAsociados();
});

listaContactosDestino.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-quitar-contacto')) return;
  const id = e.target.dataset.id;
  const res = await fetch(`/api/destinos/${encodeURIComponent(idDestino)}/contactos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (res.ok) await cargarAsociados();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.tarjeta-buscador-wrap')) opcionesContactoAgregar.hidden = true;
});

// ---------- Cotizaciones, Ordenes y Tareas (via /asociados) ----------

const listaCotizaciones = document.getElementById('lista-cotizaciones');
const contadorCotizaciones = document.getElementById('contador-cotizaciones');
const listaOrdenes = document.getElementById('lista-ordenes');
const contadorOrdenes = document.getElementById('contador-ordenes');
const listaTareas = document.getElementById('lista-tareas');
const contadorTareas = document.getElementById('contador-tareas');
const linkAgregarCotizacion = document.getElementById('link-agregar-cotizacion');
const selectNuevaTareaOrden = document.getElementById('nueva-tarea-orden');
const btnMostrarFormTarea = document.getElementById('btn-mostrar-form-tarea');
const pistaTareaSinOrden = document.getElementById('pista-tarea-sin-orden');

async function cargarAsociados() {
  const res = await fetch(`/api/destinos/${encodeURIComponent(idDestino)}/asociados`);
  asociadosActual = await res.json();

  renderizarContactosDestino();

  contadorCotizaciones.textContent = `(${asociadosActual.cotizaciones.length})`;
  listaCotizaciones.innerHTML = asociadosActual.cotizaciones.length
    ? asociadosActual.cotizaciones.map((q) => `
        <div class="tarjeta-item">
          <a href="cotizaciones.html?cotizacion=${encodeURIComponent(q.id_cotizacion)}">${escaparHtml(q.nombre)}</a>
          <span>${escaparHtml(q.moneda)} ${formatoImporte(q.gran_total)}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin cotizaciones.</p>';
  linkAgregarCotizacion.href = `cotizaciones.html?tab=captura&destino_id=${encodeURIComponent(idDestino)}`;
  linkAgregarCotizacion.hidden = !permisosCatalogos.editar;

  contadorOrdenes.textContent = `(${asociadosActual.ordenes.length})`;
  listaOrdenes.innerHTML = asociadosActual.ordenes.length
    ? asociadosActual.ordenes.map((o) => `
        <div class="tarjeta-item">
          <span class="tarjeta-item-nombre" data-ir-orden="${escaparHtml(o.id)}">${escaparHtml(o.id)} — ${escaparHtml(o.nombre || '')}</span>
          <span>${formatoImporte(o.importe)}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin órdenes.</p>';

  contadorTareas.textContent = `(${asociadosActual.tareas.length})`;
  listaTareas.innerHTML = asociadosActual.tareas.length
    ? asociadosActual.tareas.map((p) => `
        <div class="tarjeta-item">
          <span>${escaparHtml((p.actividades || []).map((a) => a.actividad).join(', ') || 'Sin actividad')} — ${escaparHtml(p.nombre)}</span>
          <span>${escaparHtml(fechaDe(p.fecha_compromiso))}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin tareas.</p>';

  selectNuevaTareaOrden.innerHTML = asociadosActual.ordenes.map((o) => `<option value="${o.id}">${escaparHtml(o.id)} — ${escaparHtml(o.nombre || '')}</option>`).join('');
  const tieneOrdenes = asociadosActual.ordenes.length > 0;
  btnMostrarFormTarea.hidden = !tieneOrdenes || !permisosCatalogos.editar;
  pistaTareaSinOrden.hidden = tieneOrdenes;
}

listaOrdenes.addEventListener('click', (e) => {
  const id = e.target.dataset.irOrden;
  if (id) window.location.href = `ordenes.html?orden=${encodeURIComponent(id)}`;
});

// ---------- Nueva tarea ----------

const formNuevaTarea = document.getElementById('form-nueva-tarea');
const btnCancelarNuevaTarea = document.getElementById('btn-cancelar-nueva-tarea');
const nuevaTareaNombre = document.getElementById('nueva-tarea-nombre');
const nuevaTareaFecha = document.getElementById('nueva-tarea-fecha');
const nuevaTareaActividades = document.getElementById('nueva-tarea-actividades');

async function cargarActividadesCache() {
  const res = await fetch('/api/actividades');
  const actividades = await res.json();
  nuevaTareaActividades.innerHTML = actividades.map((a) => `
    <label><input type="checkbox" value="${a.id_actividad}" /> ${escaparHtml(a.actividad)}</label>
  `).join('');
}

btnMostrarFormTarea.addEventListener('click', () => {
  formNuevaTarea.hidden = false;
  btnMostrarFormTarea.hidden = true;
});
btnCancelarNuevaTarea.addEventListener('click', () => {
  formNuevaTarea.hidden = true;
  btnMostrarFormTarea.hidden = false;
  formNuevaTarea.reset();
});

formNuevaTarea.addEventListener('submit', async (e) => {
  e.preventDefault();
  const actividades = [...nuevaTareaActividades.querySelectorAll('input:checked')].map((cb) => Number(cb.value));
  if (actividades.length === 0) {
    alert('Selecciona al menos una actividad.');
    return;
  }
  const res = await fetch('/api/pendientes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre: nuevaTareaNombre.value.trim(),
      fecha_compromiso: nuevaTareaFecha.value || null,
      orden_id: selectNuevaTareaOrden.value,
      actividades,
    }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  formNuevaTarea.reset();
  formNuevaTarea.hidden = true;
  btnMostrarFormTarea.hidden = false;
  await cargarAsociados();
});

promesaAuth.then(async (sesion) => {
  if (!sesion) return;
  if (!idDestino) {
    destinoFicha.innerHTML = '<p>Falta el id del hotel/local.</p>';
    return;
  }
  permisosCatalogos = sesion.permisos.catalogos;
  formEditarDestino.hidden = true;
  btnEditarDestino.hidden = !permisosCatalogos.editar;
  document.querySelector('.tarjeta-buscador-wrap').hidden = !permisosCatalogos.editar;

  await Promise.all([cargarContactosDisponibles(), cargarActividadesCache()]);
  refrescarMultiSelectsDestino();
  await cargarDestino();
  await cargarAsociados();

  suscribirTiempoReal(['destinos', 'destino_empresas', 'destino_grupos', 'destino_cadenas'], () => { cargarDestino(); refrescarMultiSelectsDestino(); });
  suscribirTiempoReal(['empresas', 'grupos', 'cadenas'], refrescarMultiSelectsDestino);
  suscribirTiempoReal(['contacto_destinos', 'cotizaciones', 'ordenes', 'pendientes'], cargarAsociados);
  suscribirTiempoReal(['contactos'], () => { cargarContactosDisponibles(); cargarAsociados(); });
});
