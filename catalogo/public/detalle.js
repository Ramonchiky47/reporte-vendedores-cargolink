const form = document.getElementById('form-detalle');
const inputIdOriginal = document.getElementById('detalle-id-original');
const campos = {
  id: document.getElementById('id'),
  articulo: document.getElementById('articulo'),
  tipo: document.getElementById('tipo'),
  fecha: document.getElementById('fecha'),
  numero_serie: document.getElementById('numero_serie'),
  cantidad_vendida: document.getElementById('cantidad_vendida'),
  importe: document.getElementById('importe'),
};
const btnGuardar = document.getElementById('btn-guardar');
const btnCancelar = document.getElementById('btn-cancelar');
const btnMostrarForm = document.getElementById('btn-mostrar-form');
const tabla = document.getElementById('tabla-detalle');
const estadoVacio = document.getElementById('estado-vacio');
const buscar = document.getElementById('buscar');

function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

let ultimaLista = [];
const orden = { campo: 'fecha', direccion: 'desc' };

function comparar(va, vb) {
  if (va === null || va === undefined) va = '';
  if (vb === null || vb === undefined) vb = '';
  if (typeof va === 'number' && typeof vb === 'number') return va - vb;
  return String(va).localeCompare(String(vb), 'es', { numeric: true });
}

function ordenarYRenderizar() {
  const lista = [...ultimaLista].sort((a, b) => {
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

async function cargarDetalle() {
  const q = buscar.value.trim();
  const url = q ? `/api/detalle-compra?q=${encodeURIComponent(q)}` : '/api/detalle-compra';
  const res = await fetch(url);
  ultimaLista = await res.json();
  ordenarYRenderizar();
}

let permisosDetalle = { ver: true, editar: true, borrar: true };

function renderizar(lista) {
  tabla.innerHTML = '';
  estadoVacio.hidden = lista.length !== 0;

  for (const d of lista) {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escaparHtml(d.id)}</td>
      <td>${escaparHtml(d.articulo || '')}</td>
      <td>${escaparHtml(d.tipo || '')}</td>
      <td>${escaparHtml(d.fecha || '')}</td>
      <td>${escaparHtml(d.numero_serie || '')}</td>
      <td>${d.cantidad_vendida ?? ''}</td>
      <td>${formatoImporte(d.importe)}</td>
      <td class="acciones">
        ${permisosDetalle.editar ? `<button class="btn-editar" data-id="${d.id_detalle_compra}">Editar</button>` : ''}
        ${permisosDetalle.borrar ? `<button class="btn-borrar" data-id="${d.id_detalle_compra}">Borrar</button>` : ''}
      </td>
    `;
    tabla.appendChild(tr);
  }
}

function limpiarFormulario() {
  inputIdOriginal.value = '';
  form.reset();
  btnGuardar.textContent = 'Agregar artículo';
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
    articulo: campos.articulo.value.trim(),
    tipo: campos.tipo.value.trim(),
    fecha: campos.fecha.value,
    numero_serie: campos.numero_serie.value.trim(),
    cantidad_vendida: campos.cantidad_vendida.value,
    importe: campos.importe.value,
  };

  const idOriginal = inputIdOriginal.value;
  const esEdicion = Boolean(idOriginal);

  const res = await fetch(esEdicion ? `/api/detalle-compra/${idOriginal}` : '/api/detalle-compra', {
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
  cargarDetalle();
});

btnCancelar.addEventListener('click', cerrarFormulario);
btnMostrarForm.addEventListener('click', abrirFormulario);

tabla.addEventListener('click', async (e) => {
  const idDetalle = e.target.dataset.id;
  if (!idDetalle) return;

  if (e.target.classList.contains('btn-borrar')) {
    if (!confirmarDoble('¿Seguro que quieres borrar este artículo?')) return;
    await fetch(`/api/detalle-compra/${idDetalle}`, { method: 'DELETE' });
    cargarDetalle();
  }

  if (e.target.classList.contains('btn-editar')) {
    const res = await fetch(`/api/detalle-compra/${idDetalle}`);
    const d = await res.json();

    inputIdOriginal.value = d.id_detalle_compra;
    campos.id.value = d.id;
    campos.articulo.value = d.articulo || '';
    campos.tipo.value = d.tipo || '';
    campos.fecha.value = d.fecha || '';
    campos.numero_serie.value = d.numero_serie || '';
    campos.cantidad_vendida.value = d.cantidad_vendida ?? '';
    campos.importe.value = d.importe ?? '';

    btnGuardar.textContent = 'Guardar cambios';
    abrirFormulario();
    campos.articulo.focus();
  }
});

let temporizadorBusqueda;
buscar.addEventListener('input', () => {
  clearTimeout(temporizadorBusqueda);
  temporizadorBusqueda = setTimeout(cargarDetalle, 250);
});

promesaAuth.then((sesion) => {
  if (!sesion) return;
  permisosDetalle = sesion.permisos.detalle_compra;
  if (!permisosDetalle.editar) btnMostrarForm.hidden = true;
  cargarDetalle();

  suscribirTiempoReal(['detalle_de_compra'], cargarDetalle);
});
