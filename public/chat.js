const EMOJI_SET = ['😀', '😂', '😍', '🤔', '👏', '🙌', '🙏', '💪', '✅', '⚠️', '👋', '💡', '⭐'];

function setupChat(room, myIdentity, options = {}) {
  const messagesEl = document.getElementById('chatMessages');
  const questionsEl = document.getElementById('questionMessages');
  const formEl = document.getElementById('chatForm');
  const inputEl = document.getElementById('chatInput');
  const kindEl = document.getElementById('chatKind');
  const emojiBtn = document.getElementById('emojiBtn');
  const emojiPicker = document.getElementById('emojiPicker');
  const fileBtn = document.getElementById('fileBtn');
  const fileInput = document.getElementById('fileInput');
  const uploadStatus = document.getElementById('uploadStatus');
  const cancelUpload = document.getElementById('cancelUpload');
  const sendButton = document.getElementById('chatSendButton');
  const limitEl = document.getElementById('chatLimit');
  const errorEl = document.getElementById('chatError');
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const listenerController = new AbortController();
  const mountedRows = [];
  const drafts = { chat: '', question: '' };
  const history = [];
  const pinRoles = new Set(['HOST', 'TEACHER', 'COHOST']);
  const pins = { items: [], expanded: false };
  const canManagePins = pinRoles.has(String(options.role || '').toUpperCase());
  let sending = false;
  let uploadController = null;
  let historySequence = 0;

  function listen(target, type, handler) {
    target?.addEventListener(type, handler, { signal: listenerController.signal });
  }

  function emitHistory() {
    options.onHistoryChange?.(history.slice(-60).map((item) => ({ ...item })));
  }

  function addHistory(from, message, isMe, delivery) {
    const historyId = String(message.id || `chat-${Date.now()}-${historySequence += 1}`);
    history.push({
      id: historyId,
      from: from || 'Participante',
      role: message.role || 'VIEWER',
      text: message.type === 'file' ? `📎 ${message.filename || 'Archivo'}` : String(message.text || ''),
      sentAt: message.sentAt || new Date().toISOString(),
      isMe: isMe === true,
      delivery,
    });
    if (history.length > 60) history.splice(0, history.length - 60);
    emitHistory();
    return historyId;
  }

  function updateHistory(historyId, patch) {
    const item = history.find((entry) => entry.id === historyId);
    if (!item) return;
    Object.assign(item, patch);
    emitHistory();
  }

  function setDraft(kind, value) {
    const normalizedKind = kind === 'question' ? 'question' : 'chat';
    drafts[normalizedKind] = String(value || '').slice(0, normalizedKind === 'question' ? 600 : 2_000);
    if ((kindEl?.value === 'question' ? 'question' : 'chat') === normalizedKind) {
      inputEl.value = drafts[normalizedKind];
      resizeComposer();
    }
    options.onDraftChange?.(normalizedKind, drafts[normalizedKind]);
  }

  function resizeComposer() {
    inputEl.style.height = 'auto';
    inputEl.style.height = `${Math.min(inputEl.scrollHeight, 144)}px`;
    if (limitEl) {
      const count = inputEl.value.length;
      const limit = Number(inputEl.maxLength) || 2_000;
      limitEl.textContent = `${count}/${limit}`;
      limitEl.classList.toggle('near-limit', count >= limit * 0.9);
    }
  }

  function setSending(value) {
    sending = value;
    if (sendButton) {
      sendButton.disabled = value;
      sendButton.setAttribute('aria-busy', String(value));
      sendButton.textContent = value ? 'Enviando…' : 'Enviar';
    }
  }

  function formatSize(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function pruneRows() {
    while (mountedRows.length > 300) mountedRows.shift().remove();
  }

  function appendLinkifiedText(container, text) {
    const source = String(text || '');
    const pattern = /(?:https?:\/\/|www\.)[^\s<>"']+/gi;
    let cursor = 0;
    for (const match of source.matchAll(pattern)) {
      const raw = match[0];
      const index = match.index || 0;
      if (index > cursor) container.appendChild(document.createTextNode(source.slice(cursor, index)));
      const trimmed = raw.replace(/[.,;:!?)]*$/g, '');
      const suffix = raw.slice(trimmed.length);
      const normalized = trimmed.startsWith('www.') ? `https://${trimmed}` : trimmed;
      const safeUrl = RATCore.safeHttpUrl(normalized, location.origin);
      if (safeUrl) {
        const link = document.createElement('a');
        link.href = safeUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = trimmed;
        container.appendChild(link);
      } else {
        container.appendChild(document.createTextNode(trimmed));
      }
      if (suffix) container.appendChild(document.createTextNode(suffix));
      cursor = index + raw.length;
    }
    if (cursor < source.length) container.appendChild(document.createTextNode(source.slice(cursor)));
  }

  function updatePinBadges() {
    const count = pins.items.length;
    const text = count ? `📌${count}` : '';
    for (const [id, hostId] of [['chatPinBadge', 'btnChat'], ['chatTabPinBadge', null]]) {
      let badge = document.getElementById(id);
      const host = hostId ? document.getElementById(hostId) : document.querySelector('[data-room-tab="chat"]');
      if (!host) continue;
      if (!badge) {
        badge = document.createElement('span');
        badge.id = id;
        badge.className = 'chat-pin-badge';
        badge.setAttribute('aria-label', 'Mensajes fijados');
        host.appendChild(badge);
      }
      badge.hidden = count === 0;
      badge.textContent = text;
    }
  }

  const pinnedRoot = document.createElement('section');
  pinnedRoot.className = 'chat-pinned-root';
  pinnedRoot.hidden = true;
  const pinnedSummary = document.createElement('button');
  pinnedSummary.type = 'button';
  pinnedSummary.className = 'chat-pinned-summary';
  const pinnedPanel = document.createElement('div');
  pinnedPanel.className = 'chat-pinned-panel';
  pinnedPanel.hidden = true;
  pinnedRoot.append(pinnedSummary, pinnedPanel);
  messagesEl.parentNode?.insertBefore(pinnedRoot, messagesEl);

  function renderPins() {
    const count = pins.items.length;
    pinnedRoot.hidden = count === 0;
    pinnedSummary.textContent = count === 1 ? '📌 1 mensaje fijado · Ver' : `📌 ${count} mensajes fijados · Ver`;
    pinnedSummary.setAttribute('aria-expanded', String(pins.expanded));
    pinnedPanel.hidden = !pins.expanded || count === 0;
    pinnedPanel.replaceChildren();
    if (count) {
      const header = document.createElement('div');
      header.className = 'chat-pinned-panel-header';
      const title = document.createElement('strong'); title.textContent = '📌 Mensajes fijados';
      const close = document.createElement('button'); close.type = 'button'; close.className = 'text-button'; close.textContent = '×'; close.setAttribute('aria-label', 'Contraer mensajes fijados');
      listen(close, 'click', () => { pins.expanded = false; renderPins(); });
      header.append(title, close); pinnedPanel.appendChild(header);
      for (const pin of pins.items) {
        const item = document.createElement('article');
        item.className = 'chat-pinned-item';
        const meta = document.createElement('small');
        meta.textContent = pin.authorName ? `${pin.authorName} · ${RATCore.roleLabel(pin.authorRole)}` : 'Mensaje fijado';
        const text = document.createElement('p');
        appendLinkifiedText(text, pin.text);
        item.append(meta, text);
        if (canManagePins) {
          const unpin = document.createElement('button');
          unpin.type = 'button';
          unpin.className = 'text-button chat-pin-action';
          unpin.textContent = 'Desfijar';
          listen(unpin, 'click', async () => {
            unpin.disabled = true;
            try { await roomRequest(`/api/chat/pins/${encodeURIComponent(pin.id)}`, { method: 'DELETE' }, options.csrfToken); await loadPins(); }
            catch (error) { if (errorEl) errorEl.textContent = error.message || 'No fue posible desfijar el mensaje.'; unpin.disabled = false; }
          });
          item.appendChild(unpin);
        }
        pinnedPanel.appendChild(item);
      }
    }
    updatePinBadges();
  }

  async function loadPins() {
    const result = await roomRequest('/api/chat/pins', { method: 'GET' }, options.csrfToken);
    pins.items = Array.isArray(result.pins) ? result.pins : [];
    if (!pins.items.length) pins.expanded = false;
    renderPins();
  }

  function appendPinAction(row, from, message) {
    if (!canManagePins || message.kind !== 'chat' || message.type === 'file') return;
    const text = String(message.text || '').trim();
    if (!text) return;
    const action = document.createElement('button');
    action.type = 'button';
    action.className = 'text-button chat-pin-action';
    action.textContent = '📌 Fijar';
    listen(action, 'click', async () => {
      action.disabled = true;
      try {
        await roomRequest('/api/chat/pins', {
          method: 'POST',
          body: { text, authorName: from || 'Participante', authorRole: message.role || 'ATTENDEE', sentAt: message.sentAt },
        }, options.csrfToken);
        pins.expanded = true;
        await loadPins();
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message || 'No fue posible fijar el mensaje.';
        action.disabled = false;
      }
    });
    row.appendChild(action);
  }

  function render(from, message, isMe, delivery = 'sent') {
    const container = message.kind === 'question' && questionsEl ? questionsEl : messagesEl;
    const row = document.createElement('article');
    row.className = `chat-msg ${message.type === 'file' ? 'file' : ''}`;
    row.dataset.historyId = addHistory(from, message, isMe, delivery);
    const header = document.createElement('div'); header.className = 'chat-msg-header';
    const who = document.createElement('strong'); who.className = isMe ? 'who me' : 'who'; who.textContent = from || 'Participante';
    const role = document.createElement('span'); role.className = 'chat-role'; role.textContent = RATCore.roleLabel(message.role);
    const time = document.createElement('time'); time.dateTime = message.sentAt || new Date().toISOString(); time.textContent = new Date(time.dateTime).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' });
    header.append(who, role, time); row.appendChild(header);

    if (message.type === 'file') {
      const safeUrl = RATCore.safeHttpUrl(message.url, location.origin);
      if (safeUrl && message.mimetype?.startsWith('image/')) {
        const image = document.createElement('img'); image.className = 'file-preview'; image.src = safeUrl; image.alt = message.filename || 'Imagen compartida'; image.loading = 'lazy'; row.appendChild(image);
      }
      if (safeUrl) {
        const link = document.createElement('a'); link.className = 'file-link'; link.href = safeUrl; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = `${message.filename || 'Archivo'} (${formatSize(message.size || 0)})`; row.appendChild(link);
      } else row.appendChild(document.createTextNode('Archivo no disponible'));
    } else {
      const body = document.createElement('p'); appendLinkifiedText(body, message.text); row.appendChild(body);
    }
    if (delivery !== 'sending') appendPinAction(row, from, message);

    if (isMe) {
      const status = document.createElement('span'); status.className = `delivery-status ${delivery}`; status.textContent = delivery === 'failed' ? 'Falló' : delivery === 'sending' ? 'Enviando…' : 'Enviado'; row.appendChild(status);
      if (delivery === 'failed' && message.type !== 'file') {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = 'Reintentar';
        listen(retry, 'click', async () => { retry.disabled = true; row.remove(); await sendText(message.text, message.kind); }); row.appendChild(retry);
      }
    }
    container.appendChild(row); mountedRows.push(row); pruneRows(); container.scrollTop = container.scrollHeight;
    return row;
  }

  async function sendText(text, kind = 'chat') {
    if (kind === 'question' && typeof options.sendQuestion === 'function') {
      try {
        await options.sendQuestion(text);
        return true;
      } catch (error) {
        if (errorEl) errorEl.textContent = error.message || 'No fue posible enviar la pregunta.';
        return false;
      }
    }
    const pending = { kind, type: 'text', text, role: options.role, sentAt: new Date().toISOString() };
    const row = render(options.displayName || myIdentity, pending, true, 'sending');
    try {
      const approved = await roomRequest('/api/chat/message', { method: 'POST', body: { text, kind } }, options.csrfToken);
      const message = { ...pending, ...approved.message };
      row.querySelector('.delivery-status').className = 'delivery-status sent';
      row.querySelector('.delivery-status').textContent = 'Enviado';
      updateHistory(row.dataset.historyId, { delivery: 'sent', sentAt: message.sentAt || pending.sentAt });
      appendPinAction(row, options.displayName || myIdentity, message);
      return true;
    } catch (error) {
      row.querySelector('.delivery-status').className = 'delivery-status failed';
      row.querySelector('.delivery-status').textContent = 'Falló';
      updateHistory(row.dataset.historyId, { delivery: 'failed' });
      if (!row.querySelector('button')) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = 'Reintentar'; retry.onclick = async () => { retry.disabled = true; row.remove(); await sendText(text, kind); }; row.appendChild(retry);
      }
      if (errorEl) errorEl.textContent = error.message || 'No fue posible enviar el mensaje.';
      return false;
    }
  }

  function dataReceived(payload, participant) {
    try {
      const message = JSON.parse(decoder.decode(payload));
      if (message.kind === 'chat-pins-changed') { loadPins().catch(() => {}); return; }
      if (!['chat', 'question'].includes(message.kind)) return;
      if (typeof message.text === 'string' && message.text.length > 2_000) return;
      render(message.from || participant?.name || participant?.identity || 'Participante', message, false);
      playAlert('message');
      options.onMessage?.(participant, message);
      systemNotification(message.kind === 'question' ? 'Nueva pregunta' : 'Nuevo mensaje', `${participant?.name || 'Participante'}: ${String(message.text || message.filename || '').slice(0, 120)}`);
    } catch (error) { console.warn('Mensaje de datos descartado', error); }
  }
  room.on(LivekitClient.RoomEvent.DataReceived, dataReceived);
  listen(pinnedSummary, 'click', () => { pins.expanded = !pins.expanded; renderPins(); });
  loadPins().catch(() => {});

  async function submit(event) {
    event.preventDefault();
    if (sending || event.isComposing) return;
    const text = inputEl.value.trim();
    if (!text) return;
    const kind = kindEl?.value === 'question' ? 'question' : 'chat';
    const limit = kind === 'question' ? 600 : 2_000;
    if (text.length > limit) {
      if (errorEl) errorEl.textContent = `El ${kind === 'question' ? 'texto de la pregunta' : 'mensaje'} supera el límite de ${limit} caracteres.`;
      return;
    }
    if (errorEl) errorEl.textContent = '';
    setSending(true);
    inputEl.value = '';
    drafts[kind] = '';
    options.onDraftChange?.(kind, '');
    resizeComposer();
    const sent = await sendText(text, kind);
    if (!sent && !inputEl.value) {
      inputEl.value = text;
      drafts[kind] = text;
      options.onDraftChange?.(kind, text);
    }
    resizeComposer();
    setSending(false);
  }
  listen(formEl, 'submit', submit);
  listen(inputEl, 'keydown', (event) => {
    if (!RATCore.shouldSubmitChat(event)) return;
    event.preventDefault();
    formEl.requestSubmit();
  });
  listen(inputEl, 'input', () => {
    drafts[kindEl?.value === 'question' ? 'question' : 'chat'] = inputEl.value;
    options.onDraftChange?.(kindEl?.value === 'question' ? 'question' : 'chat', inputEl.value);
    if (errorEl) errorEl.textContent = '';
    resizeComposer();
  });
  listen(kindEl, 'change', (event) => {
    const previous = event.target.value === 'question' ? 'chat' : 'question';
    drafts[previous] = inputEl.value;
    options.onDraftChange?.(previous, inputEl.value);
    inputEl.value = drafts[event.target.value] || '';
    inputEl.maxLength = event.target.value === 'question' ? 600 : 2000;
    inputEl.placeholder = event.target.value === 'question' ? 'Escribe una pregunta para la sesión…' : 'Escribe un mensaje…';
    if (limitEl) limitEl.textContent = `${inputEl.value.length}/${inputEl.maxLength}`;
    resizeComposer();
  });
  resizeComposer();

  if (emojiBtn && emojiPicker) {
    emojiPicker.replaceChildren();
    for (const emoji of EMOJI_SET) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = emoji; button.setAttribute('aria-label', `Insertar ${emoji}`);
      listen(button, 'click', () => { inputEl.value += emoji; inputEl.dispatchEvent(new Event('input')); inputEl.focus(); }); emojiPicker.appendChild(button);
    }
    listen(emojiBtn, 'click', () => { emojiPicker.hidden = !emojiPicker.hidden; });
  }

  if (fileBtn && fileInput) {
    listen(fileBtn, 'click', () => fileInput.click());
    listen(fileInput, 'change', async () => {
      const file = fileInput.files[0]; fileInput.value = ''; if (!file) return;
      const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain']);
      if (file.size > 10 * 1024 * 1024 || !allowedTypes.has(file.type)) {
        uploadStatus.textContent = 'El archivo debe ser JPG, PNG, WebP, PDF o TXT y pesar hasta 10 MB.';
        return;
      }
      uploadController = new AbortController();
      cancelUpload.hidden = false;
      fileBtn.disabled = true;
      uploadStatus.textContent = `Subiendo ${file.name}…`;
      uploadStatus.setAttribute('role', 'progressbar');
      uploadStatus.setAttribute('aria-valuetext', `Subiendo ${file.name}`);
      try {
        const formData = new FormData(); formData.append('file', file);
        const uploaded = await roomRequest('/api/chat/upload', { method: 'POST', body: formData, signal: uploadController.signal }, options.csrfToken);
        const message = { kind: 'chat', type: 'file', role: options.role, sentAt: new Date().toISOString(), ...uploaded };
        render(options.displayName || myIdentity, message, true, 'sent'); uploadStatus.textContent = 'Archivo enviado.';
      } catch (error) { uploadStatus.textContent = error.name === 'AbortError' ? 'Carga cancelada.' : error.message; }
      finally { uploadController = null; cancelUpload.hidden = true; fileBtn.disabled = false; uploadStatus.removeAttribute('role'); uploadStatus.removeAttribute('aria-valuetext'); }
    });
    listen(cancelUpload, 'click', () => uploadController?.abort());
  }

  return {
    dispose() {
      uploadController?.abort();
      listenerController.abort();
      room.off(LivekitClient.RoomEvent.DataReceived, dataReceived);
      emojiPicker?.replaceChildren();
      pinnedRoot.remove();
    },
    getDraft(kind = 'chat') { return drafts[kind === 'question' ? 'question' : 'chat'] || ''; },
    setDraft,
    sendText,
    sendSystem(message) { return roomRequest('/api/room/events', { method: 'POST', body: message }, options.csrfToken); },
  };
}
