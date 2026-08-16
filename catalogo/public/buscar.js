const MIN_LETRAS = 3;

const input = document.getElementById('buscar-ordenes');
const pista = document.getElementById('pista-busqueda');
const resultados = document.getElementById('resultados');
const estadoVacio = document.getElementById('estado-vacio');

function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function limpiarResultados() {
  resultados.innerHTML = '';
  estadoVacio.hidden = true;
}

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
  if (e.key === 'Escape' && !modalOverlay.hidden) cerrarModal();
});

async function buscarOrdenes() {
  const termino = input.value.trim();
  const parametros = new URLSearchParams();
  if (termino.length >= MIN_LETRAS) parametros.set('q', termino);
  if (estatusSeleccionados.size) parametros.set('estatus', [...estatusSeleccionados].join(','));

  if (!parametros.toString()) {
    limpiarResultados();
    pista.hidden = false;
    pista.textContent = `Escribe al menos ${MIN_LETRAS} letras o selecciona un estatus para buscar.`;
    return;
  }

  pista.hidden = true;
  const res = await fetch(`/api/ordenes?${parametros}`);
  const ordenes = await res.json();
  renderizar(ordenes);
}

function renderizar(ordenes) {
  resultados.innerHTML = '';
  estadoVacio.hidden = ordenes.length !== 0;

  for (const o of ordenes) {
    const tarjeta = document.createElement('div');
    tarjeta.className = 'tarjeta-producto';
    tarjeta.innerHTML = `
      <h3>${escaparHtml(o.id)} · ${escaparHtml(o.nombre || '')}</h3>
      <p class="descripcion">OC: ${escaparHtml(o.numero_oc || '-')} · Fecha: ${escaparHtml(o.fecha || '-')}</p>
      <p class="precio">${o.importe !== null ? '$' + formatoImporte(o.importe) : ''}</p>
      <p class="stock">Estatus: ${escaparHtml(o.estatus_nombre || '-')}</p>
      <p class="stock">Hotel / Local: ${escaparHtml(o.destino_nombre || "-")} · Contacto: ${escaparHtml(o.contacto_nombre || '-')}</p>
    `;
    tarjeta.addEventListener('click', () => abrirDetalle(o.id));
    resultados.appendChild(tarjeta);
  }
}

// ---------- Filtro multi-seleccion de Estatus ----------

const filtroEstatusBtn = document.getElementById('filtro-estatus-btn');
const filtroEstatusPanel = document.getElementById('filtro-estatus-panel');
const estatusSeleccionados = new Set();

async function cargarFiltroEstatus() {
  const res = await fetch('/api/estatus');
  const lista = (await res.json()).filter((e) => e.estatus);

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
      <input type="checkbox" value="${e.id_estatus}" /> ${escaparHtml(e.estatus)}
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
  buscarOrdenes();
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('filtro-estatus-wrap').contains(e.target)) {
    filtroEstatusPanel.hidden = true;
  }
});

let temporizador;
input.addEventListener('input', () => {
  clearTimeout(temporizador);
  temporizador = setTimeout(buscarOrdenes, 250);
});

promesaAuth.then((sesion) => {
  if (!sesion) return;
  if (!sesion.permisos.ordenes.ver) window.location.href = 'panel.html';
  cargarFiltroEstatus();

  // Enlace directo con termino precargado (ej. desde el Panel General): ?q=articulo
  const qUrl = new URLSearchParams(window.location.search).get('q');
  if (qUrl) {
    input.value = qUrl;
    buscarOrdenes();
  }

  suscribirTiempoReal(['ordenes'], buscarOrdenes);
  suscribirTiempoReal(['estatus_catalogo'], () => { cargarFiltroEstatus(); buscarOrdenes(); });
});
