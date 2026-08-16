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

const idGrupo = new URLSearchParams(window.location.search).get('id');
let permisosCatalogos = { ver: false, editar: false, borrar: false };
let grupoActual = null;
let asociadosActual = { destinos: [], cotizaciones: [], ordenes: [], tareas: [] };

const grupoFicha = document.getElementById('grupo-ficha');
const tituloGrupo = document.getElementById('titulo-grupo');
const btnEditarGrupo = document.getElementById('btn-editar-grupo');
const formEditarGrupo = document.getElementById('form-editar-grupo');
const btnCancelarEditarGrupo = document.getElementById('btn-cancelar-editar-grupo');
const editarGrupoNombre = document.getElementById('editar-grupo-nombre');

async function cargarGrupo() {
  const res = await fetch(`/api/grupos/${encodeURIComponent(idGrupo)}`);
  if (!res.ok) {
    grupoFicha.innerHTML = '<p>Grupo no encontrado.</p>';
    return;
  }
  grupoActual = await res.json();
  tituloGrupo.textContent = grupoActual.grupo;
  document.title = `${grupoActual.grupo} · CRM-ON`;
  grupoFicha.innerHTML = campoFicha('Nombre', grupoActual.grupo);
}

btnEditarGrupo.addEventListener('click', () => {
  editarGrupoNombre.value = grupoActual.grupo || '';
  formEditarGrupo.hidden = false;
  btnEditarGrupo.hidden = true;
});

btnCancelarEditarGrupo.addEventListener('click', () => {
  formEditarGrupo.hidden = true;
  btnEditarGrupo.hidden = false;
});

formEditarGrupo.addEventListener('submit', async (e) => {
  e.preventDefault();
  const res = await fetch(`/api/grupos/${encodeURIComponent(idGrupo)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ grupo: editarGrupoNombre.value.trim() }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  formEditarGrupo.hidden = true;
  btnEditarGrupo.hidden = false;
  await cargarGrupo();
});

// ---------- Hoteles / Locales: agregar por buscador, quitar con boton ----------

const listaDestinosGrupo = document.getElementById('lista-destinos-grupo');
const contadorDestinos = document.getElementById('contador-destinos');
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
  const yaAsociados = new Set((asociadosActual.destinos || []).map((d) => d.id_destino));
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
  const res = await fetch(`/api/grupos/${encodeURIComponent(idGrupo)}/destinos`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destino_id: Number(id) }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  buscarDestinoAgregar.value = '';
  opcionesDestinoAgregar.hidden = true;
  await cargarAsociados();
});

listaDestinosGrupo.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-quitar-destino')) return;
  const id = e.target.dataset.id;
  await fetch(`/api/grupos/${encodeURIComponent(idGrupo)}/destinos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  await cargarAsociados();
});

document.addEventListener('click', (e) => {
  if (!e.target.closest('.tarjeta-buscador-wrap')) opcionesDestinoAgregar.hidden = true;
});

// ---------- Cotizaciones, Ordenes, Tareas, Destinos (via /asociados) ----------

const listaCotizaciones = document.getElementById('lista-cotizaciones');
const contadorCotizaciones = document.getElementById('contador-cotizaciones');
const listaOrdenes = document.getElementById('lista-ordenes');
const contadorOrdenes = document.getElementById('contador-ordenes');
const listaTareas = document.getElementById('lista-tareas');
const contadorTareas = document.getElementById('contador-tareas');

async function cargarAsociados() {
  const res = await fetch(`/api/grupos/${encodeURIComponent(idGrupo)}/asociados`);
  asociadosActual = await res.json();

  contadorDestinos.textContent = `(${asociadosActual.destinos.length})`;
  listaDestinosGrupo.innerHTML = asociadosActual.destinos.length
    ? asociadosActual.destinos.map((d) => `
        <div class="tarjeta-item">
          <a href="destino-detalle.html?id=${d.id_destino}">${escaparHtml(d.destino)}</a>
          ${permisosCatalogos.editar ? `<button type="button" class="btn-mini btn-quitar-destino" data-id="${d.id_destino}">Quitar</button>` : ''}
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin hoteles/locales asociados.</p>';

  contadorCotizaciones.textContent = `(${asociadosActual.cotizaciones.length})`;
  listaCotizaciones.innerHTML = asociadosActual.cotizaciones.length
    ? asociadosActual.cotizaciones.map((q) => `
        <div class="tarjeta-item">
          <a href="cotizaciones.html?cotizacion=${encodeURIComponent(q.id_cotizacion)}">${escaparHtml(q.nombre)}</a>
          <span>${escaparHtml(q.moneda)} ${formatoImporte(q.gran_total)}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin cotizaciones.</p>';

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
          <span>${escaparHtml(p.nombre)}</span>
          <span>${escaparHtml(fechaDe(p.fecha_compromiso))}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin tareas.</p>';
}

listaOrdenes.addEventListener('click', (e) => {
  const id = e.target.dataset.irOrden;
  if (id) window.location.href = `ordenes.html?orden=${encodeURIComponent(id)}`;
});

promesaAuth.then(async (sesion) => {
  if (!sesion) return;
  if (!idGrupo) {
    grupoFicha.innerHTML = '<p>Falta el id del grupo.</p>';
    return;
  }
  permisosCatalogos = sesion.permisos.catalogos;
  formEditarGrupo.hidden = true;
  btnEditarGrupo.hidden = !permisosCatalogos.editar;
  document.querySelector('.tarjeta-buscador-wrap').hidden = !permisosCatalogos.editar;

  await cargarDestinosDisponibles();
  await cargarGrupo();
  await cargarAsociados();

  suscribirTiempoReal(['grupos'], cargarGrupo);
  suscribirTiempoReal(['destinos', 'destino_grupos'], () => { cargarDestinosDisponibles(); cargarAsociados(); });
  suscribirTiempoReal(['cotizaciones', 'ordenes', 'pendientes'], cargarAsociados);
});
