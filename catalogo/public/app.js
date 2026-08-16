const form = document.getElementById('form-orden');
const inputIdOriginal = document.getElementById('orden-id-original');
const campos = {
  id: document.getElementById('id'),
  fecha: document.getElementById('fecha'),
  imprimir: document.getElementById('imprimir'),
  nombre: document.getElementById('nombre'),
  numero_oc: document.getElementById('numero_oc'),
  estatus_sistema: document.getElementById('estatus_sistema'),
  numero_seguimiento: document.getElementById('numero_seguimiento'),
  estatus_id: document.getElementById('estatus_id'),
  moneda: document.getElementById('moneda'),
  importe_moneda_extranjera: document.getElementById('importe_moneda_extranjera'),
  importe: document.getElementById('importe'),
  estado_entrega_id: document.getElementById('estado_entrega_id'),
  destino_id: document.getElementById('destino_id'),
  contacto_id: document.getElementById('contacto_id'),
  nota: document.getElementById('nota'),
  observaciones: document.getElementById('observaciones'),
};
const btnGuardar = document.getElementById('btn-guardar');
const btnCancelar = document.getElementById('btn-cancelar');
const btnMostrarForm = document.getElementById('btn-mostrar-form');
const tabla = document.getElementById('tabla-ordenes');
const estadoVacio = document.getElementById('estado-vacio');
const buscar = document.getElementById('buscar');
const filtroEstatusBtn = document.getElementById('filtro-estatus-btn');
const filtroEstatusPanel = document.getElementById('filtro-estatus-panel');
const estatusSeleccionados = new Set();
const checkTodosOrdenes = document.getElementById('check-todos-ordenes');
const btnEnviarTareasOrdenes = document.getElementById('btn-enviar-tareas-ordenes');
const ordenesSeleccionadas = new Set();

function actualizarBotonEnviarTareasOrdenes() {
  btnEnviarTareasOrdenes.textContent = `Enviar a tareas (${ordenesSeleccionadas.size})`;
  btnEnviarTareasOrdenes.disabled = ordenesSeleccionadas.size === 0;
}

function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- Modal de detalle (misma ficha que en Buscar) ----------

const modalOverlay = document.getElementById('modal-overlay');
const modalContenido = document.getElementById('modal-contenido');
const modalCerrar = document.getElementById('modal-cerrar');

function campoFicha(etiqueta, valor) {
  return `<div><span>${escaparHtml(etiqueta)}</span><p>${valor !== null && valor !== undefined && valor !== '' ? escaparHtml(String(valor)) : '-'}</p></div>`;
}

async function abrirDetalle(id) {
  const [orden, articulos] = await Promise.all([
    fetch(`/api/ordenes/${encodeURIComponent(id)}`).then((r) => r.json()),
    fetch(`/api/detalle-compra?id=${encodeURIComponent(id)}`).then((r) => r.json()),
  ]);

  modalContenido.innerHTML = `
    <h2>${escaparHtml(orden.id)}</h2>
    ${permisosOrdenes.editar ? `<button type="button" class="btn-editar-orden-modal" data-id="${escaparHtml(orden.id)}">Editar</button>` : ''}
    <div class="ficha-detalle">
      ${campoFicha('Fecha', orden.fecha)}
      ${campoFicha('Nombre', orden.nombre)}
      ${campoFicha('Número de OC/cheque', orden.numero_oc)}
      ${campoFicha('Estatus', orden.estatus_nombre)}
      ${campoFicha('Estatus del sistema', orden.estatus_sistema)}
      ${campoFicha('Número de seguimiento', orden.numero_seguimiento)}
      ${campoFicha('Moneda', orden.moneda)}
      ${campoFicha('Importe (moneda extranjera)', orden.importe_moneda_extranjera !== null ? formatoImporte(orden.importe_moneda_extranjera) : null)}
      ${campoFicha('Importe', orden.importe !== null ? formatoImporte(orden.importe) : null)}
      ${campoFicha('Hotel / Local', orden.destino_nombre)}
      ${campoFicha('Contacto', orden.contacto_nombre)}
      ${campoFicha('Estado de la República', orden.estado_entrega_nombre)}
      ${campoFicha('Imprimir', orden.imprimir)}
    </div>
    ${orden.nota ? `<p><strong>Nota:</strong> ${escaparHtml(orden.nota)}</p>` : ''}
    ${orden.observaciones ? `<p><strong>Observaciones:</strong> ${escaparHtml(orden.observaciones)}</p>` : ''}
    <h3>Artículos (${articulos.length})</h3>
    ${articulos.length ? `
      <div class="tabla-scroll">
        <table>
          <thead><tr><th>Artículo</th><th>Tipo</th><th>Fecha</th><th>Serie</th><th>Cantidad</th><th>Importe</th></tr></thead>
          <tbody>
            ${articulos.map((a) => `
              <tr>
                <td>${escaparHtml(a.articulo || '')}</td>
                <td>${escaparHtml(a.tipo || '')}</td>
                <td>${escaparHtml(a.fecha || '')}</td>
                <td>${escaparHtml(a.numero_serie || '')}</td>
                <td>${a.cantidad_vendida ?? ''}</td>
                <td>${formatoImporte(a.importe)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>
    ` : '<p class="pista">Esta orden no tiene artículos capturados en Detalle de compra.</p>'}
  `;

  modalOverlay.hidden = false;
}

function cerrarModal() {
  modalOverlay.hidden = true;
  modalContenido.innerHTML = '';
}

modalCerrar.addEventListener('click', cerrarModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) cerrarModal();
});

modalContenido.addEventListener('click', async (e) => {
  if (!e.target.classList.contains('btn-editar-orden-modal')) return;
  const id = e.target.dataset.id;
  const res = await fetch(`/api/ordenes/${encodeURIComponent(id)}`);
  const o = await res.json();
  cerrarModal();
  cargarOrdenEnFormulario(o);
});

// ---------- Alta rapida de Destino/Contacto (cuando no existen en el desplegable) ----------

const modalRapidoOverlay = document.getElementById('modal-rapido-overlay');
const modalRapidoCerrar = document.getElementById('modal-rapido-cerrar');
const modalRapidoTitulo = document.getElementById('modal-rapido-titulo');
const modalRapidoEtiqueta = document.getElementById('modal-rapido-etiqueta');
const modalRapidoNombre = document.getElementById('modal-rapido-nombre');
const formRapido = document.getElementById('form-rapido');
const btnNuevoDestino = document.getElementById('btn-nuevo-destino');
const btnNuevoContacto = document.getElementById('btn-nuevo-contacto');

let tipoModalRapido = null;

function abrirModalRapido(tipo) {
  tipoModalRapido = tipo;
  modalRapidoTitulo.textContent = tipo === 'destino' ? 'Nuevo hotel/local' : 'Nuevo contacto';
  modalRapidoEtiqueta.textContent = tipo === 'destino' ? 'Nombre del hotel/local' : 'Nombre del contacto';
  modalRapidoNombre.value = '';
  modalRapidoOverlay.hidden = false;
  modalRapidoNombre.focus();
}

function cerrarModalRapido() {
  modalRapidoOverlay.hidden = true;
  tipoModalRapido = null;
}

btnNuevoDestino.addEventListener('click', () => abrirModalRapido('destino'));
btnNuevoContacto.addEventListener('click', () => abrirModalRapido('contacto'));
modalRapidoCerrar.addEventListener('click', cerrarModalRapido);
modalRapidoOverlay.addEventListener('click', (e) => {
  if (e.target === modalRapidoOverlay) cerrarModalRapido();
});

formRapido.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = modalRapidoNombre.value.trim();
  if (!nombre) return;

  const endpoint = tipoModalRapido === 'destino' ? '/api/destinos' : '/api/contactos';
  const payload = tipoModalRapido === 'destino' ? { destino: nombre } : { nombre };

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }

  const creado = await res.json();
  const select = tipoModalRapido === 'destino' ? campos.destino_id : campos.contacto_id;
  const opt = document.createElement('option');
  opt.value = tipoModalRapido === 'destino' ? creado.id_destino : creado.id_contacto;
  opt.textContent = tipoModalRapido === 'destino' ? creado.destino : creado.nombre;
  select.appendChild(opt);
  select.value = opt.value;

  cerrarModalRapido();
});

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!modalOverlay.hidden) cerrarModal();
  if (!modalRapidoOverlay.hidden) cerrarModalRapido();
});

let ultimaListaOrdenes = [];
const orden = { campo: 'fecha', direccion: 'desc' };

function comparar(va, vb) {
  if (va === null || va === undefined) va = '';
  if (vb === null || vb === undefined) vb = '';
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), 'es', { numeric: true });
}

function ordenarYRenderizar() {
  const lista = [...ultimaListaOrdenes].sort((a, b) => {
    const cmp = comparar(a[orden.campo], b[orden.campo]);
    return orden.direccion === 'asc' ? cmp : -cmp;
  });
  renderizar(lista);
  actualizarIndicadoresOrden();
}

function actualizarIndicadoresOrden() {
  document.querySelectorAll('th[data-campo]').forEach((th) => {
    if (!th.dataset.etiqueta) th.dataset.etiqueta = th.textContent.trim();
    const base = th.dataset.etiqueta;
    th.textContent = th.dataset.campo === orden.campo
      ? `${base} ${orden.direccion === 'asc' ? '▲' : '▼'}`
      : base;
  });
}

document.querySelectorAll('th[data-campo]').forEach((th) => {
  th.classList.add('th-ordenable');
  th.addEventListener('click', () => {
    if (orden.campo === th.dataset.campo) {
      orden.direccion = orden.direccion === 'asc' ? 'desc' : 'asc';
    } else {
      orden.campo = th.dataset.campo;
      orden.direccion = 'asc';
    }
    ordenarYRenderizar();
  });
});

function poblarSelect(select, lista, campoValor, campoTexto) {
  for (const item of lista) {
    const opt = document.createElement('option');
    opt.value = item[campoValor];
    opt.textContent = item[campoTexto];
    select.appendChild(opt);
  }
}

async function cargarCatalogos() {
  const [destinos, contactos, estatusLista, estadosEntrega] = await Promise.all([
    fetch('/api/destinos').then((r) => r.json()),
    fetch('/api/contactos').then((r) => r.json()),
    fetch('/api/estatus').then((r) => r.json()),
    fetch('/api/estados-entrega').then((r) => r.json()),
  ]);

  poblarSelect(campos.destino_id, destinos, 'id_destino', 'destino');
  poblarSelect(campos.contacto_id, contactos, 'id_contacto', 'nombre_completo');
  poblarSelect(campos.estatus_id, estatusLista, 'id_estatus', 'estatus');
  poblarSelect(campos.estado_entrega_id, estadosEntrega, 'id_estado_entrega', 'estado_entrega');
}

async function cargarFiltroEstatus() {
  const res = await fetch('/api/estatus');
  const lista = (await res.json()).filter((e) => e.estatus);

  if (!lista.length) {
    filtroEstatusPanel.innerHTML = '<p class="pista">No hay estatus capturados.</p>';
    return;
  }

  filtroEstatusPanel.innerHTML = `
    <label class="multi-select-opcion multi-select-todos">
      <input type="checkbox" id="filtro-estatus-todos" /><span class="multi-select-texto">Seleccionar todos</span>
    </label>
  ` + lista.map((e) => `
    <label class="multi-select-opcion">
      <input type="checkbox" value="${e.id_estatus}" /><span class="multi-select-texto">${escaparHtml(e.estatus)}</span>
    </label>
  `).join('');
}

function actualizarBotonFiltroEstatus() {
  filtroEstatusBtn.textContent = estatusSeleccionados.size
    ? `${estatusSeleccionados.size} estatus seleccionado(s)`
    : 'Todos los estatus';
}

filtroEstatusBtn.addEventListener('click', () => {
  filtroEstatusPanel.hidden = !filtroEstatusPanel.hidden;
});

filtroEstatusPanel.addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;

  if (e.target.id === 'filtro-estatus-todos') {
    filtroEstatusPanel.querySelectorAll('input[type="checkbox"]:not(#filtro-estatus-todos)').forEach((cb) => {
      cb.checked = e.target.checked;
      if (e.target.checked) estatusSeleccionados.add(cb.value);
      else estatusSeleccionados.delete(cb.value);
    });
  } else if (e.target.checked) {
    estatusSeleccionados.add(e.target.value);
  } else {
    estatusSeleccionados.delete(e.target.value);
  }

  actualizarBotonFiltroEstatus();
  cargarOrdenes();
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('filtro-estatus-wrap').contains(e.target)) {
    filtroEstatusPanel.hidden = true;
  }
});

async function cargarOrdenes() {
  const parametros = new URLSearchParams();
  const q = buscar.value.trim();
  if (q) parametros.set('q', q);
  if (estatusSeleccionados.size) parametros.set('estatus', [...estatusSeleccionados].join(','));

  const url = parametros.toString() ? `/api/ordenes?${parametros}` : '/api/ordenes';
  const res = await fetch(url);
  ultimaListaOrdenes = await res.json();
  ordenarYRenderizar();
}

let permisosOrdenes = { ver: true, editar: true, borrar: true };

function renderizar(ordenes) {
  tabla.innerHTML = '';
  estadoVacio.hidden = ordenes.length !== 0;

  for (const o of ordenes) {
    const tr = document.createElement('tr');
    tr.dataset.id = o.id;
    if (o.estatus_nombre === '2.-Facturada') tr.classList.add('fila-facturada');
    else if (o.estatus_nombre === '1.-Cancelado') tr.classList.add('fila-cancelado');
    if (o.tiene_tarea_activa) tr.classList.add('fila-en-tareas');
    tr.innerHTML = `
      <td><input type="checkbox" class="check-orden" value="${escaparHtml(o.id)}" ${ordenesSeleccionadas.has(o.id) ? 'checked' : ''} /></td>
      <td>${escaparHtml(o.id)}</td>
      <td>${escaparHtml(o.fecha || '')}</td>
      <td>${escaparHtml(o.estatus_nombre || '')}</td>
      <td>${formatoImporte(o.importe)}</td>
      <td>${escaparHtml(o.destino_nombre || '')}</td>
      <td>${escaparHtml(o.contacto_nombre || '')}</td>
      <td>${escaparHtml(o.estado_entrega_nombre || '')}</td>
      <td class="acciones">
        ${permisosOrdenes.editar ? `<button class="btn-editar" data-id="${escaparHtml(o.id)}">Editar</button>` : ''}
        ${permisosOrdenes.borrar ? `<button class="btn-borrar" data-id="${escaparHtml(o.id)}">Borrar</button>` : ''}
      </td>
    `;
    tabla.appendChild(tr);
  }
  checkTodosOrdenes.checked = ordenes.length > 0 && ordenes.every((o) => ordenesSeleccionadas.has(o.id));
}

function limpiarFormulario() {
  inputIdOriginal.value = '';
  form.reset();
  campos.id.disabled = false;
  btnGuardar.textContent = 'Agregar orden';
}

function abrirFormulario() {
  form.hidden = false;
  btnMostrarForm.hidden = true;
}

function cerrarFormulario() {
  limpiarFormulario();
  form.hidden = true;
  btnMostrarForm.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const payload = {
    id: campos.id.value.trim(),
    fecha: campos.fecha.value,
    imprimir: campos.imprimir.value.trim(),
    nombre: campos.nombre.value.trim(),
    numero_oc: campos.numero_oc.value.trim(),
    estatus_sistema: campos.estatus_sistema.value.trim(),
    numero_seguimiento: campos.numero_seguimiento.value.trim(),
    estatus_id: campos.estatus_id.value,
    moneda: campos.moneda.value,
    importe_moneda_extranjera: campos.importe_moneda_extranjera.value,
    importe: campos.importe.value,
    estado_entrega_id: campos.estado_entrega_id.value,
    destino_id: campos.destino_id.value,
    contacto_id: campos.contacto_id.value,
    nota: campos.nota.value.trim(),
    observaciones: campos.observaciones.value.trim(),
  };

  const idOriginal = inputIdOriginal.value;
  const esEdicion = Boolean(idOriginal);

  const res = await fetch(esEdicion ? `/api/ordenes/${idOriginal}` : '/api/ordenes', {
    method: esEdicion ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error al guardar: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }

  cerrarFormulario();
  cargarOrdenes();
});

btnCancelar.addEventListener('click', cerrarFormulario);
btnMostrarForm.addEventListener('click', abrirFormulario);

tabla.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;

  if (e.target.classList.contains('btn-borrar')) {
    if (!confirmarDoble('¿Seguro que quieres borrar esta orden?')) return;
    await fetch(`/api/ordenes/${encodeURIComponent(id)}`, { method: 'DELETE' });
    cargarOrdenes();
  }

  if (e.target.classList.contains('btn-editar')) {
    const res = await fetch(`/api/ordenes/${encodeURIComponent(id)}`);
    const o = await res.json();
    cargarOrdenEnFormulario(o);
  }
});

function cargarOrdenEnFormulario(o) {
  inputIdOriginal.value = o.id;
  campos.id.value = o.id;
  campos.id.disabled = true;
  campos.fecha.value = o.fecha || '';
  campos.imprimir.value = o.imprimir || '';
  campos.nombre.value = o.nombre || '';
  campos.numero_oc.value = o.numero_oc || '';
  campos.estatus_sistema.value = o.estatus_sistema || '';
  campos.numero_seguimiento.value = o.numero_seguimiento || '';
  campos.estatus_id.value = o.estatus_id ?? '';
  campos.moneda.value = o.moneda ?? '';
  campos.importe_moneda_extranjera.value = o.importe_moneda_extranjera ?? '';
  campos.importe.value = o.importe ?? '';
  campos.estado_entrega_id.value = o.estado_entrega_id ?? '';
  campos.destino_id.value = o.destino_id ?? '';
  campos.contacto_id.value = o.contacto_id ?? '';
  campos.nota.value = o.nota || '';
  campos.observaciones.value = o.observaciones || '';

  btnGuardar.textContent = 'Guardar cambios';
  abrirFormulario();
  campos.fecha.focus();
}

tabla.addEventListener('click', (e) => {
  if (e.target.closest('button') || e.target.classList.contains('check-orden')) return;
  const fila = e.target.closest('tr');
  if (!fila) return;
  abrirDetalle(fila.dataset.id);
});

tabla.addEventListener('change', (e) => {
  if (!e.target.classList.contains('check-orden')) return;
  if (e.target.checked) ordenesSeleccionadas.add(e.target.value);
  else ordenesSeleccionadas.delete(e.target.value);
  checkTodosOrdenes.checked = [...tabla.querySelectorAll('.check-orden')].every((cb) => cb.checked);
  actualizarBotonEnviarTareasOrdenes();
});

checkTodosOrdenes.addEventListener('change', () => {
  tabla.querySelectorAll('.check-orden').forEach((cb) => {
    cb.checked = checkTodosOrdenes.checked;
    if (checkTodosOrdenes.checked) ordenesSeleccionadas.add(cb.value);
    else ordenesSeleccionadas.delete(cb.value);
  });
  actualizarBotonEnviarTareasOrdenes();
});

// Envia a Tareas (como pendientes de Seguimiento) todas las ordenes marcadas con checkbox.
btnEnviarTareasOrdenes.addEventListener('click', async () => {
  if (!ordenesSeleccionadas.size) return;

  const actividades = await fetch('/api/actividades').then((r) => r.json());
  const seguimiento = actividades.find((a) => a.actividad.trim().toLowerCase() === 'seguimiento');
  if (!seguimiento) {
    alert('No existe la actividad "Seguimiento" en Catálogos → Actividades. Créala primero.');
    return;
  }

  const idsSeleccionados = [...ordenesSeleccionadas];
  let enviados = 0;
  const errores = [];

  for (const id of idsSeleccionados) {
    const ordenDatos = ultimaListaOrdenes.find((o) => o.id === id);
    if (!ordenDatos) continue;
    const res = await fetch('/api/pendientes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: `Seguimiento: ${id}${ordenDatos.nombre ? ' - ' + ordenDatos.nombre : ''}`,
        actividades: [seguimiento.id_actividad],
        orden_id: id,
      }),
    });
    if (res.ok) {
      enviados++;
    } else {
      const error = await res.json().catch(() => ({}));
      errores.push(`${id}: ${error.errores ? error.errores.join(', ') : res.statusText}`);
    }
  }

  ordenesSeleccionadas.clear();
  actualizarBotonEnviarTareasOrdenes();
  await cargarOrdenes();

  if (errores.length) {
    alert(`Se enviaron ${enviados} de ${idsSeleccionados.length} orden(es) a Tareas.\n\nErrores:\n${errores.join('\n')}`);
  } else {
    alert(`Se enviaron ${enviados} orden(es) a Tareas de seguimiento.`);
  }
});

let temporizadorBusqueda;
buscar.addEventListener('input', () => {
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(cargarOrdenes, 250);
});

promesaAuth.then((sesion) => {
  if (!sesion) return;
  permisosOrdenes = sesion.permisos.ordenes;
  if (!permisosOrdenes.editar) btnMostrarForm.hidden = true;

  cargarCatalogos().then(cargarOrdenes).then(() => {
    // Se llego desde el detalle de un Contacto/Hotel-Local: abre directo esa orden.
    const ordenId = new URLSearchParams(window.location.search).get('orden');
    if (ordenId) abrirDetalle(ordenId);
  });
  cargarFiltroEstatus();

  suscribirTiempoReal(['ordenes'], cargarOrdenes);
  suscribirTiempoReal(['destinos', 'contactos', 'estados_entrega'], cargarCatalogos);
  suscribirTiempoReal(['estatus_catalogo'], () => { cargarCatalogos(); cargarFiltroEstatus(); });
});
