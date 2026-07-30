function makeDraggable(element, handle = element) {
  let drag = null;
  function move(event) {
    if (!drag) return;
    const left = Math.max(4, Math.min(innerWidth - element.offsetWidth - 4, drag.left + event.clientX - drag.x));
    const top = Math.max(4, Math.min(innerHeight - element.offsetHeight - 4, drag.top + event.clientY - drag.y));
    Object.assign(element.style, { left: `${left}px`, top: `${top}px`, right: 'auto', bottom: 'auto' });
  }
  function end() {
    drag = null;
    document.removeEventListener('pointermove', move);
    document.removeEventListener('pointerup', end);
  }
  handle.addEventListener('pointerdown', (event) => {
    if (event.target.closest('button, input, a, label')) return;
    const rect = element.getBoundingClientRect();
    drag = { x: event.clientX, y: event.clientY, left: rect.left, top: rect.top };
    document.addEventListener('pointermove', move);
    document.addEventListener('pointerup', end);
  });
}

function attachCompanionWindow(button, model, actions = {}) {
  if (!button) return { close() {}, open() {}, dispose() {}, supported: false };
  let pipWindow = null;
  let fallback = null;
  let unsubscribe = null;
  let disposed = false;
  let closeRequested = false;

  function elapsed(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function markup() {
    return `<main id="companionRoot" class="companion-window" aria-label="Controles flotantes de la reunión">
      <div class="companion-heading" data-drag-handle><img src="${location.origin}/assets/streaming-app-logo.png" alt="R.A. Training Streaming"><div><span class="companion-live" data-live></span><strong data-title></strong></div><button class="companion-close" data-close aria-label="Cerrar panel">×</button></div>
      <div class="companion-status"><span data-timer></span><span data-connection></span><span data-quality></span><span data-lock></span></div>
      <div class="companion-metrics"><span data-participants></span><span data-hands></span><span data-messages></span><span data-questions></span><span data-reaction hidden></span></div>
      <div class="companion-actions">
        <button data-mic></button><button data-camera></button><button data-screen></button><button data-chat>Chat</button>
        <button data-questions>Preguntas</button><button data-participants>Participantes</button><button data-hand>Mano</button><button data-more>Más</button>
        <button data-leave class="danger">Salir</button><button data-return>Volver a la reunión</button>
      </div>
    </main>`;
  }

  function render(documentRef, state) {
    const root = documentRef.getElementById('companionRoot');
    if (!root) return;
    root.querySelector('[data-live]').textContent = state.screen
      ? `● Compartiendo${state.recording ? ' · Grabando' : ''}`
      : state.recording ? '● Grabando' : state.live ? '● En vivo' : 'En espera';
    root.querySelector('[data-live]').classList.toggle('recording', state.recording);
    root.querySelector('[data-title]').textContent = state.title || 'Reunión';
    root.querySelector('[data-timer]').textContent = elapsed(state.elapsedSeconds);
    root.querySelector('[data-participants]').textContent = `${state.participants} participantes`;
    root.querySelector('[data-hands]').textContent = `${state.raisedHands} manos`;
    root.querySelector('[data-messages]').textContent = `${state.unreadMessages} mensajes`;
    root.querySelector('[data-questions]').textContent = `${state.pendingQuestions ?? state.unreadQuestions} preguntas pendientes`;
    const reaction = root.querySelector('[data-reaction]');
    reaction.hidden = !state.recentReaction;
    reaction.textContent = state.recentReaction ? `Reacción reciente ${state.recentReaction}` : '';
    root.querySelector('[data-connection]').textContent = RATCore.CONNECTION_STATES[state.connection] || state.connection;
    root.querySelector('[data-quality]').textContent = `Red: ${state.quality === 'poor' ? 'inestable' : state.quality === 'excellent' ? 'excelente' : state.quality === 'good' ? 'buena' : 'sin medir'}`;
    root.querySelector('[data-lock]').textContent = state.locked ? 'Sala bloqueada' : 'Sala abierta';
    const definitions = [
      ['mic', state.microphone, state.microphone ? 'Silenciar' : 'Activar micrófono'],
      ['camera', state.camera, state.camera ? 'Apagar cámara' : 'Activar cámara'],
      ['screen', state.screen, state.screen ? 'Detener pantalla' : 'Compartir pantalla'],
      ['hand', state.handRaised, state.role !== 'VIEWER' ? 'Ver manos' : state.handRaised ? 'Bajar mano' : 'Levantar mano'],
    ];
    for (const [name, active, label] of definitions) {
      const control = root.querySelector(`[data-${name}]`);
      control.setAttribute('aria-pressed', String(active));
      control.textContent = label;
    }
  }

  function bind(documentRef, { draggable = false } = {}) {
    const root = documentRef.getElementById('companionRoot');
    const mappings = {
      mic: 'microphone', camera: 'camera', screen: 'screen', chat: 'chat', questions: 'questions',
      participants: 'participants', hand: 'hand', more: 'more', leave: 'leave',
    };
    for (const [selector, action] of Object.entries(mappings)) root.querySelector(`[data-${selector}]`).onclick = () => actions[action]?.();
    root.querySelector('[data-return]').onclick = () => { window.focus(); actions.return?.(); };
    root.querySelector('[data-close]').onclick = close;
    if (draggable) makeDraggable(root, root.querySelector('[data-drag-handle]'));
    unsubscribe?.();
    unsubscribe = model.subscribe((state) => render(documentRef, state));
  }

  function showFallback() {
    if (fallback) {
      fallback.hidden = false;
      unsubscribe?.();
      unsubscribe = model.subscribe((state) => render(document, state));
      button.setAttribute('aria-pressed', 'true');
      return;
    }
    fallback = document.createElement('div');
    fallback.className = 'companion-fallback';
    fallback.innerHTML = markup();
    document.body.appendChild(fallback);
    bind(document, { draggable: true });
    button.setAttribute('aria-pressed', 'true');
    actions.fallback?.('El navegador no admite controles fuera de la pestaña; se abrió el panel flotante interno.');
  }

  async function open() {
    if (disposed) return;
    if (pipWindow) { pipWindow.focus(); return; }
    if ('documentPictureInPicture' in window && documentPictureInPicture.requestWindow) {
      closeRequested = false;
      const openedAt = Date.now();
      pipWindow = await documentPictureInPicture.requestWindow({ width: 430, height: 420 });
      pipWindow.document.head.innerHTML = `<meta charset="utf-8"><meta name="viewport" content="width=device-width"><link rel="stylesheet" href="${location.origin}/style.css">`;
      pipWindow.document.body.innerHTML = markup();
      bind(pipWindow.document);
      pipWindow.addEventListener('pagehide', () => {
        const failedImmediately = !closeRequested && Date.now() - openedAt < 1_000;
        unsubscribe?.();
        unsubscribe = null;
        pipWindow = null;
        button.setAttribute('aria-pressed', 'false');
        if (failedImmediately && !disposed) queueMicrotask(showFallback);
      }, { once: true });
      button.setAttribute('aria-pressed', 'true');
      return;
    }
    showFallback();
  }

  function close() {
    closeRequested = true;
    if (pipWindow) pipWindow.close();
    if (fallback) fallback.hidden = true;
    unsubscribe?.();
    unsubscribe = null;
    button.setAttribute('aria-pressed', 'false');
  }

  async function toggle() {
    try {
      if (pipWindow || (fallback && !fallback.hidden)) close(); else await open();
    } catch (error) {
      showFallback();
      actions.unsupported?.(error.message);
    }
  }

  button.onclick = toggle;
  button.hidden = false;
  button.title = 'Abre controles fuera de la página si el navegador admite Document Picture-in-Picture; en otros casos usa un panel interno.';
  return {
    open,
    close,
    supported: 'documentPictureInPicture' in window,
    dispose() {
      disposed = true;
      close();
      fallback?.remove();
      fallback = null;
      if (button.onclick === toggle) button.onclick = null;
    },
  };
}

function attachPinOnTop(button, sourceElement) {
  const model = RATCore.createFloatingModel({ title: 'Controles de reunión' });
  return attachCompanionWindow(button, model, {
    unsupported: (message) => {
      const status = document.createElement('p');
      status.className = 'form-error';
      status.setAttribute('role', 'alert');
      status.textContent = message;
      sourceElement?.insertAdjacentElement('afterend', status);
    },
    return: () => sourceElement?.scrollIntoView(),
  });
}
