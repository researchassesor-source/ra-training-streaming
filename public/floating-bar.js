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
  let mode = 'compact';

  const icons = {
    microphone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm-7-3a7 7 0 0 0 14 0h-2a5 5 0 0 1-10 0H5Zm6 7v3h2v-3h-2Z"/></svg>',
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h12a2 2 0 0 1 2 2v1l4-2v10l-4-2v1a2 2 0 0 1-2 2H3V6Zm2 2v8h10V8H5Z"/></svg>',
    screen: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v13H3V4Zm2 2v9h14V6H5Zm4 13h6v2H9v-2Z"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4h18v14H8l-5 3V4Zm2 2v11.5L7.5 16H19V6H5Z"/></svg>',
    hand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V5a2 2 0 0 1 4 0v4-6a2 2 0 0 1 4 0v6-4a2 2 0 0 1 4 0v8c0 5-3 8-8 8-4 0-6-2-8-5l-2-3a2 2 0 0 1 3-2l3 2v-2Z"/></svg>',
    participants: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-1a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM2 21v-3c0-3 3-5 7-5s7 2 7 5v3H2Zm15-8c3 .3 5 2 5 5v3h-4v-3c0-2-.5-3.6-1-5Z"/></svg>',
    more: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    return: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m10 5 1.4 1.4L7.8 10H21v2H7.8l3.6 3.6L10 17l-6-6 6-6Z"/></svg>',
    expand: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h7v2H6v5H4V4Zm9 0h7v7h-2V6h-5V4ZM4 13h2v5h5v2H4v-7Zm14 0h2v7h-7v-2h5v-5Z"/></svg>',
  };

  function elapsed(seconds) {
    const total = Math.max(0, Number(seconds) || 0);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    return `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }

  function markup() {
    return `<main id="companionRoot" class="companion-window" data-mode="${mode}" aria-label="Controles flotantes de la reunión">
      <div class="companion-compact" data-drag-handle>
        <img src="${location.origin}/assets/streaming-app-logo.png" alt=""><span class="companion-live" data-live></span><strong data-timer></strong>
        <div class="companion-compact-actions">
          <button data-mic>${icons.microphone}</button><button data-camera>${icons.camera}</button><button data-screen>${icons.screen}</button>
          <button data-chat>${icons.chat}<span class="companion-count" data-chat-count></span></button>
          <button data-hand>${icons.hand}<span class="companion-count" data-hand-count></span></button>
          <button data-participants>${icons.participants}</button><button data-more>${icons.more}</button><button data-return>${icons.return}</button>
          <button data-expand>${icons.expand}</button><button class="companion-close" data-close aria-label="Cerrar panel">×</button>
        </div>
      </div>
      <section class="companion-expanded" hidden>
        <div class="companion-heading"><img src="${location.origin}/assets/streaming-app-logo.png" alt="R.A. Training Streaming"><div><span class="companion-live" data-live></span><strong data-title></strong></div><button data-expand>Compactar</button><button class="companion-close" data-close aria-label="Cerrar panel">×</button></div>
        <div class="companion-status"><span data-timer></span><span data-connection></span><span data-quality></span><span data-lock></span></div>
        <div class="companion-metrics"><span data-participant-count></span><span data-hand-total></span><span data-message-total></span><span data-question-total></span><span data-reaction hidden></span></div>
        <div class="companion-actions"><button data-mic><span data-label></span></button><button data-camera><span data-label></span></button><button data-screen><span data-label></span></button><button data-chat>Chat</button><button data-questions>Preguntas</button><button data-participants>Participantes</button><button data-hand><span data-label></span></button><button data-more>Más</button><button data-leave class="danger">Salir</button><button data-return>Volver</button></div>
      </section>
    </main>`;
  }

  function render(documentRef, state) {
    const root = documentRef.getElementById('companionRoot');
    if (!root) return;
    root.querySelectorAll('[data-live]').forEach((element) => { element.textContent = state.screen
      ? `● Compartiendo${state.recording ? ' · Grabando' : ''}`
      : state.recording ? '● Grabando' : state.live ? '● En vivo' : 'En espera'; element.classList.toggle('recording', state.recording); });
    root.querySelector('[data-title]').textContent = state.title || 'Reunión';
    root.querySelectorAll('[data-timer]').forEach((element) => { element.textContent = elapsed(state.elapsedSeconds); });
    root.querySelector('[data-participant-count]').textContent = `${state.participants} participantes`;
    root.querySelector('[data-hand-total]').textContent = `${state.raisedHands} manos`;
    root.querySelector('[data-message-total]').textContent = `${state.unreadMessages} mensajes`;
    root.querySelector('[data-question-total]').textContent = `${state.pendingQuestions ?? state.unreadQuestions} preguntas pendientes`;
    root.querySelector('[data-chat-count]').textContent = state.unreadMessages || '';
    root.querySelector('[data-hand-count]').textContent = state.raisedHands || '';
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
      root.querySelectorAll(`[data-${name}]`).forEach((control) => {
        control.setAttribute('aria-pressed', String(active));
        control.setAttribute('aria-label', label);
        control.title = label;
        const text = control.querySelector('[data-label]');
        if (text) text.textContent = label;
      });
    }
    for (const [selector, label] of [['chat', 'Abrir Chat'], ['participants', 'Abrir Participantes'], ['more', 'Más opciones'], ['return', 'Volver a la reunión'], ['expand', mode === 'compact' ? 'Expandir panel' : 'Volver a compacto']]) root.querySelectorAll(`[data-${selector}]`).forEach((control) => { control.setAttribute('aria-label', label); control.title = label; });
  }

  function applyMode(documentRef, nextMode) {
    mode = nextMode === 'expanded' ? 'expanded' : 'compact';
    const root = documentRef.getElementById('companionRoot');
    if (!root) return;
    root.dataset.mode = mode;
    root.querySelector('.companion-compact').hidden = mode !== 'compact';
    root.querySelector('.companion-expanded').hidden = mode !== 'expanded';
    if (pipWindow && documentRef === pipWindow.document) {
      try { pipWindow.resizeTo?.(mode === 'compact' ? 760 : 460, mode === 'compact' ? 110 : 460); } catch { /* The initial PiP resize can require a separate user gesture. */ }
    }
  }

  function bind(documentRef, { draggable = false } = {}) {
    const root = documentRef.getElementById('companionRoot');
    const mappings = {
      mic: 'microphone', camera: 'camera', screen: 'screen', chat: 'chat', questions: 'questions',
      participants: 'participants', hand: 'hand', more: 'more', leave: 'leave',
    };
    for (const [selector, action] of Object.entries(mappings)) root.querySelectorAll(`[data-${selector}]`).forEach((control) => { control.onclick = () => actions[action]?.(); });
    root.querySelectorAll('[data-return]').forEach((control) => { control.onclick = () => { window.focus(); actions.return?.(); }; });
    root.querySelectorAll('[data-close]').forEach((control) => { control.onclick = close; });
    root.querySelectorAll('[data-expand]').forEach((control) => { control.onclick = () => { applyMode(documentRef, mode === 'compact' ? 'expanded' : 'compact'); render(documentRef, model.snapshot?.() || {}); }; });
    if (draggable) makeDraggable(root, root.querySelector('[data-drag-handle]'));
    applyMode(documentRef, mode);
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
      pipWindow = await documentPictureInPicture.requestWindow({ width: mode === 'compact' ? 760 : 460, height: mode === 'compact' ? 110 : 460 });
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
