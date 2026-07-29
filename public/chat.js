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
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  const mountedRows = [];

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
    const role = document.createElement('span'); role.className = 'chat-role'; role.textContent = message.role || '';
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
        retry.addEventListener('click', () => { row.remove(); sendText(message.text, message.kind); }); row.appendChild(retry);
      }
    }
    container.appendChild(row); mountedRows.push(row); pruneRows(); container.scrollTop = container.scrollHeight;
    return row;
  }

  async function sendText(text, kind = 'chat') {
    const pending = { kind, type: 'text', text, role: options.role, sentAt: new Date().toISOString() };
    const row = render(options.displayName || myIdentity, pending, true, 'sending');
    try {
      const approved = await roomRequest('/api/chat/message', { method: 'POST', body: { text, kind } }, options.csrfToken);
      const message = { ...pending, ...approved.message };
      row.querySelector('.delivery-status').className = 'delivery-status sent';
      row.querySelector('.delivery-status').textContent = 'Enviado';
    } catch (error) {
      row.querySelector('.delivery-status').className = 'delivery-status failed';
      row.querySelector('.delivery-status').textContent = 'Falló';
      if (!row.querySelector('button')) {
        const retry = document.createElement('button'); retry.type = 'button'; retry.className = 'text-button'; retry.textContent = 'Reintentar'; retry.onclick = () => { row.remove(); sendText(text, kind); }; row.appendChild(retry);
      }
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
    const text = inputEl.value.trim();
    if (!text) return;
    inputEl.value = '';
    await sendText(text, kindEl?.value === 'question' ? 'question' : 'chat');
  }
  formEl?.addEventListener('submit', submit);

  if (emojiBtn && emojiPicker) {
    for (const emoji of EMOJI_SET) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = emoji; button.setAttribute('aria-label', `Insertar ${emoji}`);
      button.addEventListener('click', () => { inputEl.value += emoji; inputEl.focus(); }); emojiPicker.appendChild(button);
    }
    emojiBtn.addEventListener('click', () => { emojiPicker.hidden = !emojiPicker.hidden; });
  }

  if (fileBtn && fileInput) {
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', async () => {
      const file = fileInput.files[0]; fileInput.value = ''; if (!file) return;
      uploadStatus.textContent = `Subiendo ${file.name}…`;
      try {
        const formData = new FormData(); formData.append('file', file);
        const uploaded = await roomRequest('/api/chat/upload', { method: 'POST', body: formData }, options.csrfToken);
        const message = { kind: 'chat', type: 'file', role: options.role, sentAt: new Date().toISOString(), ...uploaded };
        render(options.displayName || myIdentity, message, true, 'sent'); uploadStatus.textContent = '';
      } catch (error) { uploadStatus.textContent = error.message; }
    });
  }

  return {
    dispose() { room.off(LivekitClient.RoomEvent.DataReceived, dataReceived); formEl?.removeEventListener('submit', submit); },
    sendSystem(message) { return roomRequest('/api/room/events', { method: 'POST', body: message }, options.csrfToken); },
  };
}

function broadcastRecordingStatus(room, active) {
  return Promise.resolve({ room, active });
}
