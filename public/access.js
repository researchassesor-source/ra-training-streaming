// Fetches a join token, showing a full-screen code prompt (without tearing
// down the page underneath) if the room requires a host code / password.
function requestToken({ room, identity, role, initialCode }) {
  return new Promise((resolve) => {
    let overlay = null;

    function showGate(errorMsg) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;background:#0f1115;z-index:1000;display:flex;align-items:center;justify-content:center;';
        overlay.innerHTML = `
          <div class="access-gate">
            <h2>Acceso restringido</h2>
            <p class="error" id="gateError"></p>
            <input id="gateCode" placeholder="Código de acceso" />
            <button id="gateSubmit">Entrar</button>
          </div>`;
        document.body.appendChild(overlay);
        document.getElementById('gateSubmit').onclick = () => attempt(document.getElementById('gateCode').value.trim());
        document.getElementById('gateCode').addEventListener('keydown', (ev) => {
          if (ev.key === 'Enter') attempt(document.getElementById('gateCode').value.trim());
        });
      }
      document.getElementById('gateError').textContent = errorMsg || '';
    }

    async function attempt(code) {
      const params = new URLSearchParams({ room, identity, role });
      if (code) params.set('code', code);
      let res, data;
      try {
        res = await fetch(`/api/token?${params.toString()}`);
        data = await res.json();
      } catch (e) {
        showGate('Error de red, intenta de nuevo');
        return;
      }
      if (res.ok) {
        if (overlay) overlay.remove();
        resolve(data);
        return;
      }
      showGate(data.error || 'Código requerido');
    }

    attempt(initialCode);
  });
}
