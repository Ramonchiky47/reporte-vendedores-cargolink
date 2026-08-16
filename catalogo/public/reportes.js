function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const filtroArticulo = document.getElementById('filtro-articulo');
const filtroHotel = document.getElementById('filtro-hotel');
const filtroEstatusBtn = document.getElementById('filtro-estatus-btn');
const filtroEstatusPanel = document.getElementById('filtro-estatus-panel');
const resumenReporte = document.getElementById('resumen-reporte');
const tablaReporte = document.getElementById('tabla-reporte');
const totalCantidad = document.getElementById('total-cantidad');
const totalImporte = document.getElementById('total-importe');
const estadoVacio = document.getElementById('estado-vacio');

const estatusSeleccionados = new Set();

// ---------- Filtro multi-seleccion de Estatus (preseleccionado en "Pendiente") ----------

async function cargarFiltroEstatus() {
  const res = await fetch('/api/estatus');
  const lista = (await res.json()).filter((e) => e.estatus);

  const pendiente = lista.find((e) => e.estatus === 'Pendiente');
  if (pendiente) estatusSeleccionados.add(String(pendiente.id_estatus));

  if (!lista.length) {
    filtroEstatusPanel.innerHTML = '<p class="pista">No hay estatus capturados.</p>';
    return;
  }

  filtroEstatusPanel.innerHTML = `
    <label class="multi-select-opcion multi-select-todos">
      <input type="checkbox" id="filtro-estatus-todos" /> Seleccionar todos
    </label>
  ` + lista.map((e) => `
    <label class="multi-select-opcion">
      <input type="checkbox" value="${e.id_estatus}" ${estatusSeleccionados.has(String(e.id_estatus)) ? 'checked' : ''} /> ${escaparHtml(e.estatus)}
    </label>
  `).join('');

  actualizarBotonFiltroEstatus();
}

function actualizarBotonFiltroEstatus() {
  if (estatusSeleccionados.size === 0) {
    filtroEstatusBtn.textContent = 'Todos los estatus';
  } else if (estatusSeleccionados.size === 1) {
    const opcion = filtroEstatusPanel.querySelector(`input[value="${[...estatusSeleccionados][0]}"]`);
    filtroEstatusBtn.textContent = opcion ? opcion.parentElement.textContent.trim() : '1 estatus seleccionado';
  } else {
    filtroEstatusBtn.textContent = `${estatusSeleccionados.size} estatus seleccionados`;
  }
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
  cargarReporte();
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('filtro-estatus-wrap').contains(e.target)) {
    filtroEstatusPanel.hidden = true;
  }
});

// ---------- Reporte ----------

let ultimasFilas = [];
const orden = { campo: null, direccion: 'asc' };

async function cargarReporte() {
  const parametros = new URLSearchParams();
  parametros.set('estatus', [...estatusSeleccionados].join(','));
  const articulo = filtroArticulo.value.trim();
  if (articulo) parametros.set('articulo', articulo);
  const hotel = filtroHotel.value.trim();
  if (hotel) parametros.set('hotel', hotel);

  const res = await fetch(`/api/reportes/articulos?${parametros}`);
  const data = await res.json();
  ultimasFilas = data.filas;
  ordenarYRenderizar();
}

function comparar(va, vb) {
  if (va === null || va === undefined) va = '';
  if (vb === null || vb === undefined) vb = '';
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), 'es', { numeric: true });
}

function ordenarYRenderizar() {
  let filas = ultimasFilas;
  if (orden.campo) {
    filas = [...ultimasFilas].sort((a, b) => {
      const cmp = comparar(a[orden.campo], b[orden.campo]);
      return orden.direccion === 'asc' ? cmp : -cmp;
    });
  }
  renderizar(filas);
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

function renderizar(filas) {
  tablaReporte.innerHTML = '';
  estadoVacio.hidden = filas.length !== 0;

  let cantidadTotal = 0;
  let importeTotal = 0;

  for (const f of filas) {
    cantidadTotal += f.cantidad_total || 0;
    importeTotal += f.importe_total || 0;

    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escaparHtml(f.hotel || '(sin hotel/local)')}</td>
      <td>${escaparHtml(f.articulo)}</td>
      <td>${f.cantidad_total ?? ''}</td>
      <td>${formatoImporte(f.importe_total)}</td>
      <td><button type="button" class="btn-ordenes-combo" data-hotel="${escaparHtml(f.hotel || '')}" data-articulo="${escaparHtml(f.articulo)}">${f.num_ordenes}</button></td>
    `;
    tablaReporte.appendChild(tr);
  }

  totalCantidad.textContent = filas.length ? cantidadTotal : '';
  totalImporte.textContent = filas.length ? formatoImporte(importeTotal) : '';

  resumenReporte.textContent = filas.length
    ? `${filas.length} combinación(es) hotel/artículo · ${cantidadTotal} unidades · $${formatoImporte(importeTotal)}`
    : '';
}

let temporizador;
filtroArticulo.addEventListener('input', () => {
  clearTimeout(temporizador);
  temporizador = setTimeout(cargarReporte, 250);
});
filtroHotel.addEventListener('input', () => {
  clearTimeout(temporizador);
  temporizador = setTimeout(cargarReporte, 250);
});

// ---------- Tarjetas de ordenes (al hacer clic en el numero de "Ordenes") ----------

const modalOrdenesOverlay = document.getElementById('modal-ordenes-overlay');
const modalOrdenesContenido = document.getElementById('modal-ordenes-contenido');
const modalOrdenesCerrar = document.getElementById('modal-ordenes-cerrar');

async function abrirTarjetasOrdenes(hotel, articulo) {
  const parametros = new URLSearchParams();
  parametros.set('articulo', articulo);
  if (hotel) parametros.set('hotel', hotel);
  parametros.set('estatus', [...estatusSeleccionados].join(','));

  const res = await fetch(`/api/reportes/ordenes?${parametros}`);
  const ordenes = await res.json();

  modalOrdenesContenido.innerHTML = `
    <h2>${escaparHtml(articulo)}</h2>
    <p class="pista">${escaparHtml(hotel || '(sin hotel/local)')} · ${ordenes.length} orden(es)</p>
    <div class="resultados">
      ${ordenes.map((o) => `
        <div class="tarjeta-producto tarjeta-orden" data-id="${escaparHtml(o.id)}">
          <h3>${escaparHtml(o.id)} · ${escaparHtml(o.nombre || '')}</h3>
          <p class="descripcion">OC: ${escaparHtml(o.numero_oc || '-')} · Fecha: ${escaparHtml(o.fecha || '-')}</p>
          <p class="precio">${o.importe !== null ? '$' + formatoImporte(o.importe) : ''}</p>
          <p class="stock">Estatus: ${escaparHtml(o.estatus_nombre || '-')}</p>
          <p class="stock">Contacto: ${escaparHtml(o.contacto_nombre || '-')}</p>
        </div>
      `).join('')}
    </div>
  `;

  modalOrdenesOverlay.hidden = false;
}

function cerrarModalOrdenes() {
  modalOrdenesOverlay.hidden = true;
  modalOrdenesContenido.innerHTML = '';
}

tablaReporte.addEventListener('click', (e) => {
  if (!e.target.classList.contains('btn-ordenes-combo')) return;
  abrirTarjetasOrdenes(e.target.dataset.hotel, e.target.dataset.articulo);
});

modalOrdenesCerrar.addEventListener('click', cerrarModalOrdenes);
modalOrdenesOverlay.addEventListener('click', (e) => {
  if (e.target === modalOrdenesOverlay) cerrarModalOrdenes();
});

modalOrdenesContenido.addEventListener('click', (e) => {
  const tarjeta = e.target.closest('.tarjeta-orden');
  if (tarjeta) abrirDetalle(tarjeta.dataset.id);
});

// ---------- Modal de detalle de una orden (misma ficha que en Buscar) ----------

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

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!modalOverlay.hidden) cerrarModal();
  else if (!modalOrdenesOverlay.hidden) cerrarModalOrdenes();
});

promesaAuth.then((sesion) => {
  if (!sesion) return;
  if (!sesion.permisos.ordenes.ver) {
    window.location.href = 'panel.html';
    return;
  }
  cargarFiltroEstatus().then(cargarReporte);

  suscribirTiempoReal(['ordenes'], cargarReporte);
  suscribirTiempoReal(['estatus_catalogo'], () => cargarFiltroEstatus().then(cargarReporte));
});
