renderBrand(document.getElementById('brand'));

async function alreadyAuthenticated() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (response.ok) window.location.replace('/dashboard.html');
  } catch {
    // The form remains usable when the initial status check fails.
  }
}

document.getElementById('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const button = document.getElementById('loginButton');
  const error = document.getElementById('loginError');
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  error.textContent = '';
  button.disabled = true;
  button.textContent = 'Validando…';
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'No fue posible iniciar sesión');
    window.location.replace('/dashboard.html');
  } catch (requestError) {
    error.textContent = requestError.message;
    button.disabled = false;
    button.textContent = 'Acceder al panel';
  }
});

alreadyAuthenticated();
