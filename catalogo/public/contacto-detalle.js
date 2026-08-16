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

const idContacto = new URLSearchParams(window.location.search).get('id');
let permisosCatalogos = { ver: false, editar: false, borrar: false };
let contactoActual = null;

const contactoFicha = document.getElementById('contacto-ficha');
const tituloContacto = document.getElementById('titulo-contacto');
const btnEditarContacto = document.getElementById('btn-editar-contacto');
const formEditarContacto = document.getElementById('form-editar-contacto');
const btnCancelarEditarContacto = document.getElementById('btn-cancelar-editar-contacto');
const editarNombre = document.getElementById('editar-contacto-nombre');
const editarApellido = document.getElementById('editar-contacto-apellido');
const editarCorreo = document.getElementById('editar-contacto-correo');
const editarTelLocal = document.getElementById('editar-contacto-telefono-local');
const editarTelCelular = document.getElementById('editar-contacto-telefono-celular');

async function cargarContacto() {
  const res = await fetch(`/api/contactos/${encodeURIComponent(idContacto)}`);
  if (!res.ok) {
    contactoFicha.innerHTML = '<p>Contacto no encontrado.</p>';
    return;
  }
  contactoActual = await res.json();
  const nombreCompleto = [contactoActual.nombre, contactoActual.apellido].filter(Boolean).join(' ');
  tituloContacto.textContent = nombreCompleto;
  document.title = `${nombreCompleto} · CRM-ON`;
  contactoFicha.innerHTML = `
    ${campoFicha('Nombre', contactoActual.nombre)}
    ${campoFicha('Apellido', contactoActual.apellido)}
    ${campoFicha('Correo', contactoActual.correo_electronico)}
    ${campoFicha('Tel. local', contactoActual.telefono_local)}
    ${campoFicha('Tel. celular', contactoActual.telefono_celular)}
    ${campoFicha('Última actividad', fechaDe(contactoActual.fecha_ultima_actividad) || 'Sin actividad')}
  `;

  document.getElementById('contador-destinos').textContent = `(${(contactoActual.destinos || []).length})`;
  document.getElementById('lista-destinos-contacto').innerHTML = (contactoActual.destinos || []).length
    ? contactoActual.destinos.map((d) => `
        <div class="tarjeta-item">
          <a href="destino-detalle.html?id=${d.id_destino}">${escaparHtml(d.destino)}</a>
          ${permisosCatalogos.editar ? `<button type="button" class="btn-mini btn-quitar-destino" data-id="${d.id_destino}">Quitar</button>` : ''}
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin hoteles/locales asociados.</p>';
}

btnEditarContacto.addEventListener('click', () => {
  editarNombre.value = contactoActual.nombre || '';
  editarApellido.value = contactoActual.apellido || '';
  editarCorreo.value = contactoActual.correo_electronico || '';
  editarTelLocal.value = contactoActual.telefono_local || '';
  editarTelCelular.value = contactoActual.telefono_celular || '';
  formEditarContacto.hidden = false;
  btnEditarContacto.hidden = true;
});

btnCancelarEditarContacto.addEventListener('click', () => {
  formEditarContacto.hidden = true;
  btnEditarContacto.hidden = false;
});

formEditarContacto.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    nombre: editarNombre.value.trim(),
    apellido: editarApellido.value.trim(),
    correo_electronico: editarCorreo.value.trim(),
    telefono_local: editarTelLocal.value.trim(),
    telefono_celular: editarTelCelular.value.trim(),
    destinos: (contactoActual.destinos || []).map((d) => d.id_destino),
  };
  const res = await fetch(`/api/contactos/${encodeURIComponent(idContacto)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  formEditarContacto.hidden = true;
  btnEditarContacto.hidden = false;
  await cargarContacto();
});

// ---------- Hoteles / Locales: agregar por buscador, quitar con boton ----------

const buscarDestinoAgregar = document.getElementById('buscar-destino-agregar');
const opcionesDestinoAgregar = document.getElementById('opciones-destino-agregar');
let destinosDisponiblesCache = [];

async function cargarDestinosDisponibles() {
  const res = await fetch('/api/destinos');
  destinosDisponiblesCache = await res.json();
}

buscarDestinoAgregar.addEventListener('input', () => {
  const filtro = buscarDestinoAgregar.value.trim().toLowerCase();
  if (!filtro) {
    opcionesDestinoAgregar.hidden = true;
    opcionesDestinoAgregar.innerHTML = '';
    return;
  }
  const yaAsociados = new Set((contactoActual.destinos || []).map((d) => d.id_destino));
  const coincidencias = destinosDisponiblesCache
    .filter((d) => !yaAsociados.has(d.id_destino) && d.destino.toLowerCase().includes(filtro))
    .slice(0, 20);
  opcionesDestinoAgregar.innerHTML = coincidencias.length
    ? coincidencias.map((d) => `<button type="button" data-id="${d.id_destino}">${escaparHtml(d.destino)}</button>`).join('')
    : '<button type="button" disabled>Sin resultados</button>';
  opcionesDestinoAgregar.hidden = false;
});

opcionesDestinoAgregar.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;
  const nuevosDestinos = [...(contactoActual.destinos || []).map((d) => d.id_destino), Number(id)];
  const res = await fetch(`/api/contactos/${encodeURIComponent(idContacto)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre: contactoActual.nombre,
      apellido: contactoActual.apellido,
      correo_electronico: contactoActual.correo_electronico,
      telefono_local: contactoActual.telefono_local,
      telefono_celular: contactoActual.telefono_celular,
      destinos: nuevosDestinos,
    }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  buscarDestinoAgregar.value = '';
  opcionesDestinoAgregar.hidden = true;
  await cargarContacto();
});

document.getElementById('lista-destinos-contacto').addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-quitar-destino')) return;
  const id = Number(e.target.dataset.id);
  const nuevosDestinos = (contactoActual.destinos || []).map((d) => d.id_destino).filter((d) => d !== id);
  const res = await fetch(`/api/contactos/${encodeURIComponent(idContacto)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre: contactoActual.nombre,
      apellido: contactoActual.apellido,
      correo_electronico: contactoActual.correo_electronico,
      telefono_local: contactoActual.telefono_local,
      telefono_celular: contactoActual.telefono_celular,
      destinos: nuevosDestinos,
    }),
  });
  if (res.ok) await cargarContacto();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.tarjeta-buscador-wrap')) opcionesDestinoAgregar.hidden = true;
});

// Agregar de un solo paso todos los hoteles/locales de un Grupo (accion rapida: solo agrega los
// hoteles que ya tiene ese grupo en este momento, no queda ningun vinculo permanente al grupo).
const agregarGrupoSelect = document.getElementById('agregar-grupo-select');
const btnAgregarGrupo = document.getElementById('btn-agregar-grupo');

async function cargarGruposDisponibles() {
  const res = await fetch('/api/grupos');
  const grupos = await res.json();
  agregarGrupoSelect.innerHTML = '<option value="">Agregar todos los hoteles de un grupo...</option>'
    + grupos.map((g) => `<option value="${g.id_grupo}">${escaparHtml(g.grupo)}</option>`).join('');
}

btnAgregarGrupo.addEventListener('click', async () => {
  const grupoId = agregarGrupoSelect.value;
  if (!grupoId) return;

  const resGrupo = await fetch(`/api/grupos/${encodeURIComponent(grupoId)}/destinos`);
  const destinosDelGrupo = await resGrupo.json();
  const yaAsociados = new Set((contactoActual.destinos || []).map((d) => d.id_destino));
  const nuevosDestinos = [
    ...(contactoActual.destinos || []).map((d) => d.id_destino),
    ...destinosDelGrupo.map((d) => d.id_destino).filter((id) => !yaAsociados.has(id)),
  ];

  const res = await fetch(`/api/contactos/${encodeURIComponent(idContacto)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre: contactoActual.nombre,
      apellido: contactoActual.apellido,
      correo_electronico: contactoActual.correo_electronico,
      telefono_local: contactoActual.telefono_local,
      telefono_celular: contactoActual.telefono_celular,
      destinos: nuevosDestinos,
    }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  agregarGrupoSelect.value = '';
  await cargarContacto();
});

// ---------- Negocios ----------

const listaNegocios = document.getElementById('lista-negocios');
const contadorNegocios = document.getElementById('contador-negocios');
const btnMostrarFormNegocio = document.getElementById('btn-mostrar-form-negocio');
const formNuevoNegocio = document.getElementById('form-nuevo-negocio');
const btnCancelarNuevoNegocio = document.getElementById('btn-cancelar-nuevo-negocio');
const nuevoNegocioNombre = document.getElementById('nuevo-negocio-nombre');
const nuevoNegocioEtapa = document.getElementById('nuevo-negocio-etapa');
const linkAgregarCotizacion = document.getElementById('link-agregar-cotizacion');
const selectNuevaTareaNegocio = document.getElementById('nueva-tarea-negocio');
const btnMostrarFormTarea = document.getElementById('btn-mostrar-form-tarea');
const pistaTareaSinNegocio = document.getElementById('pista-tarea-sin-negocio');

let negociosDeContacto = [];

async function cargarEtapasNegocioSelect() {
  const res = await fetch('/api/etapas-negocio');
  const etapas = await res.json();
  nuevoNegocioEtapa.innerHTML = '<option value="">Etapa (opcional)</option>'
    + etapas.map((e) => `<option value="${e.id_etapa}">${escaparHtml(e.etapa)}</option>`).join('');
}

async function cargarNegociosDeContacto() {
  const res = await fetch('/api/negocios');
  const negocios = await res.json();
  negociosDeContacto = negocios.filter((n) => String(n.contacto_id) === String(idContacto));

  contadorNegocios.textContent = `(${negociosDeContacto.length})`;
  listaNegocios.innerHTML = negociosDeContacto.length
    ? negociosDeContacto.map((n) => `
        <div class="tarjeta-item">
          <a href="cotizaciones.html?tab=negocios">${escaparHtml(n.negocio)}</a>
          <span>${escaparHtml(n.estatus || '')}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin negocios asociados.</p>';

  selectNuevaTareaNegocio.innerHTML = negociosDeContacto.map((n) => `<option value="${n.id_negocio}">${escaparHtml(n.negocio)}</option>`).join('');
  const tieneNegocios = negociosDeContacto.length > 0;
  btnMostrarFormTarea.hidden = !tieneNegocios || !permisosCatalogos.editar;
  pistaTareaSinNegocio.hidden = tieneNegocios;

  linkAgregarCotizacion.hidden = !tieneNegocios || !permisosCatalogos.editar;
  linkAgregarCotizacion.href = negociosDeContacto.length === 1
    ? `cotizaciones.html?tab=captura&contacto_id=${encodeURIComponent(idContacto)}&negocio_id=${encodeURIComponent(negociosDeContacto[0].id_negocio)}`
    : `cotizaciones.html?tab=captura&contacto_id=${encodeURIComponent(idContacto)}`;
}

btnMostrarFormNegocio.addEventListener('click', () => {
  formNuevoNegocio.hidden = false;
  btnMostrarFormNegocio.hidden = true;
});
btnCancelarNuevoNegocio.addEventListener('click', () => {
  formNuevoNegocio.hidden = true;
  btnMostrarFormNegocio.hidden = false;
  formNuevoNegocio.reset();
});

formNuevoNegocio.addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch('/api/negocios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      negocio: nuevoNegocioNombre.value.trim(),
      contacto_id: idContacto,
      etapa_id: nuevoNegocioEtapa.value || null,
    }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  formNuevoNegocio.reset();
  formNuevoNegocio.hidden = true;
  btnMostrarFormNegocio.hidden = false;
  await cargarNegociosDeContacto();
});

// ---------- Cotizaciones, Ordenes y Tareas (via /asociados) ----------

const listaCotizaciones = document.getElementById('lista-cotizaciones');
const contadorCotizaciones = document.getElementById('contador-cotizaciones');
const listaOrdenes = document.getElementById('lista-ordenes');
const contadorOrdenes = document.getElementById('contador-ordenes');
const listaTareas = document.getElementById('lista-tareas');
const contadorTareas = document.getElementById('contador-tareas');

async function cargarAsociados() {
  const res = await fetch(`/api/contactos/${encodeURIComponent(idContacto)}/asociados`);
  const datos = await res.json();

  contadorCotizaciones.textContent = `(${datos.cotizaciones.length})`;
  listaCotizaciones.innerHTML = datos.cotizaciones.length
    ? datos.cotizaciones.map((q) => `
        <div class="tarjeta-item">
          <a href="cotizaciones.html?cotizacion=${encodeURIComponent(q.id_cotizacion)}">${escaparHtml(q.nombre)}</a>
          <span>${escaparHtml(q.moneda)} ${formatoImporte(q.gran_total)}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin cotizaciones.</p>';

  contadorOrdenes.textContent = `(${datos.ordenes.length})`;
  listaOrdenes.innerHTML = datos.ordenes.length
    ? datos.ordenes.map((o) => `
        <div class="tarjeta-item">
          <span class="tarjeta-item-nombre" data-ir-orden="${escaparHtml(o.id)}">${escaparHtml(o.id)} — ${escaparHtml(o.nombre || '')}</span>
          <span>${formatoImporte(o.importe)}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin órdenes.</p>';

  contadorTareas.textContent = `(${datos.tareas.length})`;
  listaTareas.innerHTML = datos.tareas.length
    ? datos.tareas.map((p) => `
        <div class="tarjeta-item">
          <span>${escaparHtml((p.actividades || []).map((a) => a.actividad).join(', ') || 'Sin actividad')} — ${escaparHtml(p.nombre)}</span>
          <span>${escaparHtml(fechaDe(p.fecha_compromiso))}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin tareas.</p>';
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
let actividadesCache = [];

async function cargarActividadesCache() {
  const res = await fetch('/api/actividades');
  actividadesCache = await res.json();
  nuevaTareaActividades.innerHTML = actividadesCache.map((a) => `
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
      negocio_id: selectNuevaTareaNegocio.value,
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
  if (!idContacto) {
    contactoFicha.innerHTML = '<p>Falta el id del contacto.</p>';
    return;
  }
  permisosCatalogos = sesion.permisos.catalogos;
  formEditarContacto.hidden = true;
  btnEditarContacto.hidden = !permisosCatalogos.editar;
  document.getElementById('btn-mostrar-form-negocio').hidden = !permisosCatalogos.editar;
  document.querySelector('.tarjeta-buscador-wrap').hidden = !permisosCatalogos.editar;
  document.getElementById('agregar-grupo-wrap').hidden = !permisosCatalogos.editar;

  await Promise.all([cargarDestinosDisponibles(), cargarGruposDisponibles(), cargarEtapasNegocioSelect(), cargarActividadesCache()]);
  await cargarContacto();
  await Promise.all([cargarNegociosDeContacto(), cargarAsociados()]);

  suscribirTiempoReal(['contactos', 'contacto_destinos'], () => { cargarContacto(); cargarDestinosDisponibles(); });
  suscribirTiempoReal(['destinos', 'grupos', 'destino_grupos'], () => { cargarDestinosDisponibles(); cargarGruposDisponibles(); });
  suscribirTiempoReal(['negocios'], cargarNegociosDeContacto);
  suscribirTiempoReal(['cotizaciones', 'ordenes', 'pendientes'], cargarAsociados);
  suscribirTiempoReal(['etapas_negocio'], cargarEtapasNegocioSelect);
  suscribirTiempoReal(['actividades'], cargarActividadesCache);
});
