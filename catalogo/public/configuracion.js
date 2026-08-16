function escaparHtml(texto) {
  const div = document.createElement('div');
  div.textContent = texto;
  return div.innerHTML;
}

function fechaDe(iso) {
  if (!iso) return '';
  return new Date(iso).toLocaleString('es-MX');
}

const seccionGoogleTasks = document.getElementById('seccion-google-tasks');
const googleTasksEstadoDiv = document.getElementById('google-tasks-estado');

async function cargarEstadoGoogleTasks() {
  googleTasksEstadoDiv.innerHTML = '<p>Cargando...</p>';
  const res = await fetch('/api/google-tasks/estado');
  if (!res.ok) {
    googleTasksEstadoDiv.innerHTML = '<p>No se pudo obtener el estado de la conexión.</p>';
    return;
  }
  const estado = await res.json();

  if (!estado.disponible) {
    googleTasksEstadoDiv.innerHTML = '<p class="estatus-vencido">Google Tasks no está configurado en el servidor (faltan las credenciales de Google Cloud).</p>';
    return;
  }

  if (estado.conectado) {
    googleTasksEstadoDiv.innerHTML = `
      <p class="estatus-vigente">Conectado${estado.conectadoPor ? ` por ${escaparHtml(estado.conectadoPor)}` : ''}${estado.conectadoEn ? ` el ${escaparHtml(fechaDe(estado.conectadoEn))}` : ''}.</p>
      <button type="button" id="btn-desconectar-google-tasks">Desconectar</button>
    `;
    document.getElementById('btn-desconectar-google-tasks').addEventListener('click', async () => {
      if (!confirm('¿Desconectar Google Tasks? Las tareas del CRM dejarán de sincronizarse.')) return;
      await fetch('/api/google-tasks/desconectar', { method: 'POST' });
      cargarEstadoGoogleTasks();
    });
  } else {
    googleTasksEstadoDiv.innerHTML = `
      <p>No conectado.</p>
      <button type="button" id="btn-conectar-google-tasks">Conectar con Google Tasks</button>
    `;
    document.getElementById('btn-conectar-google-tasks').addEventListener('click', () => {
      window.location.href = '/api/google-tasks/conectar';
    });
  }
}

const parametrosUrlConfig = new URLSearchParams(window.location.search);
if (parametrosUrlConfig.get('google_tasks') === 'error') {
  alert('No se pudo conectar con Google Tasks. Intenta de nuevo.');
}
if (parametrosUrlConfig.has('google_tasks')) {
  window.history.replaceState({}, '', window.location.pathname);
}

promesaAuth.then((sesion) => {
  if (!sesion) return;
  if (sesion.esAdmin) {
    seccionGoogleTasks.hidden = false;
    cargarEstadoGoogleTasks();
  }
});
