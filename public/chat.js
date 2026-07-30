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
  const mountedRows = [];
  const drafts = { chat: '', question: '' };
  let sending = false;
  let uploadController = null;

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

  function render(from, message, isMe, delivery = 'sent') {
    const container = message.kind === 'question' && questionsEl ? questionsEl : messagesEl;
    const row = document.createElement('article');
    row.className = `chat-msg ${message.type === 'file' ? 'file' : ''}`;
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
      const body = document.createElement('p'); body.textContent = String(message.text || ''); row.appendChild(body);
    }

    if (isMe) {
      const status = document.createElement('span'); status.className = `delivery-status ${delivery}`; status.textContent = delivery === 'failed' ? 'Falló' : delivery === 'sending' ? 'Enviando…' : 'Enviado'; row.appendChild(status);
      if (delivery === 'failed' && message.type !== 'file') {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = 'Reintentar';
        retry.addEventListener('click', async () => { retry.disabled = true; row.remove(); await sendText(message.text, message.kind); }); row.appendChild(retry);
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
      return true;
    } catch (error) {
      row.querySelector('.delivery-status').className = 'delivery-status failed';
      row.querySelector('.delivery-status').textContent = 'Falló';
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
      if (!['chat', 'question'].includes(message.kind)) return;
      if (typeof message.text === 'string' && message.text.length > 2_000) return;
      render(message.from || participant?.name || participant?.identity || 'Participante', message, false);
      playAlert('message');
      options.onMessage?.(participant, message);
      systemNotification(message.kind === 'question' ? 'Nueva pregunta' : 'Nuevo mensaje', `${participant?.name || 'Participante'}: ${String(message.text || message.filename || '').slice(0, 120)}`);
    } catch (error) { console.warn('Mensaje de datos descartado', error); }
  }
  room.on(LivekitClient.RoomEvent.DataReceived, dataReceived);

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
    resizeComposer();
    const sent = await sendText(text, kind);
    if (!sent && !inputEl.value) inputEl.value = text;
    resizeComposer();
    setSending(false);
  }
  formEl?.addEventListener('submit', submit);
  inputEl?.addEventListener('keydown', (event) => {
    if (!RATCore.shouldSubmitChat(event)) return;
    event.preventDefault();
    formEl.requestSubmit();
  });
  inputEl?.addEventListener('input', () => {
    drafts[kindEl?.value === 'question' ? 'question' : 'chat'] = inputEl.value;
    if (errorEl) errorEl.textContent = '';
    resizeComposer();
  });
  kindEl?.addEventListener('change', (event) => {
    const previous = event.target.value === 'question' ? 'chat' : 'question';
    drafts[previous] = inputEl.value;
    inputEl.value = drafts[event.target.value] || '';
    inputEl.maxLength = event.target.value === 'question' ? 600 : 2000;
    inputEl.placeholder = event.target.value === 'question' ? 'Escribe una pregunta para la sesión…' : 'Escribe un mensaje…';
    if (limitEl) limitEl.textContent = `${inputEl.value.length}/${inputEl.maxLength}`;
    resizeComposer();
  });
  resizeComposer();

  if (emojiBtn && emojiPicker) {
    for (const emoji of EMOJI_SET) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = emoji; button.setAttribute('aria-label', `Insertar ${emoji}`);
      button.addEventListener('click', () => { inputEl.value += emoji; inputEl.dispatchEvent(new Event('input')); inputEl.focus(); }); emojiPicker.appendChild(button);
    }
    emojiBtn.addEventListener('click', () => { emojiPicker.hidden = !emojiPicker.hidden; });
  }

  if (fileBtn && fileInput) {
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
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
    cancelUpload?.addEventListener('click', () => uploadController?.abort());
  }

  return {
    dispose() { uploadController?.abort(); room.off(LivekitClient.RoomEvent.DataReceived, dataReceived); formEl?.removeEventListener('submit', submit); },
    sendSystem(message) { return roomRequest('/api/room/events', { method: 'POST', body: message }, options.csrfToken); },
  };
}
