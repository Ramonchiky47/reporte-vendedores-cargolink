function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let permisosCatalogos = { ver: true, editar: true, borrar: true };

function poblarSelect(select, lista, valor, texto) {
  const actual = select.value;
  select.innerHTML = '<option value="">-- Selecciona --</option>' + lista.map((item) => `
    <option value="${item[valor]}">${escaparHtml(item[texto])}</option>
  `).join('');
  select.value = actual || '';
}

// Ordenamiento ascendente/descendente por columna, con encabezado fijo (via .tabla-scroll +
// th sticky ya definidos en style.css). Cada tabla tiene su propio estado independiente.
function crearOrdenador(tbody, renderizarFn) {
  const encabezados = tbody.closest('table').querySelectorAll('th[data-campo]');
  const estado = { campo: null, direccion: 'asc' };
  let ultimaLista = [];

  function comparar(va, vb) {
    if (va === null || va === undefined) va = '';
    if (vb === null || vb === undefined) vb = '';
    if (typeof va === 'number' && typeof vb === 'number') return va - vb;
    return String(va).localeCompare(String(vb), 'es', { numeric: true });
  }

  function actualizarIndicadores() {
    encabezados.forEach((th) => {
      if (!th.dataset.etiqueta) th.dataset.etiqueta = th.textContent.trim();
      const base = th.dataset.etiqueta;
      th.textContent = th.dataset.campo === estado.campo
        ? `${base} ${estado.direccion === 'asc' ? '▲' : '▼'}`
        : base;
    });
  }

  function render() {
    let lista = ultimaLista;
    if (estado.campo) {
      lista = [...ultimaLista].sort((a, b) => {
        const cmp = comparar(a[estado.campo], b[estado.campo]);
        return estado.direccion === 'asc' ? cmp : -cmp;
      });
    }
    renderizarFn(lista);
    actualizarIndicadores();
  }

  encabezados.forEach((th) => {
    th.classList.add('th-ordenable');
    th.addEventListener('click', () => {
      if (estado.campo === th.dataset.campo) {
        estado.direccion = estado.direccion === 'asc' ? 'desc' : 'asc';
      } else {
        estado.campo = th.dataset.campo;
        estado.direccion = 'asc';
      }
      render();
    });
  });

  return {
    actualizarDatos(lista) {
      ultimaLista = lista;
      render();
    },
  };
}

// ---------- Tarjetas: Negocios / Cotizaciones ----------

document.querySelectorAll('.tarjeta-subcatalogo').forEach((boton) => {
  boton.addEventListener('click', () => activarSubtab(boton.dataset.subtab));
});

function activarSubtab(nombre) {
  document.querySelectorAll('.tarjeta-subcatalogo').forEach((b) => {
    b.classList.toggle('activo', b.dataset.subtab === nombre);
  });
  document.querySelectorAll('[data-subpanel]').forEach((panel) => {
    panel.hidden = panel.dataset.subpanel !== nombre;
  });
}

// ---------- Negocios ----------

const formNegocio = document.getElementById('form-negocio');
const negocioId = document.getElementById('negocio-id');
const negocioNombre = document.getElementById('negocio-nombre');
const negocioContacto = document.getElementById('negocio-contacto');
const negocioEtapa = document.getElementById('negocio-etapa');
const negocioFechaEstimadaCierre = document.getElementById('negocio-fecha-estimada-cierre');
const negocioMotivoPerdidaWrap = document.getElementById('negocio-motivo-perdida-wrap');
const negocioMotivoPerdida = document.getElementById('negocio-motivo-perdida');
const btnGuardarNegocio = document.getElementById('btn-guardar-negocio');
const btnCancelarNegocio = document.getElementById('btn-cancelar-negocio');
const btnMostrarFormNegocio = document.getElementById('btn-mostrar-form-negocio');
const tablaNegocios = document.getElementById('tabla-negocios');

function abrirFormNegocio() {
  formNegocio.hidden = false;
  btnMostrarFormNegocio.hidden = true;
  btnCancelarNegocio.hidden = false;
}

function cerrarFormNegocio() {
  formNegocio.hidden = true;
  btnMostrarFormNegocio.hidden = false;
}

btnMostrarFormNegocio.addEventListener('click', () => {
  abrirFormNegocio();
  negocioNombre.focus();
});

// El campo Motivo solo se muestra cuando la etapa seleccionada es "Perdida".
function etapaEsPerdida(select) {
  const opcion = select.options[select.selectedIndex];
  return !!opcion && opcion.textContent.trim().toLowerCase().includes('perdid');
}

function actualizarVisibilidadMotivoPerdida() {
  negocioMotivoPerdidaWrap.hidden = !etapaEsPerdida(negocioEtapa);
}

negocioEtapa.addEventListener('change', actualizarVisibilidadMotivoPerdida);

const filtroNegId = document.getElementById('filtro-neg-id');
const filtroNegNombre = document.getElementById('filtro-neg-nombre');
const filtroNegContacto = document.getElementById('filtro-neg-contacto');
const filtroNegEtapaWrap = document.getElementById('filtro-neg-etapa-wrap');
const filtroNegEtapaBtn = document.getElementById('filtro-neg-etapa-btn');
const filtroNegEtapaPanel = document.getElementById('filtro-neg-etapa-panel');
const filtroNegEtapaOpciones = document.getElementById('filtro-neg-etapa-opciones');
const btnAplicarFiltroNegEtapa = document.getElementById('btn-aplicar-filtro-neg-etapa');
const btnCancelarFiltroNegEtapa = document.getElementById('btn-cancelar-filtro-neg-etapa');
const filtroNegFecha = document.getElementById('filtro-neg-fecha');
const btnLimpiarFiltrosNeg = document.getElementById('btn-limpiar-filtros-neg');

function coincideTexto(valor, filtro) {
  return !filtro || String(valor || '').toLowerCase().includes(filtro.toLowerCase());
}

// Filtro de Etapa (Negocios): checkboxes generados a partir del catalogo de etapas_negocio,
// que solo se aplican al presionar "Aplicar" (igual que el filtro de Etapa de Cotizaciones).
// Por defecto se muestran todas las etapas excepto Cierre Ganado y Cierre Perdido; solo se ven
// si el usuario las selecciona explicitamente en el filtro.
let etapasNegSeleccionadas = new Set();
let etapasNegInicializadas = false;
const ETAPAS_NEG_EXCLUIDAS_POR_DEFECTO = ['Cierre Ganado', 'Cierre Perdido'];

function poblarOpcionesFiltroNegEtapa(etapas) {
  filtroNegEtapaOpciones.innerHTML = etapas.map((e) => `
    <label class="multi-select-opcion">
      <input type="checkbox" value="${escaparHtml(e.etapa)}" /><span class="multi-select-texto">${escaparHtml(e.etapa)}</span>
    </label>
  `).join('');
}

function actualizarBotonFiltroNegEtapa() {
  filtroNegEtapaBtn.textContent = etapasNegSeleccionadas.size
    ? `${etapasNegSeleccionadas.size} etapa(s) seleccionada(s)`
    : 'Todas las etapas';
}

function sincronizarChecksFiltroNegEtapa() {
  filtroNegEtapaPanel.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = etapasNegSeleccionadas.has(cb.value);
  });
}

filtroNegEtapaBtn.addEventListener('click', () => {
  sincronizarChecksFiltroNegEtapa();
  filtroNegEtapaPanel.hidden = !filtroNegEtapaPanel.hidden;
});

document.addEventListener('click', (e) => {
  if (!filtroNegEtapaWrap.contains(e.target)) filtroNegEtapaPanel.hidden = true;
});

btnAplicarFiltroNegEtapa.addEventListener('click', () => {
  etapasNegSeleccionadas = new Set(
    [...filtroNegEtapaPanel.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value)
  );
  actualizarBotonFiltroNegEtapa();
  filtroNegEtapaPanel.hidden = true;
  aplicarFiltrosNegocios();
});

btnCancelarFiltroNegEtapa.addEventListener('click', () => {
  sincronizarChecksFiltroNegEtapa();
  filtroNegEtapaPanel.hidden = true;
});

async function poblarSelectsNegocio() {
  const [contactos, etapas] = await Promise.all([
    fetch('/api/contactos').then((r) => r.json()),
    fetch('/api/etapas-negocio').then((r) => r.json()),
  ]);
  poblarSelect(negocioContacto, contactos, 'id_contacto', 'nombre_completo_correo');
  poblarSelect(negocioEtapa, etapas, 'id_etapa', 'etapa');
  poblarOpcionesFiltroNegEtapa(etapas);

  if (!etapasNegInicializadas) {
    etapasNegInicializadas = true;
    etapasNegSeleccionadas = new Set(
      etapas.map((e) => e.etapa).filter((nombre) => !ETAPAS_NEG_EXCLUIDAS_POR_DEFECTO.includes(nombre))
    );
    actualizarBotonFiltroNegEtapa();
    sincronizarChecksFiltroNegEtapa();
    aplicarFiltrosNegocios();
  }

  // Un negocio nuevo nace en la etapa "Negociacion" por default.
  if (!negocioId.value) seleccionarEtapaPorNombre(negocioEtapa, 'negociacion');
}

function celdaEstatus(estatus) {
  const clase = estatus === 'Vencido' ? 'estatus-vencido' : 'estatus-vigente';
  return `<span class="${clase}">${escaparHtml(estatus)}</span>`;
}

function fechaDe(creadoEn) {
  return (creadoEn || '').split(' ')[0];
}

// Coincide con el patron de etapaEsPerdida: cualquier etapa cuyo nombre contenga "ganado"
// (ej. "Cierre Ganado") se considera una etapa ganada, sin importar mayusculas/acentos.
function etapaNegocioEsGanada(etapaNombre) {
  return String(etapaNombre || '').toLowerCase().includes('ganado');
}

// Seleccion de negocios (checkboxes) para enviarlos a Tareas en lote. Se mantiene por
// id_negocio (no por fila), asi que sobrevive a los filtros/orden de la tabla.
const negociosSeleccionados = new Set();
const checkTodosNegocios = document.getElementById('check-todos-negocios');
const btnEnviarTareasNegocios = document.getElementById('btn-enviar-tareas-negocios');

function actualizarBotonEnviarTareasNegocios() {
  btnEnviarTareasNegocios.textContent = `Enviar a tareas (${negociosSeleccionados.size})`;
  btnEnviarTareasNegocios.disabled = negociosSeleccionados.size === 0;
}

function claseFilaNegocio(n) {
  const clases = [];
  if (etapaNegocioEsGanada(n.etapa_nombre)) clases.push('fila-ganada');
  if (n.tiene_tarea_activa) clases.push('fila-en-tareas');
  return clases.length ? ` class="${clases.join(' ')}"` : '';
}

function renderizarNegocios(negocios) {
  tablaNegocios.innerHTML = negocios.map((n) => `
    <tr${claseFilaNegocio(n)}>
      <td><input type="checkbox" class="check-negocio" value="${escaparHtml(n.id_negocio)}" ${negociosSeleccionados.has(n.id_negocio) ? 'checked' : ''} /></td>
      <td>${escaparHtml(n.id_negocio)}</td>
      <td>${escaparHtml(fechaDe(n.creado_en))}</td>
      <td>${escaparHtml(n.negocio)}</td>
      <td>${escaparHtml(n.contacto_nombre || '')}</td>
      <td>${escaparHtml(n.etapa_nombre || '')}</td>
      <td>${celdaEstatus(n.estatus)}</td>
      <td>${escaparHtml(fechaDe(n.fecha_estimada_cierre))}</td>
      <td>${formatoImporte(n.importe_usd)}</td>
      <td>${formatoImporte(n.importe_mxn)}</td>
      <td><button type="button" class="btn-ver-cotizaciones" data-id="${escaparHtml(n.id_negocio)}" data-nombre="${escaparHtml(n.negocio)}">Ver cotizaciones</button></td>
      <td><button type="button" class="btn-notas-negocio" data-id="${escaparHtml(n.id_negocio)}" data-nombre="${escaparHtml(n.negocio)}">Notas</button></td>
      <td>${permisosCatalogos.editar ? `<button type="button" class="btn-mini btn-nueva-cotizacion-negocio" data-id="${escaparHtml(n.id_negocio)}" data-nombre="${escaparHtml(n.negocio)}" title="Nueva cotización para este negocio">+</button>` : ''}</td>
      <td class="acciones">
        ${permisosCatalogos.editar ? `<button class="btn-editar" data-id="${escaparHtml(n.id_negocio)}">Editar</button>` : ''}
        ${permisosCatalogos.borrar ? `<button class="btn-borrar" data-id="${escaparHtml(n.id_negocio)}">Borrar</button>` : ''}
      </td>
    </tr>
  `).join('');
  checkTodosNegocios.checked = negocios.length > 0 && negocios.every((n) => negociosSeleccionados.has(n.id_negocio));
}

const ordenadorNegocios = crearOrdenador(tablaNegocios, renderizarNegocios);

tablaNegocios.addEventListener('change', (e) => {
  if (!e.target.classList.contains('check-negocio')) return;
  if (e.target.checked) negociosSeleccionados.add(e.target.value);
  else negociosSeleccionados.delete(e.target.value);
  checkTodosNegocios.checked = [...tablaNegocios.querySelectorAll('.check-negocio')].every((cb) => cb.checked);
  actualizarBotonEnviarTareasNegocios();
});

checkTodosNegocios.addEventListener('change', () => {
  tablaNegocios.querySelectorAll('.check-negocio').forEach((cb) => {
    cb.checked = checkTodosNegocios.checked;
    if (checkTodosNegocios.checked) negociosSeleccionados.add(cb.value);
    else negociosSeleccionados.delete(cb.value);
  });
  actualizarBotonEnviarTareasNegocios();
});

// Envia a Tareas (como pendientes de Seguimiento) todos los negocios marcados con checkbox.
btnEnviarTareasNegocios.addEventListener('click', async () => {
  if (!negociosSeleccionados.size) return;

  const actividades = await fetch('/api/actividades').then((r) => r.json());
  const seguimiento = actividades.find((a) => a.actividad.trim().toLowerCase() === 'seguimiento');
  if (!seguimiento) {
    alert('No existe la actividad "Seguimiento" en Catálogos → Actividades. Créala primero.');
    return;
  }

  const idsSeleccionados = [...negociosSeleccionados];
  let enviados = 0;
  const errores = [];

  for (const id of idsSeleccionados) {
    const negocio = negociosCache.find((n) => n.id_negocio === id);
    if (!negocio) continue;
    const res = await fetch('/api/pendientes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nombre: `Seguimiento: ${negocio.negocio}`,
        actividades: [seguimiento.id_actividad],
        negocio_id: id,
      }),
    });
    if (res.ok) {
      enviados++;
    } else {
      const error = await res.json().catch(() => ({}));
      errores.push(`${negocio.negocio}: ${error.errores ? error.errores.join(', ') : res.statusText}`);
    }
  }

  negociosSeleccionados.clear();
  actualizarBotonEnviarTareasNegocios();
  await cargarNegocios();

  if (errores.length) {
    alert(`Se enviaron ${enviados} de ${idsSeleccionados.length} negocio(s) a Tareas.\n\nErrores:\n${errores.join('\n')}`);
  } else {
    alert(`Se enviaron ${enviados} negocio(s) a Tareas de seguimiento.`);
  }
});

async function cargarNegocios() {
  const res = await fetch('/api/negocios');
  const negocios = await res.json();
  negociosCache = negocios;
  aplicarFiltrosNegocios();
  // Mantiene sincronizado el desplegable "Negocio" del formulario de Cotizacion: si se crea o
  // edita un negocio desde esta tarjeta, debe poder seleccionarse de inmediato en Captura.
  poblarSelect(cotizacionNegocio, negocios, 'id_negocio', 'negocio');
  return negocios;
}

function aplicarFiltrosNegocios() {
  const filtrados = negociosCache.filter((n) =>
    coincideTexto(n.id_negocio, filtroNegId.value.trim())
    && coincideTexto(n.negocio, filtroNegNombre.value.trim())
    && coincideTexto(n.contacto_nombre, filtroNegContacto.value.trim())
    && (etapasNegSeleccionadas.size === 0 || etapasNegSeleccionadas.has(n.etapa_nombre))
    && (!filtroNegFecha.value || fechaDe(n.creado_en) === filtroNegFecha.value)
  );
  ordenadorNegocios.actualizarDatos(filtrados);
}

[filtroNegId, filtroNegNombre, filtroNegContacto].forEach((input) => {
  input.addEventListener('input', aplicarFiltrosNegocios);
});
filtroNegFecha.addEventListener('change', aplicarFiltrosNegocios);
btnLimpiarFiltrosNeg.addEventListener('click', () => {
  [filtroNegId, filtroNegNombre, filtroNegContacto, filtroNegFecha].forEach((input) => { input.value = ''; });
  etapasNegSeleccionadas = new Set();
  sincronizarChecksFiltroNegEtapa();
  actualizarBotonFiltroNegEtapa();
  aplicarFiltrosNegocios();
});

function seleccionarEtapaPorNombre(select, nombre) {
  const opcion = [...select.options].find((o) => o.textContent.trim().toLowerCase() === nombre.toLowerCase());
  select.value = opcion ? opcion.value : '';
}

function limpiarFormNegocio() {
  negocioId.value = '';
  formNegocio.reset();
  // Todo negocio nuevo nace en la etapa "Negociacion" por default.
  seleccionarEtapaPorNombre(negocioEtapa, 'negociacion');
  negocioMotivoPerdida.value = '';
  actualizarVisibilidadMotivoPerdida();
  btnGuardarNegocio.textContent = 'Agregar';
  btnCancelarNegocio.hidden = true;
  cerrarFormNegocio();
}

formNegocio.addEventListener('submit', async (e) => {
  e.preventDefault();
  const payload = {
    negocio: negocioNombre.value.trim(),
    contacto_id: negocioContacto.value || null,
    etapa_id: negocioEtapa.value || null,
    motivo_perdida: negocioMotivoPerdida.value.trim(),
    fecha_estimada_cierre: negocioFechaEstimadaCierre.value || null,
  };
  const id = negocioId.value;
  const res = await fetch(id ? `/api/negocios/${id}` : '/api/negocios', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  limpiarFormNegocio();
  cargarNegocios();
});

btnCancelarNegocio.addEventListener('click', limpiarFormNegocio);

tablaNegocios.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;

  if (e.target.classList.contains('btn-ver-cotizaciones')) {
    activarSubtab('visualizacion');
    activarFiltroNegocio(id, e.target.dataset.nombre);
    return;
  }

  if (e.target.classList.contains('btn-notas-negocio')) {
    abrirNotasNegocio(id, e.target.dataset.nombre);
    return;
  }

  if (e.target.classList.contains('btn-nueva-cotizacion-negocio')) {
    activarSubtab('captura');
    limpiarFormCotizacion();
    cotizacionNegocio.value = id;
    replicarContactoYDestinoDeNegocio(id);
    abrirFormCotizacion();
    return;
  }

  if (e.target.classList.contains('btn-borrar')) {
    if (!confirm('¿Borrar este negocio? Esto también eliminará todas sus cotizaciones asociadas.')) return;
    if (!confirm('Esta acción no se puede deshacer. ¿Confirmas que quieres borrar el negocio y todas sus cotizaciones?')) return;
    const res = await fetch(`/api/negocios/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      alert('Error: ' + (error.errores ? error.errores.join(', ') : error.error || res.statusText));
      return;
    }
    cargarNegocios();
  }

  if (e.target.classList.contains('btn-editar')) {
    const negocios = await cargarNegocios();
    const n = negocios.find((x) => x.id_negocio === id);
    if (!n) return;

    negocioId.value = n.id_negocio;
    negocioNombre.value = n.negocio;
    negocioContacto.value = n.contacto_id || '';
    negocioEtapa.value = n.etapa_id || '';
    negocioFechaEstimadaCierre.value = n.fecha_estimada_cierre || '';
    negocioMotivoPerdida.value = n.motivo_perdida || '';
    actualizarVisibilidadMotivoPerdida();

    btnGuardarNegocio.textContent = 'Guardar cambios';
    btnCancelarNegocio.hidden = false;
    abrirFormNegocio();
    negocioNombre.focus();
  }
});

// ---------- Cotizaciones ----------

const filtroPista = document.getElementById('cotizaciones-filtro-pista');
const btnMostrarFormCotizacion = document.getElementById('btn-mostrar-form-cotizacion');
const formCotizacion = document.getElementById('form-cotizacion');
const cotizacionId = document.getElementById('cotizacion-id');
const cotizacionNombre = document.getElementById('cotizacion-nombre');
const cotizacionNegocio = document.getElementById('cotizacion-negocio');
const cotizacionMoneda = document.getElementById('cotizacion-moneda');
const cotizacionEtapa = document.getElementById('cotizacion-etapa');
const cotizacionContacto = document.getElementById('cotizacion-contacto');
const cotizacionDestino = document.getElementById('cotizacion-destino');
const cotizacionRepresentante = document.getElementById('cotizacion-representante');
const cotizacionDescuento = document.getElementById('cotizacion-descuento');
const cotizacionFechaCreacion = document.getElementById('cotizacion-fecha-creacion');
const cotizacionVencimientoOpcion = document.getElementById('cotizacion-vencimiento-opcion');
const cotizacionVencimientoFecha = document.getElementById('cotizacion-vencimiento-fecha');
const cotizacionMetodoPago = document.getElementById('cotizacion-metodo-pago');
const cotizacionLugarEntrega = document.getElementById('cotizacion-lugar-entrega');
const cotizacionTiempoEntrega = document.getElementById('cotizacion-tiempo-entrega');
const cotizacionFechaSeguimiento = document.getElementById('cotizacion-fecha-seguimiento');
const cotizacionObservaciones = document.getElementById('cotizacion-observaciones');
const cotizacionDetallesGenerales = document.getElementById('cotizacion-detalles-generales');
const btnToggleDetallesCotizacion = document.getElementById('btn-toggle-detalles-cotizacion');
const tablaPartidas = document.getElementById('tabla-partidas');
const datalistProductos = document.getElementById('lista-productos');

// Marca en rojo el contorno de cualquier campo de la Captura de cotizaciones que no tenga
// captura todavia; en cuanto se llena vuelve al color normal. Observaciones queda fuera de
// esta regla (es el unico campo que se mantiene igual, sin importar si esta vacio).
const camposObligatoriosCotizacion = [
  cotizacionNombre, cotizacionNegocio, cotizacionMoneda, cotizacionContacto, cotizacionDestino, cotizacionRepresentante,
  cotizacionDescuento, cotizacionFechaCreacion, cotizacionVencimientoOpcion, cotizacionVencimientoFecha,
  cotizacionMetodoPago, cotizacionLugarEntrega, cotizacionTiempoEntrega, cotizacionFechaSeguimiento,
];

function actualizarCampoVacio(campo) {
  campo.classList.toggle('campo-vacio', campo.value.trim() === '');
}

function actualizarCamposVaciosCotizacion() {
  camposObligatoriosCotizacion.forEach(actualizarCampoVacio);
}

camposObligatoriosCotizacion.forEach((campo) => {
  campo.addEventListener('input', () => actualizarCampoVacio(campo));
  campo.addEventListener('change', () => actualizarCampoVacio(campo));
});

// Seccion colapsable de datos generales: se expande al capturar una cotizacion nueva (para
// llenarlos) y se colapsa al editar una ya existente (para dejar mas espacio a los productos).
// El boton siempre permite alternar manualmente.
function mostrarDetallesGeneralesCotizacion(mostrar) {
  cotizacionDetallesGenerales.hidden = !mostrar;
  btnToggleDetallesCotizacion.textContent = mostrar ? '▲ Ver menos campos' : '▼ Ver más campos';
}

btnToggleDetallesCotizacion.addEventListener('click', () => {
  mostrarDetallesGeneralesCotizacion(cotizacionDetallesGenerales.hidden);
});
const btnAgregarPartida = document.getElementById('btn-agregar-partida');
const btnGuardarCotizacion = document.getElementById('btn-guardar-cotizacion');
const btnCancelarCotizacion = document.getElementById('btn-cancelar-cotizacion');
const btnEnviarTareasSeguimiento = document.getElementById('btn-enviar-tareas-seguimiento');
const tablaCotizaciones = document.getElementById('tabla-cotizaciones');

const resumenSubtotal = document.getElementById('resumen-subtotal');
const resumenDescuento = document.getElementById('resumen-descuento');
const resumenIva = document.getElementById('resumen-iva');
const resumenGranTotal = document.getElementById('resumen-gran-total');

const filtroCotId = document.getElementById('filtro-cot-id');
const filtroCotNombre = document.getElementById('filtro-cot-nombre');
const filtroCotNegocio = document.getElementById('filtro-cot-negocio');
const filtroCotContacto = document.getElementById('filtro-cot-contacto');
const filtroCotFecha = document.getElementById('filtro-cot-fecha');
const filtroCotEtapaWrap = document.getElementById('filtro-cot-etapa-wrap');
const filtroCotEtapaBtn = document.getElementById('filtro-cot-etapa-btn');
const filtroCotEtapaPanel = document.getElementById('filtro-cot-etapa-panel');
const btnAplicarFiltroCotEtapa = document.getElementById('btn-aplicar-filtro-cot-etapa');
const btnCancelarFiltroCotEtapa = document.getElementById('btn-cancelar-filtro-cot-etapa');
const btnLimpiarFiltrosCot = document.getElementById('btn-limpiar-filtros-cot');

let productosCache = [];
let negociosCache = [];
let contactosCache = [];
let cotizacionesCache = [];
let partidas = [];
let filtroNegocioId = null;

// Si se llega desde una Tarea con la actividad "Cotizacion" (Tareas -> clic en la fila), se
// guarda aqui su ID: al guardar la cotizacion nueva, esa tarea se borra automaticamente.
let pendienteOrigenId = null;

async function poblarSelectsCotizacion() {
  const [negocios, contactos, destinos, productos, representantes] = await Promise.all([
    fetch('/api/negocios').then((r) => r.json()),
    fetch('/api/contactos').then((r) => r.json()),
    fetch('/api/destinos').then((r) => r.json()),
    fetch('/api/productos').then((r) => r.json()),
    fetch('/api/representantes').then((r) => r.json()),
  ]);
  poblarSelect(cotizacionNegocio, negocios, 'id_negocio', 'negocio');
  poblarSelect(cotizacionContacto, contactos, 'id_contacto', 'nombre_completo_correo');
  poblarSelect(cotizacionDestino, destinos, 'id_destino', 'destino');
  poblarSelect(cotizacionRepresentante, representantes, 'id_representante', 'representante');
  negociosCache = negocios;
  contactosCache = contactos;
  productosCache = productos;
  poblarDatalistProductos();
}

// Al capturar una cotizacion a partir de un negocio, se replican el Contacto del negocio y,
// si ese contacto tiene destinos asociados en su catalogo, el primero de ellos como Destino.
function replicarContactoYDestinoDeNegocio(negocioId) {
  const negocio = negociosCache.find((n) => n.id_negocio === negocioId);
  if (!negocio) return;

  cotizacionContacto.value = negocio.contacto_id || '';

  const contacto = contactosCache.find((c) => String(c.id_contacto) === String(negocio.contacto_id));
  const destinos = (contacto && contacto.destinos) || [];
  cotizacionDestino.value = destinos.length ? destinos[0].id_destino : '';
}

function activarFiltroNegocio(id, nombre) {
  filtroNegocioId = id;
  filtroPista.hidden = false;
  filtroPista.innerHTML = `
    <a href="#" id="volver-a-negocios">← Regresar a Negocios</a>
    · Mostrando cotizaciones de: <strong>${escaparHtml(nombre)}</strong> · <a href="#" id="quitar-filtro-negocio">Quitar filtro</a>
  `;
  document.getElementById('volver-a-negocios').addEventListener('click', (e) => {
    e.preventDefault();
    filtroNegocioId = null;
    filtroPista.hidden = true;
    activarSubtab('negocios');
  });
  document.getElementById('quitar-filtro-negocio').addEventListener('click', (e) => {
    e.preventDefault();
    filtroNegocioId = null;
    filtroPista.hidden = true;
    cargarCotizaciones();
  });

  // Al venir de "Ver cotizaciones" de un negocio especifico, se limpian los demas filtros
  // (incluida la etapa, que por default solo muestra "Negociacion") para no ocultar por
  // accidente las cotizaciones de ese negocio si estan en otra etapa o quedo texto de un
  // filtro anterior.
  [filtroCotId, filtroCotNombre, filtroCotNegocio, filtroCotContacto, filtroCotFecha].forEach((input) => { input.value = ''; });
  etapasCotSeleccionadas = new Set();
  sincronizarChecksFiltroCotEtapa();
  actualizarBotonFiltroCotEtapa();

  cargarCotizaciones();
}

function celdaEtapaCotizacion(etapa) {
  const etiquetas = { Negociacion: 'Negociación', Ganada: 'Ganada', Perdida: 'Perdida' };
  if (etapa === 'Ganada') return `<span class="estatus-vigente">${etiquetas[etapa]}</span>`;
  if (etapa === 'Perdida') return `<span class="estatus-vencido">${etiquetas[etapa]}</span>`;
  return etiquetas[etapa] || escaparHtml(etapa || '');
}

function renderizarCotizaciones(cotizaciones) {
  tablaCotizaciones.innerHTML = cotizaciones.map((c) => `
    <tr class="fila-clicable${c.etapa === 'Ganada' ? ' fila-ganada' : ''}" data-id="${escaparHtml(c.id_cotizacion)}">
      <td>${escaparHtml(c.id_cotizacion)}</td>
      <td>${escaparHtml(c.fecha_creacion || '')}</td>
      <td>${escaparHtml(c.nombre)}</td>
      <td>${escaparHtml(c.negocio_nombre || '')}</td>
      <td>${escaparHtml(c.contacto_nombre || '')}</td>
      <td>${escaparHtml(c.destino_nombre || '')}</td>
      <td>${escaparHtml(c.moneda)}</td>
      <td>${celdaEtapaCotizacion(c.etapa)}</td>
      <td>${formatoImporte(c.subtotal)}</td>
      <td>${c.descuento_porcentaje ? c.descuento_porcentaje + '%' : '-'}</td>
      <td>${formatoImporte(c.iva)}</td>
      <td>${formatoImporte(c.gran_total)}</td>
      <td>${celdaEstatus(c.estatus)}</td>
      <td class="acciones">
        <button type="button" class="btn-mini btn-ver-pdf-cotizacion" data-id="${escaparHtml(c.id_cotizacion)}" title="Ver cotización">Ver</button>
        <button type="button" class="btn-mini btn-descargar-pdf-cotizacion" data-id="${escaparHtml(c.id_cotizacion)}" title="Descargar PDF">Descargar PDF</button>
        ${permisosCatalogos.editar ? `<button type="button" class="btn-mini btn-clonar-cotizacion" data-id="${escaparHtml(c.id_cotizacion)}" title="Crear una copia editable de esta cotización">Clonar</button>` : ''}
        ${permisosCatalogos.editar ? `<button class="btn-editar" data-id="${escaparHtml(c.id_cotizacion)}">Editar</button>` : ''}
        ${permisosCatalogos.borrar ? `<button class="btn-borrar" data-id="${escaparHtml(c.id_cotizacion)}">Borrar</button>` : ''}
      </td>
    </tr>
  `).join('');
}

const ordenadorCotizaciones = crearOrdenador(tablaCotizaciones, renderizarCotizaciones);

async function cargarCotizaciones() {
  const parametros = filtroNegocioId ? `?negocio=${encodeURIComponent(filtroNegocioId)}` : '';
  const res = await fetch(`/api/cotizaciones${parametros}`);
  const cotizaciones = await res.json();
  cotizacionesCache = cotizaciones;
  aplicarFiltrosCotizaciones();
  return cotizaciones;
}

// Filtro por Etapa: checkboxes dentro de un panel desplegable que solo se aplican al
// presionar "Aplicar" (o se descartan con "Cancelar"), no en vivo como los demas filtros.
// Por defecto solo se muestra Negociacion; Ganada y Perdida quedan ocultas hasta que el usuario
// las seleccione explicitamente.
let etapasCotSeleccionadas = new Set(['Negociacion']);

function actualizarBotonFiltroCotEtapa() {
  filtroCotEtapaBtn.textContent = etapasCotSeleccionadas.size
    ? `${etapasCotSeleccionadas.size} etapa(s) seleccionada(s)`
    : 'Todas las etapas';
}

function sincronizarChecksFiltroCotEtapa() {
  filtroCotEtapaPanel.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = etapasCotSeleccionadas.has(cb.value);
  });
}

filtroCotEtapaBtn.addEventListener('click', () => {
  sincronizarChecksFiltroCotEtapa();
  filtroCotEtapaPanel.hidden = !filtroCotEtapaPanel.hidden;
});

document.addEventListener('click', (e) => {
  if (!filtroCotEtapaWrap.contains(e.target)) filtroCotEtapaPanel.hidden = true;
});

btnAplicarFiltroCotEtapa.addEventListener('click', () => {
  etapasCotSeleccionadas = new Set(
    [...filtroCotEtapaPanel.querySelectorAll('input[type="checkbox"]:checked')].map((cb) => cb.value)
  );
  actualizarBotonFiltroCotEtapa();
  filtroCotEtapaPanel.hidden = true;
  aplicarFiltrosCotizaciones();
});

btnCancelarFiltroCotEtapa.addEventListener('click', () => {
  sincronizarChecksFiltroCotEtapa();
  filtroCotEtapaPanel.hidden = true;
});

function aplicarFiltrosCotizaciones() {
  const filtradas = cotizacionesCache.filter((c) =>
    coincideTexto(c.id_cotizacion, filtroCotId.value.trim())
    && coincideTexto(c.nombre, filtroCotNombre.value.trim())
    && coincideTexto(c.negocio_nombre, filtroCotNegocio.value.trim())
    && coincideTexto(c.contacto_nombre, filtroCotContacto.value.trim())
    && (!filtroCotFecha.value || c.fecha_creacion === filtroCotFecha.value)
    && (etapasCotSeleccionadas.size === 0 || etapasCotSeleccionadas.has(c.etapa))
  );
  ordenadorCotizaciones.actualizarDatos(filtradas);
}

[filtroCotId, filtroCotNombre, filtroCotNegocio, filtroCotContacto].forEach((input) => {
  input.addEventListener('input', aplicarFiltrosCotizaciones);
});
filtroCotFecha.addEventListener('change', aplicarFiltrosCotizaciones);
btnLimpiarFiltrosCot.addEventListener('click', () => {
  [filtroCotId, filtroCotNombre, filtroCotNegocio, filtroCotContacto, filtroCotFecha].forEach((input) => { input.value = ''; });
  etapasCotSeleccionadas = new Set();
  sincronizarChecksFiltroCotEtapa();
  actualizarBotonFiltroCotEtapa();
  aplicarFiltrosCotizaciones();
});

// ---- Partidas (productos de la cotizacion) ----

// El campo de producto es un input con datalist (no un <select>): solo muestra el codigo del
// Item (sin descripcion) y filtra en vivo segun lo que se va escribiendo.
function poblarDatalistProductos() {
  datalistProductos.innerHTML = productosCache.map((p) => `<option value="${escaparHtml(p.item)}"></option>`).join('');
}

function renderizarPartidas() {
  const sinMoneda = !cotizacionMoneda.value;
  tablaPartidas.innerHTML = partidas.map((it, i) => `
    <tr data-index="${i}">
      <td><input type="text" class="partida-producto" list="lista-productos" placeholder="Código" value="${escaparHtml(it.producto_item || '')}" ${sinMoneda ? 'disabled title="Selecciona primero la Moneda"' : ''} /></td>
      <td><input type="number" class="partida-cantidad" step="1" min="0" value="${it.cantidad || ''}" /></td>
      <td><input type="number" class="partida-precio" step="0.01" min="0" value="${it.precio_unitario || ''}" /></td>
      <td class="partida-total">${formatoImporte((it.cantidad || 0) * (it.precio_unitario || 0))}</td>
      <td><button type="button" class="btn-quitar-partida" title="Quitar">✕</button></td>
    </tr>
  `).join('');
}

function calcularResumen() {
  const subtotal = partidas.reduce((acc, it) => acc + (Number(it.cantidad) || 0) * (Number(it.precio_unitario) || 0), 0);
  const porcentaje = Number(cotizacionDescuento.value) || 0;
  const descuentoMonto = subtotal * (porcentaje / 100);
  const base = subtotal - descuentoMonto;
  const iva = base * 0.16;
  const granTotal = base + iva;
  return { subtotal, descuentoMonto, iva, granTotal };
}

function actualizarResumen() {
  const { subtotal, descuentoMonto, iva, granTotal } = calcularResumen();
  resumenSubtotal.textContent = formatoImporte(subtotal);
  resumenDescuento.textContent = formatoImporte(descuentoMonto);
  resumenIva.textContent = formatoImporte(iva);
  resumenGranTotal.textContent = formatoImporte(granTotal);
}

cotizacionMoneda.addEventListener('change', renderizarPartidas);

btnAgregarPartida.addEventListener('click', () => {
  if (!cotizacionMoneda.value) {
    alert('Selecciona la Moneda antes de agregar productos.');
    cotizacionMoneda.focus();
    return;
  }
  partidas.push({ producto_item: '', cantidad: 1, precio_unitario: 0 });
  renderizarPartidas();
  actualizarResumen();
  mostrarDetallesGeneralesCotizacion(false);
});

tablaPartidas.addEventListener('input', (e) => {
  const tr = e.target.closest('tr');
  if (!tr) return;
  const i = Number(tr.dataset.index);

  if (e.target.classList.contains('partida-cantidad')) {
    partidas[i].cantidad = Number(e.target.value) || 0;
  } else if (e.target.classList.contains('partida-precio')) {
    partidas[i].precio_unitario = Number(e.target.value) || 0;
  } else if (e.target.classList.contains('partida-producto')) {
    partidas[i].producto_item = e.target.value.trim();
    const producto = productosCache.find((p) => p.item === partidas[i].producto_item);
    const moneda = cotizacionMoneda.value;
    if (producto && moneda) {
      const sugerido = moneda === 'USD' ? producto.precio_usd : producto.precio_mxn;
      if (sugerido !== null && sugerido !== undefined) {
        partidas[i].precio_unitario = sugerido;
        tr.querySelector('.partida-precio').value = sugerido;
      }
    }
  } else {
    return;
  }
  tr.querySelector('.partida-total').textContent = formatoImporte(partidas[i].cantidad * partidas[i].precio_unitario);
  actualizarResumen();
});

tablaPartidas.addEventListener('click', (e) => {
  if (!e.target.classList.contains('btn-quitar-partida')) return;
  const i = Number(e.target.closest('tr').dataset.index);
  partidas.splice(i, 1);
  renderizarPartidas();
  actualizarResumen();
});

cotizacionDescuento.addEventListener('input', actualizarResumen);

// ---- Alta / edicion de la cotizacion ----

// ---- Fecha de creacion / Fecha de vencimiento ----

function hoyISO() {
  const hoy = new Date();
  return `${hoy.getFullYear()}-${String(hoy.getMonth() + 1).padStart(2, '0')}-${String(hoy.getDate()).padStart(2, '0')}`;
}

function sumarDias(fechaISO, dias) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d));
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

// Si la fecha de vencimiento guardada coincide con creacion+30/60/90, se preselecciona esa
// opcion; si no coincide con ninguna, se asume "Personalizada".
function detectarOpcionVencimiento(fechaCreacion, fechaVencimiento) {
  if (!fechaVencimiento) return '30';
  for (const dias of [30, 60, 90]) {
    if (sumarDias(fechaCreacion, dias) === fechaVencimiento) return String(dias);
  }
  return 'personalizada';
}

function actualizarVencimientoPorOpcion() {
  const opcion = cotizacionVencimientoOpcion.value;
  if (opcion === 'personalizada') {
    cotizacionVencimientoFecha.disabled = false;
  } else {
    const base = cotizacionFechaCreacion.value || hoyISO();
    cotizacionVencimientoFecha.value = sumarDias(base, Number(opcion));
    cotizacionVencimientoFecha.disabled = true;
  }
}

cotizacionVencimientoOpcion.addEventListener('change', actualizarVencimientoPorOpcion);

function limpiarFormCotizacion() {
  cotizacionId.value = '';
  formCotizacion.reset();
  partidas = [];
  renderizarPartidas();
  actualizarResumen();
  btnGuardarCotizacion.textContent = 'Guardar cotización';
  btnEnviarTareasSeguimiento.hidden = true;
  if (filtroNegocioId) {
    cotizacionNegocio.value = filtroNegocioId;
    replicarContactoYDestinoDeNegocio(filtroNegocioId);
  }

  cotizacionFechaCreacion.value = hoyISO();
  cotizacionVencimientoOpcion.value = '30';
  actualizarVencimientoPorOpcion();
  cotizacionFechaSeguimiento.value = sumarDias(hoyISO(), 15);

  mostrarDetallesGeneralesCotizacion(true);
  actualizarCamposVaciosCotizacion();
}

function abrirFormCotizacion() {
  formCotizacion.hidden = false;
  btnMostrarFormCotizacion.hidden = true;
}

function cerrarFormCotizacion() {
  formCotizacion.hidden = true;
  btnMostrarFormCotizacion.hidden = false;
  limpiarFormCotizacion();
}

btnMostrarFormCotizacion.addEventListener('click', () => {
  limpiarFormCotizacion();
  abrirFormCotizacion();
});

// Atajo desde Visualizacion de cotizaciones: manda a Captura y abre el formulario directo,
// ya que "Captura de cotizaciones" se quito de la barra lateral (este boton la reemplaza).
const btnNuevaCotizacionVisualizacion = document.getElementById('btn-nueva-cotizacion-visualizacion');
btnNuevaCotizacionVisualizacion.addEventListener('click', () => {
  activarSubtab('captura');
  limpiarFormCotizacion();
  abrirFormCotizacion();
});

btnCancelarCotizacion.addEventListener('click', () => {
  cerrarFormCotizacion();
  activarSubtab('visualizacion');
});

// Envia esta cotizacion (ya guardada) a Tareas como un pendiente de Seguimiento: nace con la
// actividad "Seguimiento" y, si la cotizacion tiene Fecha de seguimiento, se usa como Fecha de
// compromiso de la tarea.
btnEnviarTareasSeguimiento.addEventListener('click', async () => {
  const actividades = await fetch('/api/actividades').then((r) => r.json());
  const seguimiento = actividades.find((a) => a.actividad.trim().toLowerCase() === 'seguimiento');
  if (!seguimiento) {
    alert('No existe la actividad "Seguimiento" en Catálogos → Actividades. Créala primero.');
    return;
  }

  const nombreNegocio = cotizacionNegocio.options[cotizacionNegocio.selectedIndex]?.textContent || '';
  const res = await fetch('/api/pendientes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre: `Seguimiento: ${cotizacionNombre.value.trim()}${nombreNegocio ? ' - ' + nombreNegocio : ''}`,
      fecha_compromiso: cotizacionFechaSeguimiento.value || null,
      actividades: [seguimiento.id_actividad],
      negocio_id: cotizacionNegocio.value || null,
    }),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  cargarNegocios();
  alert('Se envió a Tareas de seguimiento.');
});

formCotizacion.addEventListener('submit', async (e) => {
  e.preventDefault();

  const payload = {
    nombre: cotizacionNombre.value.trim(),
    negocio_id: cotizacionNegocio.value || null,
    contacto_id: cotizacionContacto.value || null,
    destino_id: cotizacionDestino.value || null,
    representante_id: cotizacionRepresentante.value || null,
    moneda: cotizacionMoneda.value,
    etapa: cotizacionEtapa.value,
    descuento_porcentaje: Number(cotizacionDescuento.value) || 0,
    fecha_vencimiento: cotizacionVencimientoFecha.value || null,
    fecha_seguimiento: cotizacionFechaSeguimiento.value || null,
    metodo_pago: cotizacionMetodoPago.value.trim(),
    lugar_entrega: cotizacionLugarEntrega.value.trim(),
    tiempo_entrega: cotizacionTiempoEntrega.value.trim(),
    observaciones: cotizacionObservaciones.value.trim(),
    items: partidas.filter((it) => it.producto_item),
  };

  const id = cotizacionId.value;
  const res = await fetch(id ? `/api/cotizaciones/${id}` : '/api/cotizaciones', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }

  if (!id && pendienteOrigenId) {
    await fetch(`/api/pendientes/${pendienteOrigenId}`, { method: 'DELETE' });
    pendienteOrigenId = null;
  }

  cerrarFormCotizacion();
  activarSubtab('visualizacion');
  cargarCotizaciones();
  cargarNegocios();
});

tablaCotizaciones.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;
  if (!id) return;

  if (e.target.classList.contains('btn-ver-pdf-cotizacion')) {
    generarPDFCotizacion(id);
    return;
  }

  if (e.target.classList.contains('btn-descargar-pdf-cotizacion')) {
    descargarPDFCotizacion(id);
    return;
  }

  if (e.target.classList.contains('btn-clonar-cotizacion')) {
    clonarCotizacion(id);
    return;
  }

  if (e.target.classList.contains('btn-borrar')) {
    if (!confirmarDoble('¿Borrar esta cotización?')) return;
    const res = await fetch(`/api/cotizaciones/${id}`, { method: 'DELETE' });
    if (!res.ok) {
      const error = await res.json().catch(() => ({}));
      alert('Error: ' + (error.errores ? error.errores.join(', ') : error.error || res.statusText));
      return;
    }
    cargarCotizaciones();
    cargarNegocios();
  }

  if (e.target.classList.contains('btn-editar')) {
    editarCotizacion(id);
  }
});

// Carga una cotizacion (ya obtenida del servidor) en el formulario de Captura y muestra ese
// formulario. Se usa tanto desde el boton "Editar" de la tabla como desde el modal de detalle.
function cargarCotizacionEnFormulario(c) {
  cotizacionId.value = c.id_cotizacion;
  cotizacionNombre.value = c.nombre;
  cotizacionNegocio.value = c.negocio_id || '';
  cotizacionContacto.value = c.contacto_id || '';
  cotizacionDestino.value = c.destino_id || '';
  cotizacionRepresentante.value = c.representante_id || '';
  cotizacionMoneda.value = c.moneda;
  cotizacionEtapa.value = c.etapa || 'Negociacion';
  cotizacionDescuento.value = c.descuento_porcentaje || 0;
  partidas = c.items.map((it) => ({
    producto_item: it.producto_item,
    cantidad: it.cantidad,
    precio_unitario: it.precio_unitario,
  }));
  renderizarPartidas();
  actualizarResumen();

  cotizacionFechaCreacion.value = c.fecha_creacion || '';
  cotizacionVencimientoOpcion.value = detectarOpcionVencimiento(c.fecha_creacion, c.fecha_vencimiento);
  cotizacionVencimientoFecha.value = c.fecha_vencimiento || '';
  cotizacionVencimientoFecha.disabled = cotizacionVencimientoOpcion.value !== 'personalizada';
  cotizacionMetodoPago.value = c.metodo_pago || '';
  cotizacionLugarEntrega.value = c.lugar_entrega || '';
  cotizacionTiempoEntrega.value = c.tiempo_entrega || '';
  cotizacionFechaSeguimiento.value = c.fecha_seguimiento || '';
  cotizacionObservaciones.value = c.observaciones || '';

  btnGuardarCotizacion.textContent = 'Guardar cambios';
  btnEnviarTareasSeguimiento.hidden = false;
  mostrarDetallesGeneralesCotizacion(false);
  actualizarCamposVaciosCotizacion();
  activarSubtab('captura');
  abrirFormCotizacion();
  cotizacionNombre.focus();
}

async function editarCotizacion(id) {
  const res = await fetch(`/api/cotizaciones/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const c = await res.json();
  cargarCotizacionEnFormulario(c);
}

// Crea una copia editable de una cotizacion existente: abre Captura con los mismos productos,
// moneda, representante y datos de entrega, pero sin ID (se guarda como una cotizacion nueva),
// con fechas reiniciadas (como una cotizacion recien creada) y lista para cambiar
// Negocio/Contacto/Destino antes de guardar.
async function clonarCotizacion(id) {
  const res = await fetch(`/api/cotizaciones/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const c = await res.json();

  limpiarFormCotizacion();

  cotizacionNombre.value = `${c.nombre} (copia)`;
  cotizacionNegocio.value = c.negocio_id || '';
  cotizacionContacto.value = c.contacto_id || '';
  cotizacionDestino.value = c.destino_id || '';
  cotizacionRepresentante.value = c.representante_id || '';
  cotizacionMoneda.value = c.moneda;
  cotizacionDescuento.value = c.descuento_porcentaje || 0;
  cotizacionMetodoPago.value = c.metodo_pago || '';
  cotizacionLugarEntrega.value = c.lugar_entrega || '';
  cotizacionTiempoEntrega.value = c.tiempo_entrega || '';
  cotizacionObservaciones.value = c.observaciones || '';

  partidas = c.items.map((it) => ({
    producto_item: it.producto_item,
    cantidad: it.cantidad,
    precio_unitario: it.precio_unitario,
  }));
  renderizarPartidas();
  actualizarResumen();

  mostrarDetallesGeneralesCotizacion(true);
  actualizarCamposVaciosCotizacion();
  activarSubtab('captura');
  abrirFormCotizacion();
  cotizacionNombre.focus();
  cotizacionNombre.select();
}

// ---------- Detalle de una cotizacion (clic en la fila) ----------

const modalOverlay = document.getElementById('modal-overlay');
const modalContenido = document.getElementById('modal-contenido');
const modalCerrar = document.getElementById('modal-cerrar');

function campoFicha(etiqueta, valor) {
  return `<div><span>${escaparHtml(etiqueta)}</span><p>${valor !== null && valor !== undefined && valor !== '' ? escaparHtml(String(valor)) : '-'}</p></div>`;
}

// La clausula de "reportar daño en 24 horas" se resalta en rojo/negrita/mas grande que el
// resto de Observaciones (mismo criterio que el PDF), sin importar en que renglon venga escrita.
const CLAUSULA_DANIO_24H = /mercanc[ií]a con da[ñn]o debe reportarse/i;

function observacionesConClausulaResaltada(texto) {
  return texto
    .split('\n')
    .map((linea) => (CLAUSULA_DANIO_24H.test(linea) ? `<span class="clausula-danio">${escaparHtml(linea)}</span>` : escaparHtml(linea)))
    .join('\n');
}

// ---- Notas de seguimiento de un Negocio (bitacora, sin limite, con fecha/hora) ----

function fechaHoraNota(creadoEn) {
  if (!creadoEn) return '';
  const [fecha, hora] = creadoEn.split(' ');
  const [y, m, d] = fecha.split('-');
  return `${d}/${m}/${y} ${(hora || '').slice(0, 5)}`;
}

async function abrirNotasNegocio(id, nombre) {
  const res = await fetch(`/api/negocios/${encodeURIComponent(id)}/notas`);
  const notas = res.ok ? await res.json() : [];

  modalContenido.innerHTML = `
    <h2>Notas de seguimiento</h2>
    <p class="pista">${escaparHtml(nombre)}</p>
    <div class="notas-lista" id="notas-lista">
      ${notas.length ? notas.map((n) => `
        <div class="nota-item">
          <span class="nota-fecha">${fechaHoraNota(n.creado_en)}</span>
          <p>${escaparHtml(n.nota)}</p>
        </div>
      `).join('') : '<p class="pista">Todavía no hay notas para este negocio.</p>'}
    </div>
    ${permisosCatalogos.editar ? `
      <form id="form-negocio-nota">
        <input type="text" id="negocio-nota-texto" placeholder="Escribe una nota y presiona Enter..." autofocus />
      </form>
    ` : ''}
  `;

  const form = document.getElementById('form-negocio-nota');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('negocio-nota-texto');
      const texto = input.value.trim();
      if (!texto) return;

      const res2 = await fetch(`/api/negocios/${encodeURIComponent(id)}/notas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nota: texto }),
      });
      if (!res2.ok) {
        const error = await res2.json().catch(() => ({}));
        alert('Error: ' + (error.errores ? error.errores.join(', ') : res2.statusText));
        return;
      }
      abrirNotasNegocio(id, nombre);
    });
  }

  modalOverlay.hidden = false;
}

async function abrirDetalleCotizacion(id) {
  const res = await fetch(`/api/cotizaciones/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const c = await res.json();

  modalContenido.innerHTML = `
    <h2>${escaparHtml(c.nombre)}</h2>
    <div class="acciones-form">
      <button type="button" class="btn-pdf-cotizacion" data-id="${escaparHtml(c.id_cotizacion)}">Ver cotización</button>
      <button type="button" class="btn-descargar-pdf-cotizacion" data-id="${escaparHtml(c.id_cotizacion)}">Descargar PDF</button>
      ${permisosCatalogos.editar ? `<button type="button" class="btn-clonar-cotizacion" data-id="${escaparHtml(c.id_cotizacion)}">Clonar</button>` : ''}
      ${permisosCatalogos.editar ? `<button type="button" class="btn-editar-cotizacion" data-id="${escaparHtml(c.id_cotizacion)}">Editar</button>` : ''}
    </div>
    <div class="ficha-detalle">
      ${campoFicha('ID', c.id_cotizacion)}
      ${campoFicha('Negocio', c.negocio_nombre)}
      ${campoFicha('Contacto', c.contacto_nombre)}
      ${campoFicha('Hotel / Local', c.destino_nombre)}
      ${campoFicha('Representante de ventas', c.representante_nombre)}
      ${campoFicha('Moneda', c.moneda)}
      ${campoFicha('Fecha de creación', c.fecha_creacion)}
      ${campoFicha('Fecha de vencimiento', c.fecha_vencimiento)}
      <div><span>Estatus</span><p>${celdaEstatus(c.estatus)}</p></div>
      ${campoFicha('Método de pago', c.metodo_pago)}
      ${campoFicha('Lugar de entrega', c.lugar_entrega)}
      ${campoFicha('Tiempo de entrega', c.tiempo_entrega)}
      ${campoFicha('Fecha de seguimiento', c.fecha_seguimiento)}
    </div>
    ${c.observaciones ? `<p><strong>Observaciones:</strong></p><p class="observaciones-cotizacion">${observacionesConClausulaResaltada(c.observaciones)}</p>` : ''}
    <h3>Productos (${c.items.length})</h3>
    <div class="tabla-scroll">
      <table>
        <thead><tr><th>Producto</th><th>Descripción</th><th>Cantidad</th><th>Precio unitario</th><th>Total</th></tr></thead>
        <tbody>
          ${c.items.map((it) => `
            <tr>
              <td>${escaparHtml(it.producto_item)}</td>
              <td>${escaparHtml(it.producto_descripcion || '')}</td>
              <td>${formatoImporte(it.cantidad)}</td>
              <td>${formatoImporte(it.precio_unitario)}</td>
              <td>${formatoImporte(it.total)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    </div>
    <div class="ficha-detalle resumen-cotizacion">
      <div><span>Sub Total</span><p>${formatoImporte(c.subtotal)}</p></div>
      <div><span>Descuento (${c.descuento_porcentaje || 0}%)</span><p>${formatoImporte(c.descuento_monto)}</p></div>
      <div><span>IVA (16%)</span><p>${formatoImporte(c.iva)}</p></div>
      <div><span>Gran Total</span><p>${formatoImporte(c.gran_total)}</p></div>
    </div>
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
modalContenido.addEventListener('click', (e) => {
  if (e.target.classList.contains('btn-pdf-cotizacion')) {
    generarPDFCotizacion(e.target.dataset.id);
    return;
  }
  if (e.target.classList.contains('btn-descargar-pdf-cotizacion')) {
    descargarPDFCotizacion(e.target.dataset.id);
    return;
  }
  if (e.target.classList.contains('btn-clonar-cotizacion')) {
    cerrarModal();
    clonarCotizacion(e.target.dataset.id);
    return;
  }
  if (e.target.classList.contains('btn-editar-cotizacion')) {
    cerrarModal();
    editarCotizacion(e.target.dataset.id);
  }
});

tablaCotizaciones.addEventListener('click', (e) => {
  if (e.target.closest('button')) return;
  const fila = e.target.closest('tr');
  if (!fila) return;
  abrirDetalleCotizacion(fila.dataset.id);
});

// ---------- Alta rapida de Negocio (desde el formulario de Cotizacion) ----------

const btnNuevoNegocio = document.getElementById('btn-nuevo-negocio');
const modalRapidoOverlay = document.getElementById('modal-rapido-overlay');
const modalRapidoCerrar = document.getElementById('modal-rapido-cerrar');
const modalRapidoNombre = document.getElementById('modal-rapido-nombre');
const modalRapidoContacto = document.getElementById('modal-rapido-contacto');
const formRapidoNegocio = document.getElementById('form-rapido-negocio');

function abrirModalRapidoNegocio() {
  modalRapidoNombre.value = '';
  poblarSelect(modalRapidoContacto, contactosCache, 'id_contacto', 'nombre_completo_correo');
  modalRapidoContacto.value = cotizacionContacto.value || '';
  modalRapidoOverlay.hidden = false;
  modalRapidoNombre.focus();
}

function cerrarModalRapidoNegocio() {
  modalRapidoOverlay.hidden = true;
}

btnNuevoNegocio.addEventListener('click', abrirModalRapidoNegocio);
modalRapidoCerrar.addEventListener('click', cerrarModalRapidoNegocio);
modalRapidoOverlay.addEventListener('click', (e) => {
  if (e.target === modalRapidoOverlay) cerrarModalRapidoNegocio();
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (!modalRapidoOverlay.hidden) cerrarModalRapidoNegocio();
  else if (!modalRapidoContactoOverlay.hidden) cerrarModalRapidoContacto();
  else if (!modalRapidoDestinoOverlay.hidden) cerrarModalRapidoDestino();
  else if (!modalOverlay.hidden) cerrarModal();
});

// Etapa por default para negocios creados desde el alta rapida de Cotizaciones.
async function etapaCotizacionId() {
  const etapas = await fetch('/api/etapas-negocio').then((r) => r.json());
  const etapa = etapas.find((e) => e.etapa.toLowerCase() === 'negociacion');
  return etapa ? etapa.id_etapa : null;
}

formRapidoNegocio.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = modalRapidoNombre.value.trim();
  if (!nombre || !modalRapidoContacto.value) return;

  const res = await fetch('/api/negocios', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      negocio: nombre,
      contacto_id: modalRapidoContacto.value,
      etapa_id: await etapaCotizacionId(),
    }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }

  const creado = await res.json();
  const opt = document.createElement('option');
  opt.value = creado.id_negocio;
  opt.textContent = creado.negocio;
  cotizacionNegocio.appendChild(opt);
  cotizacionNegocio.value = creado.id_negocio;
  cotizacionContacto.value = creado.contacto_id || '';

  cerrarModalRapidoNegocio();
  cargarNegocios();
});

// ---------- Alta rapida de Contacto (desde el formulario de Cotizacion) ----------

const btnNuevoContactoCotizacion = document.getElementById('btn-nuevo-contacto-cotizacion');
const modalRapidoContactoOverlay = document.getElementById('modal-rapido-contacto-overlay');
const modalRapidoContactoCerrar = document.getElementById('modal-rapido-contacto-cerrar');
const modalRapidoContactoNombre = document.getElementById('modal-rapido-contacto-nombre');
const modalRapidoContactoApellido = document.getElementById('modal-rapido-contacto-apellido');
const modalRapidoContactoCorreo = document.getElementById('modal-rapido-contacto-correo');
const modalRapidoContactoTelLocal = document.getElementById('modal-rapido-contacto-tel-local');
const modalRapidoContactoTelCelular = document.getElementById('modal-rapido-contacto-tel-celular');
const formRapidoContacto = document.getElementById('form-rapido-contacto');

function abrirModalRapidoContacto() {
  formRapidoContacto.reset();
  modalRapidoContactoOverlay.hidden = false;
  modalRapidoContactoNombre.focus();
}

function cerrarModalRapidoContacto() {
  modalRapidoContactoOverlay.hidden = true;
}

btnNuevoContactoCotizacion.addEventListener('click', abrirModalRapidoContacto);
modalRapidoContactoCerrar.addEventListener('click', cerrarModalRapidoContacto);
modalRapidoContactoOverlay.addEventListener('click', (e) => {
  if (e.target === modalRapidoContactoOverlay) cerrarModalRapidoContacto();
});

formRapidoContacto.addEventListener('submit', async (e) => {
  e.preventDefault();
  const nombre = modalRapidoContactoNombre.value.trim();
  if (!nombre) return;

  // Si ya hay un Hotel/Local elegido en la cotizacion, el contacto nuevo nace asociado a el
  // (misma asociacion que se administra desde Contactos o desde el Hotel/Local).
  const res = await fetch('/api/contactos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      nombre,
      apellido: modalRapidoContactoApellido.value.trim(),
      correo_electronico: modalRapidoContactoCorreo.value.trim(),
      telefono_local: modalRapidoContactoTelLocal.value.trim(),
      telefono_celular: modalRapidoContactoTelCelular.value.trim(),
      destinos: cotizacionDestino.value ? [Number(cotizacionDestino.value)] : [],
    }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }

  const creado = await res.json();
  await poblarSelectsCotizacion();
  await poblarSelectsNegocio();
  cotizacionContacto.value = creado.id_contacto;
  actualizarCampoVacio(cotizacionContacto);

  cerrarModalRapidoContacto();
});

// ---------- Alta rapida de Destino (desde el formulario de Cotizacion) ----------

const btnNuevoDestinoCotizacion = document.getElementById('btn-nuevo-destino-cotizacion');
const modalRapidoDestinoOverlay = document.getElementById('modal-rapido-destino-overlay');
const modalRapidoDestinoCerrar = document.getElementById('modal-rapido-destino-cerrar');
const modalRapidoDestinoNombre = document.getElementById('modal-rapido-destino-nombre');
const formRapidoDestino = document.getElementById('form-rapido-destino');

function abrirModalRapidoDestino() {
  formRapidoDestino.reset();
  modalRapidoDestinoOverlay.hidden = false;
  modalRapidoDestinoNombre.focus();
}

function cerrarModalRapidoDestino() {
  modalRapidoDestinoOverlay.hidden = true;
}

btnNuevoDestinoCotizacion.addEventListener('click', abrirModalRapidoDestino);
modalRapidoDestinoCerrar.addEventListener('click', cerrarModalRapidoDestino);
modalRapidoDestinoOverlay.addEventListener('click', (e) => {
  if (e.target === modalRapidoDestinoOverlay) cerrarModalRapidoDestino();
});

formRapidoDestino.addEventListener('submit', async (e) => {
  e.preventDefault();
  const destino = modalRapidoDestinoNombre.value.trim();
  if (!destino) return;

  const res = await fetch('/api/destinos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ destino }),
  });

  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }

  const creado = await res.json();

  // Si ya hay un Contacto elegido en la cotizacion, el Hotel/Local nuevo nace asociado a el
  // (viceversa del alta rapida de Contacto: misma asociacion, mismo par contacto_destinos).
  if (cotizacionContacto.value) {
    await fetch(`/api/destinos/${creado.id_destino}/contactos`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contacto_id: cotizacionContacto.value }),
    }).catch(() => {});
  }

  await poblarSelectsCotizacion();
  cotizacionDestino.value = creado.id_destino;
  actualizarCampoVacio(cotizacionDestino);

  cerrarModalRapidoDestino();
});

// ---------- Generar PDF de la cotizacion ----------
// Los datos del vendedor/empresa son fijos (mismos en todas las cotizaciones, como el membrete
// del formato compartido). Si cambian, se ajustan aqui.
const EMISOR_COTIZACION = {
  nombre: 'Ramón Villanueva',
  puesto: 'Ventas',
  correo: 'rvillanueva@gonpal.com.mx',
  telefono: '+528183660778',
  empresa: 'Comercializadora Gonpal',
  direccion: ['Calle Tauro 205', 'Nueva Linda Vista', 'Guadalupe, N.L. 67110', 'México'],
};

const MESES_LARGO = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function fechaLarga(fechaISO) {
  if (!fechaISO) return '-';
  const [y, m, d] = fechaISO.split('-').map(Number);
  return `${d} de ${MESES_LARGO[m - 1]} de ${y}`;
}

function referenciaCotizacion(c) {
  const digitos = (c.creado_en || '').replace(/\D/g, '');
  return digitos ? `${digitos}000` : c.id_cotizacion;
}

function money(valor) {
  return '$' + formatoImporte(valor);
}

function formatoCantidad(valor) {
  const numero = Number(valor);
  return Number.isInteger(numero) ? numero.toLocaleString('es-MX') : formatoImporte(numero);
}

function generarHtmlCotizacionPDF(c) {
  const filasItems = c.items.map((it) => `
    <tr>
      <td>
        <div class="item-codigo">${escaparHtml(it.producto_item)}</div>
        <div class="item-desc">${escaparHtml(it.producto_descripcion || '')}</div>
      </td>
      <td class="num">${formatoCantidad(it.cantidad)}</td>
      <td class="num">${money(it.precio_unitario)}</td>
      <td class="num">${money(it.total)}</td>
    </tr>
  `).join('');

  return `<!doctype html>
<html lang="es">
<head>
<meta charset="UTF-8" />
<title>${escaparHtml(c.nombre)}</title>
<style>
  * { box-sizing: border-box; }
  body { font-family: 'Segoe UI', Arial, sans-serif; color: #1a1a1a; margin: 0; padding: 30px 40px 40px; font-size: 13px; }
  .logo { font-size: 1.3rem; font-weight: 800; color: #c0392b; letter-spacing: 1px; margin-bottom: 10px; }
  .encabezado { background: #fbe4e4; padding: 22px 26px; border-radius: 8px; }
  .encabezado h1 { margin: 0 0 18px; font-size: 1.5rem; }
  .info-grid { display: flex; justify-content: space-between; gap: 24px; }
  .info-izq div { margin-bottom: 3px; }
  .info-der { text-align: right; color: #333; }
  .info-der div { margin-bottom: 3px; }
  .caja { border: 1px solid #ddd; border-radius: 8px; padding: 16px 20px; margin-top: 24px; }
  .caja p { margin: 4px 0; }
  .observaciones-texto { white-space: pre-line; }
  .clausula-danio { color: #c0392b; font-weight: 700; font-size: 15px; }
  table { width: 100%; border-collapse: collapse; margin-top: 26px; page-break-inside: auto; }
  tr { page-break-inside: avoid; }
  th { text-align: left; border-bottom: 2px solid #333; padding: 6px 4px; font-size: 0.8rem; }
  td { padding: 10px 4px; border-bottom: 1px solid #eee; vertical-align: top; }
  td.num, th.num { text-align: right; white-space: nowrap; }
  .item-codigo { font-weight: 600; }
  .item-desc { color: #757575; font-size: 0.8rem; }
  .totales { width: 280px; margin-left: auto; margin-top: 10px; }
  .totales div { display: flex; justify-content: space-between; padding: 6px 4px; border-bottom: 1px solid #eee; }
  .totales .gran-total { font-weight: 700; font-size: 1.05rem; border-bottom: none; border-top: 2px solid #333; margin-top: 4px; }
  .condiciones { margin-top: 34px; text-align: justify; font-size: 0.78rem; color: #444; }
  .consideraciones strong { display: block; font-size: 0.85rem; color: #1a1a1a; margin: 14px 0 6px; }
  .consideraciones strong:first-child { margin-top: 0; }
  .consideraciones ol { margin: 0; padding-left: 1.2rem; }
  .consideraciones li { margin-bottom: 6px; }
  .footer { margin-top: 40px; }
  .footer p { margin: 0 0 10px; }
  @media print {
    body { padding: 0 30px 20px; }
    @page { size: letter; margin: 18mm 15mm; }
  }
</style>
</head>
<body>
  <div class="logo">GONPAL</div>
  <div class="encabezado">
    <h1>${escaparHtml(c.nombre)}</h1>
    <div class="info-grid">
      <div class="info-izq">
        <div><strong>${escaparHtml(c.negocio_nombre || '')}</strong></div>
        <div>${escaparHtml(c.destino_nombre || '')}</div>
        <div>&nbsp;</div>
        <div><strong>${escaparHtml(c.contacto_nombre || '')}</strong></div>
        ${c.contacto_correo ? `<div>${escaparHtml(c.contacto_correo)}</div>` : ''}
      </div>
      <div class="info-der">
        <div>Referencia: ${escaparHtml(referenciaCotizacion(c))}</div>
        <div>Creación del presupuesto: ${fechaLarga(c.fecha_creacion)}</div>
        <div>Caducidad del presupuesto: ${fechaLarga(c.fecha_vencimiento)}</div>
        <div>Presupuesto creado por: ${escaparHtml(c.representante_nombre || EMISOR_COTIZACION.nombre)}</div>
        <div>${escaparHtml(c.representante_correo || EMISOR_COTIZACION.correo)}</div>
      </div>
    </div>
  </div>

  <div class="caja">
    <p><strong>Comentarios de ${escaparHtml(c.representante_nombre || EMISOR_COTIZACION.nombre)}</strong></p>
    <p><strong>Cotización Basada en:</strong> ${escaparHtml(c.moneda)}</p>
    ${c.metodo_pago ? `<p><strong>Condiciones de Pago:</strong> ${escaparHtml(c.metodo_pago)}</p>` : ''}
    ${c.lugar_entrega ? `<p><strong>Lugar de envío:</strong> ${escaparHtml(c.lugar_entrega)}</p>` : ''}
    ${c.tiempo_entrega ? `<p><strong>Tiempo de entrega:</strong> ${escaparHtml(c.tiempo_entrega)}</p>` : ''}
    ${c.observaciones ? `<p><strong>Observaciones:</strong></p><p class="observaciones-texto">${observacionesConClausulaResaltada(c.observaciones)}</p>` : ''}
  </div>

  <table>
    <thead>
      <tr><th>Artículo y descripción</th><th class="num">Cantidad</th><th class="num">Precio unitario</th><th class="num">Total</th></tr>
    </thead>
    <tbody>${filasItems}</tbody>
  </table>

  <div class="totales">
    <div><span>Subtotal</span><span>${money(c.subtotal)}</span></div>
    ${c.descuento_monto ? `<div><span>Descuento (${c.descuento_porcentaje}%)</span><span>-${money(c.descuento_monto)}</span></div>` : ''}
    <div><span>IVA (16%)</span><span>${money(c.iva)}</span></div>
    <div class="gran-total"><span>Total</span><span>${money(c.gran_total)}</span></div>
  </div>

  <div class="condiciones">
    <strong>Condiciones de compra</strong><br />
    <strong>NOTA:</strong> TODA NUESTRA MERCANCÍA ESTA ASEGURADA EN TRANSPORTE, CUALQUIER INCIDENCIA SE DEBE
    REPORTAR EN LAS PRIMERAS 24 HORAS DE LA RECEPCIÓN PARA APLICAR EL SEGURO YA QUE DE LO
    CONTRARIO EL TRANSPORTE DEJA DE HACERSE RESPONSABLE.
  </div>

  <div class="condiciones consideraciones">
    <strong>Consideraciones de la Oferta</strong>
    <ol>
      <li>Esta cotización se basa en las cantidades y modelos especificados por el cliente.</li>
      <li>Los precios están sujetos a cambio si se modifican las condiciones originales requeridas por el cliente.</li>
      <li>Los orden de compra debe coincidir y liquidarse en la moneda en que se ha cotizado. La factura se emitirá en la misma moneda.</li>
      <li>Envío: Si no se especifica cargo por flete, los precios incluyen envío a 1 solo punto en la República Mexicana. No incluye gastos no indicados en la cotización.</li>
    </ol>

    <strong>PUNTO IMPORTANTE</strong>
    <ol>
      <li>Al momento de la entrega, el cliente debe verificar que los productos lleguen en condiciones óptimas. Una vez recibidos, serán responsabilidad del cliente. LA MERCANCÍA CON DAÑO DEBE REPORTARSE EN LAS PRIMERAS 24 HORAS DE LA RECEPCIÓN</li>
      <li>La información sobre las características de los productos a adquirir corresponde única y exclusivamente al cliente.</li>
      <li>Los modelos ofertados pueden ser sustituidos sin previo aviso por modelos de características idénticas o superiores.</li>
      <li>Las garantías para las pantallas LED ofertadas tienen una duración de 3 años, conforme al certificado de garantía incluido en el empaque del producto. La garantía de los productos varía según el modelo y marca.</li>
      <li>Los detalles de la garantía y su funcionamiento se encuentran en el certificado de garantía incluido en el empaque del producto.</li>
      <li>La garantía es limitada y no incluye condiciones especiales de servicio (como montaje, instalación y otros). Es importante verificar la mercancía al recibirla, ya que productos dañados o no son haberse reclamado antes no entran en garantía.</li>
      <li>Comercializadora Gonpal se deslinda de cualquier daño o perjuicio que el cliente pudiera tener derivado del uso inadecuado de los equipos cotizados/adquiridos.</li>
      <li>Una vez generada la orden de compra, esta no podrá ser cancelada ni modificada.</li>
    </ol>
  </div>

  <div class="footer">
    <p>¿Tienes alguna pregunta? Ponte en contacto conmigo</p>
    <p>
      ${lineasFirma(c).map(escaparHtml).join('<br />')}
    </p>
  </div>
</body>
</html>`;
}

// La firma del representante seleccionado (texto libre, capturada en su catalogo) reemplaza el
// bloque fijo de Ramon Villanueva/Gonpal cuando esta capturada; si no, se usa ese bloque como
// respaldo para no dejar el pie de la cotizacion en blanco.
function lineasFirma(c) {
  if ((c.representante_firma || '').trim()) {
    return c.representante_firma.split('\n').map((l) => l.trim()).filter(Boolean);
  }
  return [EMISOR_COTIZACION.nombre, EMISOR_COTIZACION.puesto, EMISOR_COTIZACION.correo, EMISOR_COTIZACION.telefono, EMISOR_COTIZACION.empresa, ...EMISOR_COTIZACION.direccion];
}

async function generarPDFCotizacion(id) {
  const res = await fetch(`/api/cotizaciones/${encodeURIComponent(id)}`);
  if (!res.ok) return;
  const c = await res.json();

  const blob = new Blob([generarHtmlCotizacionPDF(c)], { type: 'text/html' });
  const url = URL.createObjectURL(blob);
  const ventana = window.open(url, '_blank');
  if (!ventana) {
    alert('Tu navegador bloqueó la ventana emergente. Permítela para ver la cotización.');
  }
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

// Descarga directa del PDF (generado en el servidor), sin pasar por vista previa/imprimir.
function descargarPDFCotizacion(id) {
  window.location.href = `/api/cotizaciones/${encodeURIComponent(id)}/pdf?descargar=1`;
}

promesaAuth.then(async (sesion) => {
  if (!sesion) return;
  permisosCatalogos = sesion.permisos.catalogos;
  btnMostrarFormNegocio.hidden = !permisosCatalogos.editar;
  btnMostrarFormCotizacion.hidden = !permisosCatalogos.editar;
  btnNuevaCotizacionVisualizacion.hidden = !permisosCatalogos.editar;

  poblarSelectsNegocio().then(cargarNegocios);
  poblarSelectsCotizacion().then(cargarCotizaciones);

  const parametros = new URLSearchParams(window.location.search);

  // Enlaces directos a una pestana (ej. desde la barra lateral): ?tab=negocios o
  // ?tab=visualizacion. "captura" tiene su propio manejo mas abajo porque ademas precarga datos.
  const tabDirecto = parametros.get('tab');
  if (tabDirecto === 'negocios' || tabDirecto === 'visualizacion') activarSubtab(tabDirecto);

  // Se llego desde una Tarea con actividad "Cotizacion": abre directo la captura de una
  // cotizacion nueva y recuerda la tarea para borrarla cuando se guarde.
  const pendienteId = parametros.get('pendiente');
  if (pendienteId) {
    pendienteOrigenId = pendienteId;
    activarSubtab('captura');
    limpiarFormCotizacion();
    abrirFormCotizacion();
  }

  // Se llego desde el Calendario en Inicio: abre directo el detalle de esa cotizacion.
  const cotizacionId = parametros.get('cotizacion');
  if (cotizacionId) {
    activarSubtab('visualizacion');
    abrirDetalleCotizacion(cotizacionId);
  }

  // Se llego desde el detalle de un Contacto o Hotel/Local ("+ Agregar cotizacion"): abre la
  // Captura con negocio/contacto/destino pre-llenados cuando se conocen.
  if (parametros.get('tab') === 'captura') {
    const negocioIdUrl = parametros.get('negocio_id');
    const contactoIdUrl = parametros.get('contacto_id');
    const destinoIdUrl = parametros.get('destino_id');
    await Promise.all([poblarSelectsNegocio(), poblarSelectsCotizacion()]);
    activarSubtab('captura');
    limpiarFormCotizacion();
    abrirFormCotizacion();
    if (negocioIdUrl) {
      cotizacionNegocio.value = negocioIdUrl;
      replicarContactoYDestinoDeNegocio(negocioIdUrl);
    } else if (contactoIdUrl) {
      cotizacionContacto.value = contactoIdUrl;
    }
    if (destinoIdUrl) cotizacionDestino.value = destinoIdUrl;
  }

  suscribirTiempoReal(['negocios'], () => { poblarSelectsNegocio(); cargarNegocios(); });
  suscribirTiempoReal(['cotizaciones', 'cotizacion_items'], cargarCotizaciones);
  suscribirTiempoReal(['contactos', 'destinos', 'productos', 'representantes'], poblarSelectsCotizacion);
  suscribirTiempoReal(['etapas_negocio'], poblarSelectsNegocio);
});
