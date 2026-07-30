(function exposePasswordToggle(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RATPasswordToggle = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function buildPasswordToggle() {
  function nextPasswordType(currentType) {
    return currentType === 'password' ? 'text' : 'password';
  }

  function updateButton(button, input) {
    const visible = input.type === 'text';
    button.classList.toggle('is-visible', visible);
    button.setAttribute('aria-pressed', String(visible));
    button.setAttribute('aria-label', visible ? 'Ocultar contraseña' : 'Mostrar contraseña');
    button.title = visible ? 'Ocultar contraseña' : 'Mostrar contraseña';
  }

  function initialize(scope = document) {
    scope.querySelectorAll('[data-password-toggle]').forEach((button) => {
      if (button.dataset.passwordToggleReady === 'true') return;
      const input = (typeof scope.getElementById === 'function' ? scope.getElementById(button.dataset.passwordToggle) : null)
        || scope.querySelector(`#${button.dataset.passwordToggle}`);
      if (!input) return;
      button.dataset.passwordToggleReady = 'true';
      updateButton(button, input);
      button.addEventListener('click', () => {
        const selectionStart = input.selectionStart;
        const selectionEnd = input.selectionEnd;
        input.type = nextPasswordType(input.type);
        updateButton(button, input);
        input.focus();
        if (selectionStart !== null && selectionEnd !== null) input.setSelectionRange(selectionStart, selectionEnd);
      });
    });
  }

  function sync(scope = document) {
    scope.querySelectorAll('[data-password-toggle]').forEach((button) => {
      const input = (typeof scope.getElementById === 'function' ? scope.getElementById(button.dataset.passwordToggle) : null)
        || scope.querySelector(`#${button.dataset.passwordToggle}`);
      if (input) updateButton(button, input);
    });
  }

  return { initialize, nextPasswordType, sync };
}));

if (typeof document !== 'undefined') RATPasswordToggle.initialize(document);
