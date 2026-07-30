function makeDraggable(element, handle = element) {
  let drag = null;
  function move(event) {
    if (!drag) return;
    const left = Math.max(4, Math.min(innerWidth - element.offsetWidth - 4, drag.left + event.clientX - drag.x));
    const top = Math.max(4, Math.min(innerHeight - element.offsetHeight - 4, drag.top + event.clientY - drag.y));
    Object.assign(element.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
  }
  function end() { drag = null; document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', end); }
  handle.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, input, a, label')) return;
    const rect = element.getBoundingClientRect(); drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    document.addEventListener('pointermove', move); document.addEventListener('pointerup', end);
  });
}

function attachCompanionWindow(button, model, actions = {}) {
  if (!button) return { close() {} };
  let pipWindow = null;
  let unsubscribe = null;

  function render(documentRef, state) {
    const root = documentRef.getElementById('companionRoot');
    if (!root) return;
    root.querySelector('[data-live]').textContent = state.recording ? 'Grabando' : state.live ? 'En vivo' : 'En espera';
    root.querySelector('[data-title]').textContent = state.title || 'Reunión';
    root.querySelector('[data-participants]').textContent = `${state.participants} participantes`;
    root.querySelector('[data-hands]').textContent = `${state.raisedHands} manos levantadas`;
    root.querySelector('[data-messages]').textContent = `${state.unreadMessages} mensajes nuevos`;
    root.querySelector('[data-questions]').textContent = `${state.unreadQuestions} preguntas nuevas`;
    root.querySelector('[data-connection]').textContent = RATCore.CONNECTION_STATES[state.connection] || state.connection;
    root.querySelector('[data-mic]').setAttribute('aria-pressed', String(state.microphone));
    root.querySelector('[data-mic]').textContent = state.microphone ? 'Silenciar' : 'Micrófono';
    root.querySelector('[data-camera]').setAttribute('aria-pressed', String(state.camera));
    root.querySelector('[data-camera]').textContent = state.camera ? 'Apagar cámara' : 'Cámara';
  }

  function build(documentRef) {
    documentRef.head.innerHTML = `<meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${location.origin}/style.css">`;
    documentRef.body.innerHTML = `<main id="companionRoot" class="companion-window">
      <div class="companion-heading"><img src="${location.origin}/assets/icon-192.png" alt="Icono de R.A. Training Streaming"><span class="companion-live" data-live></span></div><h1 data-title></h1>
      <div class="companion-metrics"><span data-participants></span><span data-hands></span><span data-messages></span><span data-questions></span></div>
      <p data-connection class="muted"></p>
      <div class="companion-actions"><button data-mic></button><button data-camera></button><button data-chat>Chat</button><button data-return>Volver</button></div>
    </main>`;
    documentRef.querySelector('[data-mic]').onclick = () => actions.microphone?.();
    documentRef.querySelector('[data-camera]').onclick = () => actions.camera?.();
    documentRef.querySelector('[data-chat]').onclick = () => actions.chat?.();
    documentRef.querySelector('[data-return]').onclick = () => { window.focus(); actions.return?.(); };
    unsubscribe = model.subscribe((state) => render(documentRef, state));
  }

  async function open() {
    if ('documentPictureInPicture' in window) {
      pipWindow = await documentPictureInPicture.requestWindow({ width: 380, height: 280 });
      build(pipWindow.document);
      pipWindow.addEventListener('pagehide', () => { unsubscribe?.(); unsubscribe = null; pipWindow = null; button.setAttribute('aria-pressed', 'false'); }, { once: true });
      button.setAttribute('aria-pressed', 'true');
      return;
    }
    const video = document.querySelector('video');
    if (video && document.pictureInPictureEnabled && video.requestPictureInPicture) {
      await video.requestPictureInPicture();
      button.setAttribute('aria-pressed', 'true');
      return;
    }
    throw new Error('Tu navegador no admite un panel siempre encima. Mantén esta pestaña visible o usa un navegador compatible con Picture-in-Picture.');
  }

  button.addEventListener('click', async () => {
    try {
      if (pipWindow) pipWindow.close();
      else await open();
    } catch (error) { actions.unsupported?.(error.message); }
  });
  button.hidden = false;
  button.title = 'El modo siempre encima depende de la compatibilidad del navegador.';
  return { close() { if (pipWindow) pipWindow.close(); } };
}

function attachPinOnTop(button, sourceElement) {
  const model = RATCore.createFloatingModel({ title: 'Controles de reunión' });
  return attachCompanionWindow(button, model, {
    unsupported: (message) => {
      const status = document.createElement('p'); status.className = 'form-error'; status.setAttribute('role', 'alert'); status.textContent = message;
      sourceElement?.insertAdjacentElement('afterend', status);
    },
    return: () => sourceElement?.scrollIntoView(),
  });
}
