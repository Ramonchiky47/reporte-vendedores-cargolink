function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

const DIAS_SEMANA = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];

function fechaLarga(fecha) {
  return `${DIAS_SEMANA[fecha.getDay()]} ${fecha.getDate()} de ${MESES[fecha.getMonth()]}`;
}

document.getElementById('panel-fecha').innerHTML = `<strong>${fechaLarga(new Date())}</strong>`;

const etapasPipelineOrdinal = ['Prospeccion', 'Calificacion', 'Contacto', 'Cotizacion', 'Negociacion'];

function colorEtapaPipeline(nombreEtapa, indiceEnCurso) {
  if (nombreEtapa === 'Cierre Ganado') return 'var(--exito)';
  if (nombreEtapa === 'Cierre Perdido') return 'var(--peligro)';
  const pasos = ['var(--dato-250)', 'var(--dato-400)', 'var(--dato-450)', 'var(--dato-500)', 'var(--dato-600)'];
  return pasos[indiceEnCurso % pasos.length];
}

function renderizarPipeline(pipeline) {
  const contenedor = document.getElementById('pipeline-lista');
  const maximo = Math.max(1, ...pipeline.map((p) => p.cantidad));
  let indiceEnCurso = 0;
  contenedor.innerHTML = pipeline.map((p) => {
    const color = colorEtapaPipeline(p.etapa, indiceEnCurso);
    if (!['Cierre Ganado', 'Cierre Perdido'].includes(p.etapa)) indiceEnCurso++;
    const ancho = Math.max(4, Math.round((p.cantidad / maximo) * 100));
    return `
      <div class="pipeline__fila" tabindex="0" data-href="cotizaciones.html?tab=negocios" title="Ver Negocios">
        <span class="pipeline__etapa">${escaparHtml(p.etapa)}</span>
        <span class="pipeline__pista"><span class="pipeline__barra" style="width:${ancho}%; background:${color}"></span></span>
        <span class="pipeline__valor">${p.cantidad}</span>
      </div>
    `;
  }).join('');
}

function diasHasta(fechaIso) {
  const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
  const [y, m, d] = fechaIso.split('-').map(Number);
  const fecha = new Date(y, m - 1, d);
  return Math.round((fecha - hoy) / 86400000);
}

function chipVencimiento(fechaIso) {
  const dias = diasHasta(fechaIso);
  if (dias <= 0) return '<span class="chip es-critico">Vence hoy</span>';
  if (dias <= 3) return `<span class="chip es-alerta">Vence en ${dias} día${dias === 1 ? '' : 's'}</span>`;
  return `<span class="chip es-bueno">Vigente ${dias} días</span>`;
}

function renderizarCotizacionesPorVencer(lista) {
  const contenedor = document.getElementById('lista-vencer');
  contenedor.innerHTML = lista.length
    ? lista.map((c) => `
        <div class="fila-lista" tabindex="0" data-href="cotizaciones.html?cotizacion=${encodeURIComponent(c.id_cotizacion)}" title="Abrir cotización">
          <div class="fila-lista__texto">
            <div class="fila-lista__principal">${escaparHtml(c.id_cotizacion)} &middot; ${escaparHtml(c.destino_nombre || c.nombre)}</div>
            <div class="fila-lista__secundario">${escaparHtml(c.contacto_nombre || '')} &middot; ${escaparHtml(c.moneda)} ${formatoImporte(c.gran_total)}</div>
          </div>
          ${chipVencimiento(c.fecha_vencimiento)}
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin cotizaciones por vencer.</p>';
}

function renderizarTopArticulos(lista) {
  const contenedor = document.getElementById('lista-articulos');
  const maximo = Math.max(1, ...lista.map((a) => Number(a.total)));
  contenedor.innerHTML = lista.length
    ? lista.map((a) => `
        <div class="articulo__fila" tabindex="0" data-href="buscar.html?q=${encodeURIComponent(a.articulo)}" title="Buscar órdenes con este artículo">
          <div>
            <div class="articulo__nombre">${escaparHtml(a.articulo)}</div>
            <div class="articulo__pista"><span class="articulo__barra" style="width:${Math.max(4, Math.round((Number(a.total) / maximo) * 100))}%"></span></div>
          </div>
          <span class="articulo__valor">${Number(a.total).toLocaleString('es-MX')}</span>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin ventas registradas este mes.</p>';
}

function renderizarTareasHoy(lista) {
  document.getElementById('tareas-subtitulo').textContent = `${lista.length} pendiente${lista.length === 1 ? '' : 's'}`;
  const contenedor = document.getElementById('lista-tareas');
  contenedor.innerHTML = lista.length
    ? lista.map((p) => `
        <div class="fila-lista" tabindex="0" data-href="index.html" title="Ir a Tareas">
          <div class="fila-lista__texto">
            <div class="fila-lista__principal">${escaparHtml(p.nombre)}</div>
          </div>
        </div>
      `).join('')
    : '<p class="tarjeta-vacio">Sin tareas para hoy.</p>';
}

function tarjetaKpi(etiqueta, valor, delta, clase) {
  return `
    <article class="kpi">
      <div class="kpi__etiqueta">${escaparHtml(etiqueta)}</div>
      <div class="kpi__valor">${valor}</div>
      ${delta ? `<div class="kpi__delta ${clase || 'es-neutro'}">${delta}</div>` : ''}
    </article>
  `;
}

// Importe por moneda de un grupo de cotizaciones: si no hubo en una moneda no se muestra esa
// linea (evita mostrar "USD 0.00 · MXN 0.00" cuando no paso nada ese dia).
function textoImportePorMoneda(usd, mxn) {
  const partes = [];
  if (usd) partes.push(`USD ${formatoImporte(usd)}`);
  if (mxn) partes.push(`MXN ${formatoImporte(mxn)}`);
  return partes.join(' · ');
}

function renderizarCotizacionesDia(d) {
  document.getElementById('cot-dia-realizadas').textContent = d.cotizacionesRealizadas;
  document.getElementById('cot-dia-realizadas-importe').textContent =
    textoImportePorMoneda(d.cotizacionesRealizadasImporteUsd, d.cotizacionesRealizadasImporteMxn);
  document.getElementById('cot-dia-ganadas').textContent = d.cotizacionesGanadas;
  document.getElementById('cot-dia-ganadas-importe').textContent =
    textoImportePorMoneda(d.cotizacionesGanadasImporteUsd, d.cotizacionesGanadasImporteMxn);
  document.getElementById('cot-dia-perdidas').textContent = d.cotizacionesPerdidas;
}

const filtroFechaPanel = document.getElementById('panel-filtro-fecha');

async function cargarPanel() {
  const parametros = filtroFechaPanel.value ? `?fecha=${encodeURIComponent(filtroFechaPanel.value)}` : '';
  const res = await fetch(`/api/panel/resumen${parametros}`);
  if (!res.ok) return;
  const d = await res.json();

  const kpis = [];
  if (d.negociosActivos !== undefined) {
    kpis.push(tarjetaKpi('Negocios activos', d.negociosActivos, d.negociosCerradosMes ? `${d.negociosCerradosMes} cerrado(s) este mes` : null, 'es-neutro'));
  }
  if (d.cotizacionesVigentes !== undefined) {
    const porVencerPronto = (d.cotizacionesPorVencer || []).filter((c) => diasHasta(c.fecha_vencimiento) <= 3).length;
    kpis.push(tarjetaKpi(
      'Cotizaciones vigentes', d.cotizacionesVigentes,
      porVencerPronto ? `${porVencerPronto} vencen pronto` : 'Ninguna vence pronto',
      porVencerPronto ? 'es-alerta' : 'es-bueno'
    ));
  }
  if (d.ordenesPendientes !== undefined) {
    kpis.push(tarjetaKpi('Órdenes pendientes', d.ordenesPendientes, null));
  }
  if (d.ventasMes !== undefined) {
    kpis.push(tarjetaKpi('Ventas del mes (MXN)', `$${formatoImporte(d.ventasMes)}`, null));
  }
  document.getElementById('panel-kpis').innerHTML = kpis.join('');

  if (d.pipeline) {
    document.getElementById('tarjeta-pipeline').hidden = false;
    document.getElementById('pipeline-subtitulo').textContent = `${d.negociosActivos} negocios activos`;
    renderizarPipeline(d.pipeline);
  }
  if (d.cotizacionesPorVencer) {
    document.getElementById('tarjeta-vencer').hidden = false;
    renderizarCotizacionesPorVencer(d.cotizacionesPorVencer);
  }
  if (d.topArticulos) {
    document.getElementById('tarjeta-articulos').hidden = false;
    renderizarTopArticulos(d.topArticulos);
  }
  if (d.tareasHoy) {
    document.getElementById('tarjeta-tareas').hidden = false;
    renderizarTareasHoy(d.tareasHoy);
  }
  if (d.filtroFecha) {
    document.getElementById('tarjeta-cotizaciones-dia').hidden = false;
    if (!filtroFechaPanel.value) filtroFechaPanel.value = d.filtroFecha;
    renderizarCotizacionesDia(d);
  }
}

filtroFechaPanel.addEventListener('change', cargarPanel);

// Las tarjetas del panel son informativas pero tambien un acceso directo: un clic (o Enter/
// espacio con teclado) en una fila lleva a la pantalla real donde vive ese dato.
function activarNavegacionLista(contenedorId) {
  const contenedor = document.getElementById(contenedorId);
  contenedor.addEventListener('click', (e) => {
    const fila = e.target.closest('[data-href]');
    if (fila) window.location.href = fila.dataset.href;
  });
  contenedor.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const fila = e.target.closest('[data-href]');
    if (!fila) return;
    e.preventDefault();
    window.location.href = fila.dataset.href;
  });
}

['pipeline-lista', 'lista-vencer', 'lista-articulos', 'lista-tareas'].forEach(activarNavegacionLista);

promesaAuth.then((sesion) => {
  if (!sesion) return;
  cargarPanel();

  suscribirTiempoReal(['negocios', 'etapas_negocio'], cargarPanel);
  suscribirTiempoReal(['cotizaciones'], cargarPanel);
  suscribirTiempoReal(['ordenes', 'estatus_catalogo'], cargarPanel);
  suscribirTiempoReal(['detalle_de_compra'], cargarPanel);
  suscribirTiempoReal(['pendientes'], cargarPanel);
});
