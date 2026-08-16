function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function formatoImporte(valor) {
  if (valor === null || valor === undefined) return '';
  return Number(valor).toLocaleString('es-MX', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

async function cargarOrdenes() {
  const res = await fetch('/api/ordenes');
  const ordenes = await res.json();
  document.getElementById('conteo-ordenes').textContent = ordenes.length;

  const tabla = document.getElementById('tabla-ordenes');
  tabla.innerHTML = ordenes.map((o) => `
    <tr>
      <td>${escaparHtml(o.id)}</td>
      <td>${escaparHtml(o.fecha || '')}</td>
      <td>${escaparHtml(o.imprimir || '')}</td>
      <td>${escaparHtml(o.nombre || '')}</td>
      <td>${escaparHtml(o.numero_oc || '')}</td>
      <td>${escaparHtml(o.estatus_sistema || '')}</td>
      <td>${escaparHtml(o.numero_seguimiento || '')}</td>
      <td>${escaparHtml(o.nota || '')}</td>
      <td>${o.moneda ?? ''}</td>
      <td>${formatoImporte(o.importe_moneda_extranjera)}</td>
      <td>${formatoImporte(o.importe)}</td>
      <td>${escaparHtml(o.estatus_nombre || '')}</td>
      <td>${escaparHtml(o.observaciones || '')}</td>
      <td>${escaparHtml(o.destino_nombre || '')}</td>
      <td>${escaparHtml(o.contacto_nombre || '')}</td>
      <td>${escaparHtml(o.estado_entrega_nombre || '')}</td>
    </tr>
  `).join('');
}

async function cargarDetalle() {
  const res = await fetch('/api/detalle-compra');
  const detalle = await res.json();
  document.getElementById('conteo-detalle').textContent = detalle.length;

  const tabla = document.getElementById('tabla-detalle');
  tabla.innerHTML = detalle.map((d) => `
    <tr>
      <td>${escaparHtml(d.id)}</td>
      <td>${escaparHtml(d.articulo || '')}</td>
      <td>${escaparHtml(d.tipo || '')}</td>
      <td>${escaparHtml(d.fecha || '')}</td>
      <td>${escaparHtml(d.numero_serie || '')}</td>
      <td>${d.cantidad_vendida ?? ''}</td>
      <td>${formatoImporte(d.importe)}</td>
    </tr>
  `).join('');
}

async function cargarDestinos() {
  const res = await fetch('/api/destinos');
  const destinos = await res.json();
  document.getElementById('conteo-destinos').textContent = destinos.length;

  const tabla = document.getElementById('tabla-destinos');
  tabla.innerHTML = destinos.map((d) => `
    <tr>
      <td>${d.id_destino}</td>
      <td>${escaparHtml(d.destino)}</td>
      <td>${escaparHtml((d.empresas || []).join(', '))}</td>
      <td>${escaparHtml((d.grupos || []).join(', '))}</td>
      <td>${escaparHtml((d.cadenas || []).join(', '))}</td>
    </tr>
  `).join('');
}

async function cargarContactos() {
  const res = await fetch('/api/contactos');
  const contactos = await res.json();
  document.getElementById('conteo-contactos').textContent = contactos.length;

  const tabla = document.getElementById('tabla-contactos');
  tabla.innerHTML = contactos.map((c) => `
    <tr>
      <td>${c.id_contacto}</td>
      <td>${escaparHtml(c.nombre_completo)}</td>
    </tr>
  `).join('');
}

async function cargarEmpresas() {
  const res = await fetch('/api/empresas');
  const empresas = await res.json();
  document.getElementById('conteo-empresas').textContent = empresas.length;

  const tabla = document.getElementById('tabla-empresas');
  tabla.innerHTML = empresas.map((e) => `
    <tr>
      <td>${e.id_empresa}</td>
      <td>${escaparHtml(e.empresa)}</td>
      <td>${e.destinos_asociados}</td>
    </tr>
  `).join('');
}

async function cargarGrupos() {
  const res = await fetch('/api/grupos');
  const grupos = await res.json();
  document.getElementById('conteo-grupos').textContent = grupos.length;

  const tabla = document.getElementById('tabla-grupos');
  tabla.innerHTML = grupos.map((g) => `
    <tr>
      <td>${g.id_grupo}</td>
      <td>${escaparHtml(g.grupo)}</td>
      <td>${g.destinos_asociados}</td>
    </tr>
  `).join('');
}

async function cargarCadenas() {
  const res = await fetch('/api/cadenas');
  const cadenas = await res.json();
  document.getElementById('conteo-cadenas').textContent = cadenas.length;

  const tabla = document.getElementById('tabla-cadenas');
  tabla.innerHTML = cadenas.map((c) => `
    <tr>
      <td>${c.id_cadena}</td>
      <td>${escaparHtml(c.cadena)}</td>
      <td>${c.destinos_asociados}</td>
    </tr>
  `).join('');
}

async function cargarEstatusCatalogo() {
  const res = await fetch('/api/estatus');
  const filas = await res.json();
  document.getElementById('conteo-estatus').textContent = filas.length;

  const tabla = document.getElementById('tabla-estatus');
  tabla.innerHTML = filas.map((f) => `
    <tr>
      <td>${f.id_estatus}</td>
      <td>${escaparHtml(f.estatus)}</td>
    </tr>
  `).join('');
}

async function cargarEstadosEntrega() {
  const res = await fetch('/api/estados-entrega');
  const filas = await res.json();
  document.getElementById('conteo-estado-entrega').textContent = filas.length;

  const tabla = document.getElementById('tabla-estado-entrega');
  tabla.innerHTML = filas.map((f) => `
    <tr>
      <td>${f.id_estado_entrega}</td>
      <td>${escaparHtml(f.estado_entrega)}</td>
    </tr>
  `).join('');
}

promesaAuth.then((sesion) => {
  if (!sesion) return;
  const { permisos } = sesion;

  if (permisos.ordenes.ver) cargarOrdenes();
  else document.getElementById('tabla-ordenes').closest('section').hidden = true;

  if (permisos.detalle_compra.ver) cargarDetalle();
  else document.getElementById('tabla-detalle').closest('section').hidden = true;

  if (permisos.catalogos.ver) {
    cargarDestinos();
    cargarContactos();
    cargarEmpresas();
    cargarGrupos();
    cargarCadenas();
    cargarEstatusCatalogo();
    cargarEstadosEntrega();
  } else {
    document.getElementById('tabla-destinos').closest('section').hidden = true;
    document.getElementById('tabla-contactos').closest('section').hidden = true;
    document.getElementById('tabla-empresas').closest('section').hidden = true;
    document.getElementById('tabla-grupos').closest('section').hidden = true;
    document.getElementById('tabla-cadenas').closest('section').hidden = true;
    document.getElementById('tabla-estatus').closest('section').hidden = true;
    document.getElementById('tabla-estado-entrega').closest('section').hidden = true;
  }

  if (permisos.ordenes.ver) suscribirTiempoReal(['ordenes'], cargarOrdenes);
  if (permisos.detalle_compra.ver) suscribirTiempoReal(['detalle_de_compra'], cargarDetalle);
  if (permisos.catalogos.ver) {
    suscribirTiempoReal(['destinos', 'destino_empresas', 'destino_grupos', 'destino_cadenas'], cargarDestinos);
    suscribirTiempoReal(['contactos'], cargarContactos);
    suscribirTiempoReal(['empresas'], cargarEmpresas);
    suscribirTiempoReal(['grupos'], cargarGrupos);
    suscribirTiempoReal(['cadenas'], cargarCadenas);
    suscribirTiempoReal(['estatus_catalogo'], cargarEstatusCatalogo);
    suscribirTiempoReal(['estados_entrega'], cargarEstadosEntrega);
  }
});
