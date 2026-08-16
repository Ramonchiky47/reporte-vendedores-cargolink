function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fechaDe(creadoEn) {
  return (creadoEn || '').split(' ')[0];
}

function celdaEstatus(estatus) {
  const clase = estatus === 'Vencido' ? 'estatus-vencido' : 'estatus-vigente';
  return `<span class="${clase}">${escaparHtml(estatus)}</span>`;
}

function tablaOrdenes(ordenes) {
  if (!ordenes.length) return '<p class="pista">Sin órdenes asociadas.</p>';
  return `
    <div class="tabla-scroll">
      <table>
        <thead><tr><th>ID</th><th>Fecha</th><th>Nombre</th><th>Hotel / Local</th><th>Contacto</th><th>Importe</th><th>Estatus</th></tr></thead>
        <tbody>
          ${ordenes.map((o) => `
            <tr class="fila-clicable" data-ir-orden="${escaparHtml(o.id)}" title="Ver detalle de la orden">
              <td>${escaparHtml(o.id)}</td>
              <td>${escaparHtml(o.fecha || '')}</td>
              <td>${escaparHtml(o.nombre || '')}</td>
              <td>${escaparHtml(o.destino_nombre || '')}</td>
              <td>${escaparHtml(o.contacto_nombre || '')}</td>
              <td>${formatoImporte(o.importe)}</td>
              <td>${escaparHtml(o.estatus_nombre || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function tablaCotizaciones(cotizaciones) {
  if (!cotizaciones.length) return '<p class="pista">Sin cotizaciones asociadas.</p>';
  return `
    <div class="tabla-scroll">
      <table>
        <thead><tr><th>ID</th><th>Fecha</th><th>Nombre</th><th>Negocio</th><th>Moneda</th><th>Gran Total</th><th>Etapa</th><th>Estatus</th></tr></thead>
        <tbody>
          ${cotizaciones.map((c) => `
            <tr>
              <td>${escaparHtml(c.id_cotizacion)}</td>
              <td>${escaparHtml(c.fecha_creacion || '')}</td>
              <td>${escaparHtml(c.nombre)}</td>
              <td>${escaparHtml(c.negocio_nombre || '')}</td>
              <td>${escaparHtml(c.moneda)}</td>
              <td>${formatoImporte(c.gran_total)}</td>
              <td>${escaparHtml(c.etapa || '')}</td>
              <td>${celdaEstatus(c.estatus)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function tablaNegocios(negocios) {
  if (!negocios.length) return '<p class="pista">Sin negocios asociados.</p>';
  return `
    <div class="tabla-scroll">
      <table>
        <thead><tr><th>ID</th><th>Fecha</th><th>Negocio</th><th>Etapa</th><th>Importe USD</th><th>Importe MXN</th><th>Estatus</th></tr></thead>
        <tbody>
          ${negocios.map((n) => `
            <tr>
              <td>${escaparHtml(n.id_negocio)}</td>
              <td>${escaparHtml(fechaDe(n.creado_en))}</td>
              <td>${escaparHtml(n.negocio)}</td>
              <td>${escaparHtml(n.etapa_nombre || '')}</td>
              <td>${formatoImporte(n.importe_usd)}</td>
              <td>${formatoImporte(n.importe_mxn)}</td>
              <td>${celdaEstatus(n.estatus)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderContacto(c) {
  return `
    <div class="tarjeta-resultado-buscador">
      <h3>Contacto: <a href="contacto-detalle.html?id=${c.id_contacto}">${escaparHtml(c.nombre_completo)}</a></h3>
      <p class="pista">
        ${c.correo_electronico ? escaparHtml(c.correo_electronico) : 'Sin correo'}
        ${c.telefono_local ? ' · Tel. local: ' + escaparHtml(c.telefono_local) : ''}
        ${c.telefono_celular ? ' · Cel: ' + escaparHtml(c.telefono_celular) : ''}
        ${c.id_publico ? ' · ID ' + escaparHtml(c.id_publico) : ''}
      </p>
      <h4>Órdenes</h4>
      ${tablaOrdenes(c.ordenes)}
      <h4>Cotizaciones</h4>
      ${tablaCotizaciones(c.cotizaciones)}
      <h4>Negocios</h4>
      ${tablaNegocios(c.negocios)}
    </div>
  `;
}

function renderDestino(d) {
  const contactosTexto = (d.contactos || []).map((c) => c.nombre_completo).join(', ') || 'Ninguno';
  return `
    <div class="tarjeta-resultado-buscador">
      <h3>Hotel / Local: <a href="destino-detalle.html?id=${d.id_destino}">${escaparHtml(d.destino)}</a></h3>
      <p class="pista">Contactos asociados: ${escaparHtml(contactosTexto)}</p>
      <h4>Órdenes</h4>
      ${tablaOrdenes(d.ordenes)}
      <h4>Cotizaciones</h4>
      ${tablaCotizaciones(d.cotizaciones)}
    </div>
  `;
}

function renderPlaza(p) {
  return `
    <div class="tarjeta-resultado-buscador">
      <h3>Plaza: <a href="plaza-detalle.html?id=${p.id_empresa}">${escaparHtml(p.empresa)}</a></h3>
      <p class="pista">${p.destinos_asociados} hotel(es)/local(es) asociado(s)</p>
    </div>
  `;
}

function renderGrupo(g) {
  return `
    <div class="tarjeta-resultado-buscador">
      <h3>Grupo: <a href="grupo-detalle.html?id=${g.id_grupo}">${escaparHtml(g.grupo)}</a></h3>
      <p class="pista">${g.destinos_asociados} hotel(es)/local(es) asociado(s)</p>
    </div>
  `;
}

function renderCadena(c) {
  return `
    <div class="tarjeta-resultado-buscador">
      <h3>Cadena: <a href="cadena-detalle.html?id=${c.id_cadena}">${escaparHtml(c.cadena)}</a></h3>
      <p class="pista">${c.destinos_asociados} hotel(es)/local(es) asociado(s)</p>
    </div>
  `;
}

function tablaHistorialCotizaciones(items) {
  if (!items.length) return '<p class="pista">Sin cotizaciones que incluyan este producto.</p>';
  return `
    <div class="tabla-scroll">
      <table>
        <thead><tr><th>Cotización</th><th>Fecha</th><th>Negocio</th><th>Cantidad</th><th>Precio unitario</th><th>Moneda</th><th>Etapa</th></tr></thead>
        <tbody>
          ${items.map((it) => `
            <tr>
              <td>${escaparHtml(it.nombre)} (${escaparHtml(it.id_cotizacion)})</td>
              <td>${escaparHtml(it.fecha_creacion || '')}</td>
              <td>${escaparHtml(it.negocio_nombre || '')}</td>
              <td>${it.cantidad}</td>
              <td>${formatoImporte(it.precio_unitario)}</td>
              <td>${escaparHtml(it.moneda)}</td>
              <td>${escaparHtml(it.etapa || '')}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function tablaHistorialVentas(ventas) {
  if (!ventas.length) return '<p class="pista">Sin ventas registradas en Detalle de compra para este producto.</p>';
  return `
    <div class="tabla-scroll">
      <table>
        <thead><tr><th>Orden</th><th>Fecha</th><th>Artículo</th><th>Cantidad vendida</th><th>Importe</th></tr></thead>
        <tbody>
          ${ventas.map((v) => `
            <tr class="fila-clicable" data-ir-orden="${escaparHtml(v.id)}" title="Ver detalle de la orden">
              <td>${escaparHtml(v.id)}${v.orden_nombre ? ' - ' + escaparHtml(v.orden_nombre) : ''}</td>
              <td>${escaparHtml(v.fecha || '')}</td>
              <td>${escaparHtml(v.articulo || '')}</td>
              <td>${v.cantidad_vendida ?? ''}</td>
              <td>${formatoImporte(v.importe)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
  `;
}

function renderProducto(p) {
  return `
    <div class="tarjeta-resultado-buscador">
      <h3>Producto: ${escaparHtml(p.item)}</h3>
      <p class="pista">
        ${escaparHtml(p.descripcion || '')}
        · USD ${formatoImporte(p.precio_usd)}${p.precio_mxn !== null && p.precio_mxn !== undefined ? ' · MXN ' + formatoImporte(p.precio_mxn) : ''}
      </p>
      <h4>Historial en cotizaciones</h4>
      ${tablaHistorialCotizaciones(p.cotizaciones)}
      <h4>Historial de ventas (Detalle de compra)</h4>
      ${tablaHistorialVentas(p.ventas)}
    </div>
  `;
}

async function buscar(q) {
  const contenedor = document.getElementById('resultados-buscador');
  if (!q || q.trim().length < 2) {
    contenedor.innerHTML = '<p class="pista">Escribe al menos 2 letras en el buscador de arriba para empezar.</p>';
    return;
  }

  contenedor.innerHTML = '<p class="pista">Buscando...</p>';

  const res = await fetch(`/api/buscar-global?q=${encodeURIComponent(q)}`);
  if (!res.ok) {
    contenedor.innerHTML = '<p class="pista">No se pudo realizar la búsqueda.</p>';
    return;
  }
  const data = await res.json();

  const sinResultados = !data.contactos.length && !data.destinos.length && !data.ordenes.length && !data.productos.length
    && !data.plazas.length && !data.grupos.length && !data.cadenas.length;
  if (sinResultados) {
    contenedor.innerHTML = `<p class="pista">Sin resultados para "${escaparHtml(q)}".</p>`;
    return;
  }

  contenedor.innerHTML = `
    ${data.contactos.map(renderContacto).join('')}
    ${data.destinos.map(renderDestino).join('')}
    ${data.plazas.map(renderPlaza).join('')}
    ${data.grupos.map(renderGrupo).join('')}
    ${data.cadenas.map(renderCadena).join('')}
    ${data.productos.map(renderProducto).join('')}
    ${data.ordenes.length ? `
      <div class="tarjeta-resultado-buscador">
        <h3>Órdenes que coinciden directamente</h3>
        ${tablaOrdenes(data.ordenes)}
      </div>
    ` : ''}
  `;
}

// ---------- Detalle de una orden (clic en cualquier fila de orden) ----------

const modalOverlay = document.getElementById('modal-overlay');
const modalContenido = document.getElementById('modal-contenido');
const modalCerrar = document.getElementById('modal-cerrar');

function campoFicha(etiqueta, valor) {
  return `<div><span>${escaparHtml(etiqueta)}</span><p>${valor !== null && valor !== undefined && valor !== '' ? escaparHtml(String(valor)) : '-'}</p></div>`;
}

async function abrirDetalleOrden(id) {
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

document.getElementById('resultados-buscador').addEventListener('click', (e) => {
  const fila = e.target.closest('tr[data-ir-orden]');
  if (!fila) return;
  abrirDetalleOrden(fila.dataset.irOrden);
});

promesaAuth.then((sesion) => {
  if (!sesion) return;
  const q = new URLSearchParams(window.location.search).get('q') || '';
  buscar(q);

  // En esta pantalla el buscador filtra en vivo a partir de 3 letras, sin necesidad de Enter.
  const inputBuscador = document.getElementById('buscador-global-input');
  let temporizadorBuscador;
  inputBuscador.addEventListener('input', () => {
    clearTimeout(temporizadorBuscador);
    const termino = inputBuscador.value.trim();
    temporizadorBuscador = setTimeout(() => {
      if (termino.length >= 3) {
        history.replaceState(null, '', `buscar-global.html?q=${encodeURIComponent(termino)}`);
        buscar(termino);
      } else if (termino.length === 0) {
        history.replaceState(null, '', 'buscar-global.html');
        buscar('');
      }
    }, 250);
  });

  suscribirTiempoReal(
    ['contactos', 'destinos', 'productos', 'ordenes', 'empresas', 'grupos', 'cadenas'],
    () => buscar(inputBuscador.value.trim())
  );
});
