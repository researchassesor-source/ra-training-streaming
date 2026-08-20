renderBrand(document.getElementById('brand'), { tagline: false });
const list = document.getElementById('recordingList');
const page = { csrf: '' };
const TRANSCRIPT_STATUS = {
  PENDING: 'Preparando transcripci\u00f3n', VALIDATING: 'Preparando transcripci\u00f3n', FETCHING_RECORDING: 'Preparando transcripci\u00f3n',
  SUBMITTING: 'Transcripci\u00f3n en proceso', PROCESSING: 'Transcripci\u00f3n en proceso', QUEUED: 'Preparando transcripci\u00f3n',
  PROCESSING_AUDIO: 'Transcripci\u00f3n en proceso', IDENTIFYING_PARTICIPANTS: 'Transcripci\u00f3n en proceso', GENERATING_TRANSCRIPT: 'Transcripci\u00f3n en proceso',
  COMPLETED: 'Transcripci\u00f3n completada', COMPLETED_WITH_WARNINGS: 'Transcripci\u00f3n completada con advertencias', FAILED: 'No se pudo transcribir', CANCELLED: 'Transcripci\u00f3n cancelada',
};

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = page.csrf;
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  if (response.status === 401) { window.location.replace('/index.html'); throw new Error('La sesi\u00f3n expir\u00f3.'); }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'No fue posible completar la solicitud.'); error.code = data.code; throw error; }
  return data;
}

function transcriptAction(item) {
  if (item.transcript) {
    const action = document.createElement('a'); action.className = 'button primary'; action.href = `/transcription.html?id=${encodeURIComponent(item.transcript.id)}`;
    action.textContent = ['FAILED', 'CANCELLED'].includes(item.transcript.status) ? 'Revisar y reintentar' : ['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(item.transcript.status) ? 'Ver transcripci\u00f3n' : 'Ver proceso';
    return action;
  }
  if (!item.transcriptionAllowed || !item.meetingId) return null;
  const action = document.createElement('button'); action.className = 'primary'; action.type = 'button'; action.textContent = 'Transcribir';
  action.addEventListener('click', async () => {
    action.disabled = true; action.textContent = 'Preparando\u2026';
    try {
      const data = await api(`/api/meetings/${encodeURIComponent(item.meetingId)}/transcriptions`, { method: 'POST', body: { recordingId: item.id, language: 'es' } });
      window.location.href = `/transcription.html?id=${encodeURIComponent(data.transcript.id)}`;
    } catch (error) {
      action.disabled = false; action.textContent = 'Reintentar';
      const message = document.createElement('p'); message.className = 'form-error'; message.textContent = error.message; action.parentElement?.appendChild(message);
    }
  });
  return action;
}

async function loadRecordings() {
  list.textContent = 'Cargando\u2026';
  const room = document.getElementById('roomFilter').value.trim();
  try {
    const data = await api(`/api/recordings${room ? `?room=${encodeURIComponent(room)}` : ''}`);
    list.replaceChildren();
    if (!data.items.length) {
      list.className = 'empty-state branded-empty'; const image = document.createElement('img'); image.src = 'assets/icon-192.png'; image.alt = 'Icono de R.A. Training Streaming'; const message = document.createElement('strong'); message.textContent = 'No hay grabaciones disponibles.'; list.append(image, message); return;
    }
    list.className = 'recordings-list';
    for (const item of data.items) {
      const card = document.createElement('article'); card.className = 'recording-card';
      const info = document.createElement('div');
      const title = document.createElement('h2'); title.textContent = item.title;
      const date = new Date(item.lastModified); const safeDate = Number.isNaN(date.getTime()) ? 'Fecha por definir' : date.toLocaleString('es-EC');
      const meta = document.createElement('p'); meta.className = 'muted'; meta.textContent = `${item.trainerName || 'Capacitador por definir'} \u00b7 ${safeDate} \u00b7 ${(Number(item.size || 0) / 1024 / 1024).toFixed(1)} MB`;
      info.append(title, meta);
      if (item.transcript) { const state = document.createElement('p'); state.className = 'small transcript-recording-state'; state.textContent = TRANSCRIPT_STATUS[item.transcript.status] || 'Estado de transcripci\u00f3n no disponible'; info.appendChild(state); }
      const actions = document.createElement('div'); actions.className = 'meeting-actions';
      if (item.key) {
        const open = document.createElement('button'); open.className = 'secondary'; open.type = 'button'; open.textContent = 'Abrir';
        open.addEventListener('click', async () => {
          open.disabled = true;
          const target = window.open('', '_blank', 'noopener,noreferrer');
          try {
            const signed = await api(`/api/recordings/download?key=${encodeURIComponent(item.key)}`);
            if (target) target.location.href = signed.url;
            else window.location.href = signed.url;
          } catch (error) {
            if (target) target.close();
            open.textContent = 'Reintentar';
          }
          finally { open.disabled = false; }
        });
        actions.appendChild(open);
      }
      const transcript = transcriptAction(item); if (transcript) actions.appendChild(transcript);
      card.append(info, actions); list.appendChild(card);
    }
  } catch (error) {
    list.replaceChildren(); list.className = error.code === 'STORAGE_NOT_CONFIGURED' ? 'empty-state branded-empty' : 'form-error';
    if (error.code === 'STORAGE_NOT_CONFIGURED') {
      const image = document.createElement('img'); image.src = 'assets/icon-192.png'; image.alt = 'Icono de R.A. Training Streaming'; const title = document.createElement('strong'); title.textContent = 'Las grabaciones no est\u00e1n disponibles en este entorno.'; const detail = document.createElement('span'); detail.textContent = 'Revisa el estado de almacenamiento y grabaci\u00f3n en Configuraci\u00f3n.'; const actions = document.createElement('div'); actions.className = 'dialog-actions'; const settings = document.createElement('a'); settings.href = '/dashboard.html#settings'; settings.className = 'button secondary compact'; settings.textContent = 'Ver configuraci\u00f3n'; const guide = document.createElement('a'); guide.href = '/docs/LOCAL_DEVELOPMENT.md'; guide.className = 'button secondary compact'; guide.textContent = 'Consultar gu\u00eda'; guide.target = '_blank'; guide.rel = 'noopener'; actions.append(settings, guide); list.append(image, title, detail, actions);
    } else list.textContent = error.message;
  }
}

document.getElementById('searchButton').addEventListener('click', loadRecordings);
(async function initialize() {
  try { const session = await api('/api/auth/me'); page.csrf = session.csrfToken; await loadRecordings(); }
  catch (error) { list.textContent = error.message; list.className = 'form-error'; }
}());
