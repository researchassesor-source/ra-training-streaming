renderBrand(document.getElementById('brand'));

const form = document.getElementById('loginForm');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const button = document.getElementById('loginButton');
const error = document.getElementById('loginError');

function setLoginError(message, field = null) {
  error.textContent = message || '';
  for (const input of [usernameInput, passwordInput]) input.setAttribute('aria-invalid', field === input.id ? 'true' : 'false');
  if (field) document.getElementById(field).focus();
}

async function alreadyAuthenticated() {
  try {
    const response = await fetch('/api/auth/me', { credentials: 'same-origin' });
    if (response.ok) window.location.replace('/dashboard.html');
  } catch {
    // The form remains usable when the initial status check fails.
  }
}

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  setLoginError('');
  if (!username) return setLoginError('Ingresa tu usuario para continuar.', 'username');
  if (!password) return setLoginError('Ingresa tu contraseña para continuar.', 'password');
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Ingresando…';
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
    setLoginError(RATCore.apiErrorMessage(requestError));
    button.disabled = false;
    button.setAttribute('aria-busy', 'false');
    button.textContent = 'Acceder al panel';
  }
});

alreadyAuthenticated();
