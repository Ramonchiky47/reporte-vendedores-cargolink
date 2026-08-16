const form = document.getElementById('form-login');
const inputUsuario = document.getElementById('usuario');
const inputPassword = document.getElementById('password');
const errorLogin = document.getElementById('error-login');

// Si ya hay sesion activa, saltar directo a la app.
fetch('/api/me').then((r) => {
  if (r.ok) window.location.href = 'panel.html';
});

if (new URLSearchParams(window.location.search).get('motivo') === 'inactividad') {
  errorLogin.textContent = 'Tu sesión se cerró por inactividad. Vuelve a iniciar sesión.';
  errorLogin.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorLogin.hidden = true;

  const res = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ usuario: inputUsuario.value.trim(), password: inputPassword.value }),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    errorLogin.textContent = data.error || 'No se pudo iniciar sesion';
    errorLogin.hidden = false;
    return;
  }

  window.location.href = 'panel.html';
});
