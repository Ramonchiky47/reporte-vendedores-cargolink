function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

async function eliminarYRecargar(url, recargar) {
  const res = await fetch(url, { method: 'DELETE' });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : error.error || res.statusText));
    return;
  }
  recargar();
}

function fechaDe(creadoEn) {
  return (creadoEn || '').split(' ')[0];
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// ---------- Tareas / Calendario: subtabs de Inicio ----------

function activarSubtabInicio(nombre) {
  document.querySelectorAll('#inicio-subnav .tab-catalogo').forEach((b) => {
    b.classList.toggle('activo', b.dataset.subtab === nombre);
  });
  document.querySelectorAll('[data-subpanel]').forEach((panel) => {
    panel.hidden = panel.dataset.subpanel !== nombre;
  });
  if (nombre === 'calendario') actualizarCalendario();
}

document.querySelectorAll('#inicio-subnav .tab-catalogo').forEach((boton) => {
  boton.addEventListener('click', () => activarSubtabInicio(boton.dataset.subtab));
});

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

let permisosCatalogos = { ver: false, editar: false, borrar: false };

const formPendiente = document.getElementById('form-pendiente');
const pendienteId = document.getElementById('pendiente-id');
const pendienteNombre = document.getElementById('pendiente-nombre');
const pendienteFechaCompromiso = document.getElementById('pendiente-fecha-compromiso');
const btnGuardarPendiente = document.getElementById('btn-guardar-pendiente');
const btnCancelarPendiente = document.getElementById('btn-cancelar-pendiente');
const btnMostrarFormPendiente = document.getElementById('btn-mostrar-form-pendiente');
const tablaPendientes = document.getElementById('tabla-pendientes');
const btnSincronizarGoogleTasks = document.getElementById('btn-sincronizar-google-tasks');
const pendienteContacto = document.getElementById('pendiente-contacto');
const pendienteDestino = document.getElementById('pendiente-destino');

// Llamada, Correo Electronico y Mensaje de Texto siempre deben quedar en el historial de un
// Contacto o un Hotel/Local (mismo criterio que valida el servidor, por nombre normalizado
// ya que el ID de la actividad no es fijo).
const ACTIVIDADES_COMUNICACION = ['llamada', 'correo electronico', 'mensaje de texto'];

function quitarAcentos(texto) {
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function actividadesSeleccionadasSonDeComunicacion() {
  return [...pendienteActividadesPanel.querySelectorAll('input[type="checkbox"]:checked')]
    .some((cb) => ACTIVIDADES_COMUNICACION.includes(quitarAcentos(cb.parentElement.textContent.trim().toLowerCase())));
}

function poblarSelect(select, lista, valor, texto, valorActual) {
  const actual = valorActual || select.value;
  select.innerHTML = '<option value="">-- Selecciona --</option>' + lista.map((item) => `
    <option value="${item[valor]}">${escaparHtml(item[texto])}</option>
  `).join('');
  select.value = actual || '';
}

async function cargarSelectsContactoDestinoPendiente() {
  const [contactos, destinos] = await Promise.all([
    fetch('/api/contactos').then((r) => r.json()),
    fetch('/api/destinos').then((r) => r.json()),
  ]);
  poblarSelect(pendienteContacto, contactos, 'id_contacto', 'nombre_completo_correo');
  poblarSelect(pendienteDestino, destinos, 'id_destino', 'destino');
}

// ---------- Multi-select de Actividades (mismo patron que Contacto-Destinos en Catalogos) ----------

const pendienteActividadesBtn = document.getElementById('pendiente-actividades-btn');
const pendienteActividadesPanel = document.getElementById('pendiente-actividades-panel');
const actividadesSeleccionadas = new Set();

async function cargarPanelActividades() {
  const res = await fetch('/api/actividades');
  const actividades = await res.json();
  pendienteActividadesPanel.innerHTML = actividades.length
    ? actividades.map((a) => `
        <label class="multi-select-opcion">
          <input type="checkbox" value="${a.id_actividad}" /><span class="multi-select-texto">${escaparHtml(a.actividad)}</span>
        </label>
      `).join('')
    : '<p class="pista">No hay actividades capturadas (agrégalas en Catálogos → Actividades).</p>';
}

function actualizarBotonActividades() {
  if (actividadesSeleccionadas.size === 0) {
    pendienteActividadesBtn.textContent = 'Sin actividades';
  } else if (actividadesSeleccionadas.size === 1) {
    const opcion = pendienteActividadesPanel.querySelector(`input[value="${[...actividadesSeleccionadas][0]}"]`);
    pendienteActividadesBtn.textContent = opcion ? opcion.parentElement.textContent.trim() : '1 actividad seleccionada';
  } else {
    pendienteActividadesBtn.textContent = `${actividadesSeleccionadas.size} actividades seleccionadas`;
  }
}

pendienteActividadesBtn.addEventListener('click', () => {
  pendienteActividadesPanel.hidden = !pendienteActividadesPanel.hidden;
});

pendienteActividadesPanel.addEventListener('change', (e) => {
  if (e.target.type !== 'checkbox') return;
  if (e.target.checked) actividadesSeleccionadas.add(e.target.value);
  else actividadesSeleccionadas.delete(e.target.value);
  actualizarBotonActividades();
});

document.addEventListener('click', (e) => {
  if (!document.getElementById('pendiente-actividades-wrap').contains(e.target)) {
    pendienteActividadesPanel.hidden = true;
  }
});

function marcarActividades(actividades) {
  actividadesSeleccionadas.clear();
  pendienteActividadesPanel.querySelectorAll('input[type="checkbox"]').forEach((cb) => {
    cb.checked = false;
  });
  for (const a of actividades || []) {
    const id = String(a.id_actividad);
    actividadesSeleccionadas.add(id);
    const cb = pendienteActividadesPanel.querySelector(`input[value="${id}"]`);
    if (cb) cb.checked = true;
  }
  actualizarBotonActividades();
}

// ---------- Pendientes ----------

// Una tarea vencida (fecha de compromiso ya pasada) no se oculta: se queda en la lista
// coloreada en rojo hasta que se cambie su fecha de compromiso o se borre/marque como lista.
function esTareaVencida(p) {
  return !!p.fecha_compromiso && p.fecha_compromiso < hoyISO();
}

function hoyISO() {
  const hoy = new Date();
  const mes = String(hoy.getMonth() + 1).padStart(2, '0');
  const dia = String(hoy.getDate()).padStart(2, '0');
  return `${hoy.getFullYear()}-${mes}-${dia}`;
}

function esTareaDeCotizacion(p) {
  return (p.actividades || []).some((a) => a.actividad.trim().toLowerCase() === 'cotizacion'
    || a.actividad.trim().toLowerCase() === 'cotización');
}

function esTareaDeSeguimiento(p) {
  return (p.actividades || []).some((a) => a.actividad.trim().toLowerCase() === 'seguimiento');
}

function renderizarPendientes(lista) {
  tablaPendientes.innerHTML = lista.map((p) => {
    const actividadesTexto = (p.actividades || []).map((a) => a.actividad).join(', ');
    const esCotizacion = esTareaDeCotizacion(p);
    const esSeguimiento = !esCotizacion && esTareaDeSeguimiento(p);

    const clases = [];
    let dataExtra = '';
    if (esCotizacion) {
      clases.push('fila-clicable');
      dataExtra = `data-ir-cotizacion="${p.id_pendiente}" title="Ir a Cotizaciones"`;
    } else if (esSeguimiento) {
      clases.push('fila-clicable');
      dataExtra = `data-ir-notas="${p.id_pendiente}" data-nombre-nota="${escaparHtml(p.nombre)}" title="Ver bitácora de seguimiento"`;
    }
    if (p.tiene_notas) clases.push('fila-con-notas');
    if (esTareaVencida(p)) clases.push('fila-vencida');

    return `
      <tr ${clases.length ? `class="${clases.join(' ')}"` : ''} ${dataExtra}>
        <td>${escaparHtml(p.id_pendiente)}</td>
        <td>${escaparHtml(p.nombre)}</td>
        <td>${escaparHtml(fechaDe(p.creado_en))}</td>
        <td>${escaparHtml(fechaDe(p.fecha_compromiso) || '')}</td>
        <td>${escaparHtml(actividadesTexto)}</td>
        <td class="acciones">
          ${permisosCatalogos.editar ? `<button class="btn-listo" data-id="${p.id_pendiente}">Listo</button>` : ''}
          ${permisosCatalogos.editar ? `<button class="btn-editar" data-id="${p.id_pendiente}">Editar</button>` : ''}
          ${permisosCatalogos.editar ? `<button class="btn-borrar" data-id="${p.id_pendiente}">Borrar</button>` : ''}
        </td>
      </tr>
    `;
  }).join('');
}

const ordenadorPendientes = crearOrdenador(tablaPendientes, renderizarPendientes);

async function cargarPendientes() {
  const res = await fetch('/api/pendientes');
  const pendientes = await res.json();
  ordenadorPendientes.actualizarDatos(pendientes);
}

// Trae de Google Tasks las tareas que ya se completaron o se borraron alla (Google Tasks no
// tiene forma de avisar en tiempo real, asi que esto se llama al abrir Tareas y con el boton).
async function sincronizarConGoogleTasks() {
  if (!btnSincronizarGoogleTasks || btnSincronizarGoogleTasks.hidden) return;
  const textoOriginal = btnSincronizarGoogleTasks.textContent;
  btnSincronizarGoogleTasks.disabled = true;
  btnSincronizarGoogleTasks.textContent = 'Sincronizando...';
  try {
    const res = await fetch('/api/pendientes/sincronizar-google', { method: 'POST' });
    if (res.ok) {
      const resultado = await res.json();
      if (resultado.eliminados && resultado.eliminados.length) {
        await cargarPendientes();
      }
    }
  } finally {
    btnSincronizarGoogleTasks.disabled = false;
    btnSincronizarGoogleTasks.textContent = textoOriginal;
  }
}

function limpiarFormPendiente() {
  pendienteId.value = '';
  formPendiente.reset();
  marcarActividades([]);
  pendienteContacto.value = '';
  pendienteDestino.value = '';
  pendienteActividadesBtn.disabled = false;
  btnGuardarPendiente.textContent = 'Agregar';
  btnCancelarPendiente.hidden = true;
}

function abrirFormPendiente() {
  formPendiente.hidden = false;
  btnMostrarFormPendiente.hidden = true;
}

function cerrarFormPendiente() {
  limpiarFormPendiente();
  formPendiente.hidden = true;
  btnMostrarFormPendiente.hidden = false;
}

formPendiente.addEventListener('submit', async (e) => {
  e.preventDefault();
  if (actividadesSeleccionadas.size === 0) {
    alert('Selecciona al menos una actividad.');
    return;
  }
  if (!pendienteContacto.value && !pendienteDestino.value && actividadesSeleccionadasSonDeComunicacion()) {
    alert('Para Llamada, Correo Electrónico o Mensaje de Texto, selecciona un Contacto o un Hotel/Local.');
    return;
  }
  const payload = {
    nombre: pendienteNombre.value.trim(),
    fecha_compromiso: pendienteFechaCompromiso.value || null,
    actividades: [...actividadesSeleccionadas].map(Number),
    contacto_id: pendienteContacto.value || null,
    destino_id: pendienteDestino.value || null,
  };
  const id = pendienteId.value;
  const res = await fetch(id ? `/api/pendientes/${id}` : '/api/pendientes', {
    method: id ? 'PUT' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const error = await res.json().catch(() => ({}));
    alert('Error: ' + (error.errores ? error.errores.join(', ') : res.statusText));
    return;
  }
  cerrarFormPendiente();
  cargarPendientes();
});

btnCancelarPendiente.addEventListener('click', cerrarFormPendiente);
btnMostrarFormPendiente.addEventListener('click', abrirFormPendiente);

tablaPendientes.addEventListener('click', async (e) => {
  const id = e.target.dataset.id;

  if (id) {
    if (e.target.classList.contains('btn-listo')) {
      if (!confirmarDoble('¿Marcar este pendiente como listo?')) return;
      await eliminarYRecargar(`/api/pendientes/${id}`, cargarPendientes);
    }

    if (e.target.classList.contains('btn-borrar')) {
      if (!confirmarDoble('¿Borrar este pendiente?')) return;
      await eliminarYRecargar(`/api/pendientes/${id}`, cargarPendientes);
    }

    if (e.target.classList.contains('btn-editar')) {
      const res = await fetch('/api/pendientes');
      const pendientes = await res.json();
      const p = pendientes.find((x) => x.id_pendiente === id);
      if (!p) return;

      pendienteId.value = p.id_pendiente;
      pendienteNombre.value = p.nombre;
      pendienteFechaCompromiso.value = p.fecha_compromiso || '';
      marcarActividades(p.actividades);
      pendienteContacto.value = p.contacto_id || '';
      pendienteDestino.value = p.destino_id || '';

      // La actividad de una tarea no se puede cambiar una vez creada.
      pendienteActividadesBtn.disabled = true;

      btnGuardarPendiente.textContent = 'Guardar cambios';
      btnCancelarPendiente.hidden = false;
      abrirFormPendiente();
      pendienteNombre.focus();
    }
    return;
  }

  // Tarea con actividad "Cotizacion": clic en la fila (fuera de los botones) lleva a
  // Cotizaciones a capturar una nueva; al guardarla, esa tarea se borra sola.
  const filaCotizacion = e.target.closest('tr[data-ir-cotizacion]');
  if (filaCotizacion) {
    window.location.href = `cotizaciones.html?pendiente=${encodeURIComponent(filaCotizacion.dataset.irCotizacion)}`;
    return;
  }

  // Tarea con actividad "Seguimiento": clic en la fila abre la bitacora de notas
  // (fecha y hora automaticas, texto libre sin limite de longitud).
  const filaNotas = e.target.closest('tr[data-ir-notas]');
  if (filaNotas) {
    abrirNotasPendiente(filaNotas.dataset.irNotas, filaNotas.dataset.nombreNota);
  }
});

// ---------- Notas de seguimiento de una Tarea (bitacora, sin limite, con fecha/hora) ----------

const modalOverlay = document.getElementById('modal-overlay');
const modalContenido = document.getElementById('modal-contenido');
const modalCerrar = document.getElementById('modal-cerrar');

function cerrarModal() {
  modalOverlay.hidden = true;
  modalContenido.innerHTML = '';
}

modalCerrar.addEventListener('click', cerrarModal);
modalOverlay.addEventListener('click', (e) => {
  if (e.target === modalOverlay) cerrarModal();
});

function fechaHoraNota(creadoEn) {
  if (!creadoEn) return '';
  const [fecha, hora] = creadoEn.split(' ');
  const [y, m, d] = fecha.split('-');
  return `${d}/${m}/${y} ${(hora || '').slice(0, 5)}`;
}

async function abrirNotasPendiente(id, nombre) {
  const res = await fetch(`/api/pendientes/${encodeURIComponent(id)}/notas`);
  const notas = res.ok ? await res.json() : [];

  modalContenido.innerHTML = `
    <h2>Bitácora de seguimiento</h2>
    <p class="pista">${escaparHtml(nombre)}</p>
    <div class="notas-lista" id="notas-lista">
      ${notas.length ? notas.map((n) => `
        <div class="nota-item">
          <span class="nota-fecha">${fechaHoraNota(n.creado_en)}</span>
          <p>${escaparHtml(n.nota)}</p>
        </div>
      `).join('') : '<p class="pista">Todavía no hay notas para esta tarea.</p>'}
    </div>
    ${permisosCatalogos.editar ? `
      <form id="form-pendiente-nota">
        <input type="text" id="pendiente-nota-texto" placeholder="Escribe una actualización y presiona Enter..." autofocus />
      </form>
    ` : ''}
  `;

  const form = document.getElementById('form-pendiente-nota');
  if (form) {
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = document.getElementById('pendiente-nota-texto');
      const texto = input.value.trim();
      if (!texto) return;

      const res2 = await fetch(`/api/pendientes/${encodeURIComponent(id)}/notas`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ nota: texto }),
      });
      if (!res2.ok) {
        const error = await res2.json().catch(() => ({}));
        alert('Error: ' + (error.errores ? error.errores.join(', ') : res2.statusText));
        return;
      }
      abrirNotasPendiente(id, nombre);
      cargarPendientes();
    });
  }

  modalOverlay.hidden = false;
}

// ---------- Calendario ----------
// Agrupa las cotizaciones por Fecha de seguimiento y las tareas de Seguimiento por Fecha de
// compromiso, mostrandolas juntas en vista mensual, semanal o diaria.

function sumarDias(fechaISO, dias) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const fecha = new Date(Date.UTC(y, m - 1, d));
  fecha.setUTCDate(fecha.getUTCDate() + dias);
  return fecha.toISOString().slice(0, 10);
}

const MESES_LARGO = [
  'enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio',
  'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre',
];

function fechaLarga(fechaISO) {
  if (!fechaISO) return '-';
  const [y, m, d] = fechaISO.split('-').map(Number);
  return `${d} de ${MESES_LARGO[m - 1]} de ${y}`;
}

const DIAS_LARGO = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const DIAS_CORTO = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];

const calendarioTitulo = document.getElementById('calendario-titulo');
const calendarioContenido = document.getElementById('calendario-contenido');
const btnCalendarioAnterior = document.getElementById('btn-calendario-anterior');
const btnCalendarioSiguiente = document.getElementById('btn-calendario-siguiente');
const btnCalendarioHoy = document.getElementById('btn-calendario-hoy');
const botonesVistaCalendario = document.querySelectorAll('[data-vista]');

let calendarioVista = 'semana';
let calendarioFechaRef = hoyISO();
let cotizacionesPorFecha = new Map();
let pendientesPorFecha = new Map();

function diaDeLaSemanaISO(fechaISO) {
  const [y, m, d] = fechaISO.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return (dow + 6) % 7;
}

function diasEnMes(y, m) {
  return new Date(y, m, 0).getDate();
}

function inicioDeSemana(fechaISO) {
  return sumarDias(fechaISO, -diaDeLaSemanaISO(fechaISO));
}

function inicioDeMes(fechaISO) {
  const [y, m] = fechaISO.split('-').map(Number);
  return `${y}-${String(m).padStart(2, '0')}-01`;
}

async function cargarCotizacionesParaCalendario() {
  const res = await fetch('/api/cotizaciones');
  const cotizaciones = await res.json();
  cotizacionesPorFecha = new Map();
  for (const c of cotizaciones) {
    if (!c.fecha_seguimiento) continue;
    if (!cotizacionesPorFecha.has(c.fecha_seguimiento)) cotizacionesPorFecha.set(c.fecha_seguimiento, []);
    cotizacionesPorFecha.get(c.fecha_seguimiento).push(c);
  }
}

async function cargarPendientesParaCalendario() {
  const res = await fetch('/api/pendientes');
  const pendientes = await res.json();
  pendientesPorFecha = new Map();
  for (const p of pendientes) {
    if (!p.fecha_compromiso) continue;
    const esSeguimiento = (p.actividades || []).some((a) => a.actividad.trim().toLowerCase() === 'seguimiento');
    if (!esSeguimiento) continue;

    // Se plota todos los dias, desde su Fecha de creacion hasta su Fecha de compromiso (ambas incluidas).
    let fecha = fechaDe(p.creado_en);
    while (fecha <= p.fecha_compromiso) {
      if (!pendientesPorFecha.has(fecha)) pendientesPorFecha.set(fecha, []);
      pendientesPorFecha.get(fecha).push(p);
      fecha = sumarDias(fecha, 1);
    }
  }
}

function chipCotizacion(c) {
  const clase = c.estatus === 'Vencido' ? 'estatus-vencido' : 'estatus-vigente';
  return `
    <button type="button" class="calendario-item ${clase}" data-id="${escaparHtml(c.id_cotizacion)}">
      ${escaparHtml(c.nombre)}
    </button>
  `;
}

function chipPendiente(p) {
  return `
    <button type="button" class="calendario-item tarea-seguimiento" data-pendiente-id="${escaparHtml(p.id_pendiente)}" title="Tarea (Seguimiento)">
      📌 ${escaparHtml(p.nombre)}
    </button>
  `;
}

function celdaDia(fechaISO, { fueraDeRango = false, etiqueta = null } = {}) {
  const cotizaciones = cotizacionesPorFecha.get(fechaISO) || [];
  const pendientes = pendientesPorFecha.get(fechaISO) || [];
  const [, , diaNum] = fechaISO.split('-');
  return `
    <div class="calendario-celda ${fueraDeRango ? 'fuera-de-rango' : ''} ${fechaISO === hoyISO() ? 'es-hoy' : ''}">
      <div class="calendario-celda-fecha">${etiqueta || Number(diaNum)}</div>
      <div class="calendario-celda-items">
        ${pendientes.map(chipPendiente).join('')}
        ${cotizaciones.map(chipCotizacion).join('')}
      </div>
    </div>
  `;
}

function renderizarVistaMes() {
  const inicioMes = inicioDeMes(calendarioFechaRef);
  const [y, m] = calendarioFechaRef.split('-').map(Number);
  const totalDias = diasEnMes(y, m);
  const primerLunes = inicioDeSemana(inicioMes);

  const celdas = [];
  let cursor = primerLunes;
  const finMes = sumarDias(inicioMes, totalDias - 1);
  const ultimoDomingo = inicioDeSemana(finMes) === finMes
    ? finMes
    : sumarDias(inicioDeSemana(finMes), 6);

  while (cursor <= ultimoDomingo) {
    celdas.push(celdaDia(cursor, { fueraDeRango: cursor < inicioMes || cursor > finMes }));
    cursor = sumarDias(cursor, 1);
  }

  calendarioTitulo.textContent = `${MESES_LARGO[m - 1][0].toUpperCase()}${MESES_LARGO[m - 1].slice(1)} ${y}`;
  calendarioContenido.innerHTML = `
    <div class="calendario-grid calendario-mes">
      ${DIAS_CORTO.map((d) => `<div class="calendario-encabezado-dia">${d}</div>`).join('')}
      ${celdas.join('')}
    </div>
  `;
}

function renderizarVistaSemana() {
  const inicio = inicioDeSemana(calendarioFechaRef);
  const celdas = [];
  for (let i = 0; i < 7; i++) {
    const fecha = sumarDias(inicio, i);
    const [, , diaNum] = fecha.split('-');
    const [, mesNum] = fecha.split('-');
    celdas.push(celdaDia(fecha, { etiqueta: `${DIAS_CORTO[i]} ${Number(diaNum)}/${Number(mesNum)}` }));
  }

  const fin = sumarDias(inicio, 6);
  calendarioTitulo.textContent = `${fechaLarga(inicio)} – ${fechaLarga(fin)}`;
  calendarioContenido.innerHTML = `
    <div class="calendario-grid calendario-semana">
      ${celdas.join('')}
    </div>
  `;
}

function renderizarVistaDia() {
  const cotizaciones = cotizacionesPorFecha.get(calendarioFechaRef) || [];
  const pendientes = pendientesPorFecha.get(calendarioFechaRef) || [];
  const [y, m, d] = calendarioFechaRef.split('-').map(Number);
  const nombreDia = DIAS_LARGO[(diaDeLaSemanaISO(calendarioFechaRef) + 1) % 7];

  calendarioTitulo.textContent = `${nombreDia.charAt(0).toUpperCase()}${nombreDia.slice(1)} ${d} de ${MESES_LARGO[m - 1]} de ${y}`;
  calendarioContenido.innerHTML = `
    <div class="calendario-dia-lista">
      ${pendientes.map((p) => `
        <button type="button" class="calendario-item-dia tarea-seguimiento" data-pendiente-id="${escaparHtml(p.id_pendiente)}">
          <strong>📌 ${escaparHtml(p.nombre)}</strong>
          <span>Tarea (Seguimiento)</span>
        </button>
      `).join('')}
      ${cotizaciones.length ? cotizaciones.map((c) => `
        <button type="button" class="calendario-item-dia ${c.estatus === 'Vencido' ? 'estatus-vencido' : 'estatus-vigente'}" data-id="${escaparHtml(c.id_cotizacion)}">
          <strong>${escaparHtml(c.nombre)}</strong>
          <span>${escaparHtml(c.negocio_nombre || '')} · ${escaparHtml(c.contacto_nombre || '')}</span>
          <span>${escaparHtml(c.moneda)} ${formatoImporte(c.gran_total)} · ${escaparHtml(c.estatus)}</span>
        </button>
      `).join('') : ''}
      ${!pendientes.length && !cotizaciones.length ? '<p class="pista">Sin cotizaciones ni tareas de seguimiento en este día.</p>' : ''}
    </div>
  `;
}

function renderizarCalendario() {
  if (calendarioVista === 'mes') renderizarVistaMes();
  else if (calendarioVista === 'semana') renderizarVistaSemana();
  else renderizarVistaDia();
}

async function actualizarCalendario() {
  await Promise.all([cargarCotizacionesParaCalendario(), cargarPendientesParaCalendario()]);
  renderizarCalendario();
}

botonesVistaCalendario.forEach((boton) => {
  boton.addEventListener('click', () => {
    botonesVistaCalendario.forEach((b) => b.classList.remove('activo'));
    boton.classList.add('activo');
    calendarioVista = boton.dataset.vista;
    renderizarCalendario();
  });
});

btnCalendarioAnterior.addEventListener('click', () => {
  if (calendarioVista === 'mes') {
    const [y, m] = calendarioFechaRef.split('-').map(Number);
    const mesAnterior = m === 1 ? 12 : m - 1;
    const anioAnterior = m === 1 ? y - 1 : y;
    calendarioFechaRef = `${anioAnterior}-${String(mesAnterior).padStart(2, '0')}-01`;
  } else if (calendarioVista === 'semana') {
    calendarioFechaRef = sumarDias(calendarioFechaRef, -7);
  } else {
    calendarioFechaRef = sumarDias(calendarioFechaRef, -1);
  }
  renderizarCalendario();
});

btnCalendarioSiguiente.addEventListener('click', () => {
  if (calendarioVista === 'mes') {
    const [y, m] = calendarioFechaRef.split('-').map(Number);
    const mesSiguiente = m === 12 ? 1 : m + 1;
    const anioSiguiente = m === 12 ? y + 1 : y;
    calendarioFechaRef = `${anioSiguiente}-${String(mesSiguiente).padStart(2, '0')}-01`;
  } else if (calendarioVista === 'semana') {
    calendarioFechaRef = sumarDias(calendarioFechaRef, 7);
  } else {
    calendarioFechaRef = sumarDias(calendarioFechaRef, 1);
  }
  renderizarCalendario();
});

btnCalendarioHoy.addEventListener('click', () => {
  calendarioFechaRef = hoyISO();
  renderizarCalendario();
});

calendarioContenido.addEventListener('click', (e) => {
  const boton = e.target.closest('.calendario-item, .calendario-item-dia');
  if (!boton) return;
  if (boton.dataset.pendienteId) {
    activarSubtabInicio('tareas');
    return;
  }
  window.location.href = `cotizaciones.html?cotizacion=${encodeURIComponent(boton.dataset.id)}`;
});

promesaAuth.then(async (sesion) => {
  if (!sesion) return;
  permisosCatalogos = sesion.permisos.catalogos;

  const inicioSubnav = document.getElementById('inicio-subnav');
  if (!permisosCatalogos.ver) {
    if (inicioSubnav) inicioSubnav.hidden = true;
    document.querySelectorAll('[data-subpanel]').forEach((panel) => { panel.hidden = true; });
    return;
  }

  btnMostrarFormPendiente.hidden = !permisosCatalogos.editar;
  btnSincronizarGoogleTasks.hidden = !permisosCatalogos.editar;

  await cargarPanelActividades();
  await cargarSelectsContactoDestinoPendiente();
  await cargarPendientes();
  if (permisosCatalogos.editar) sincronizarConGoogleTasks();

  suscribirTiempoReal(['pendientes', 'pendiente_actividades', 'pendiente_notas'], cargarPendientes);
  suscribirTiempoReal(['actividades'], cargarPanelActividades);
  suscribirTiempoReal(['contactos', 'destinos'], cargarSelectsContactoDestinoPendiente);
});

btnSincronizarGoogleTasks.addEventListener('click', sincronizarConGoogleTasks);
