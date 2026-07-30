renderBrand(document.getElementById('brand'), { tagline: false });

const transcriptId = new URLSearchParams(location.search).get('id');
const page = { user: null, csrf: '', transcript: null, meeting: null, recording: null, editing: false, dirty: false, pollTimer: null };
const STATUS_LABELS = {
  NOT_AVAILABLE: 'No disponible', READY: 'Lista para transcribir', QUEUED: 'En cola', PROCESSING_AUDIO: 'Procesando audio',
  IDENTIFYING_PARTICIPANTS: 'Identificando participantes', GENERATING_TRANSCRIPT: 'Generando transcripción', COMPLETED: 'Completada',
  COMPLETED_WITH_WARNINGS: 'Completada con advertencias', FAILED: 'Falló', CANCELLED: 'Cancelada',
};
const TERMINAL = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED']);
const COMPLETE = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS']);

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = page.csrf;
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { location.replace('/index.html'); throw new Error('La sesión expiró.'); }
  if (!response.ok) throw new Error(data.error || 'No fue posible completar la solicitud.');
  return data;
}

function notice(message, error = false) {
  const element = document.getElementById('transcriptNotice'); element.hidden = false; element.className = `notice ${error ? 'error' : 'success'}`; element.textContent = message;
}

function timestamp(ms) {
  const total = Math.max(0, Math.trunc(Number(ms) || 0));
  return `${String(Math.floor(total / 3_600_000)).padStart(2, '0')}:${String(Math.floor((total % 3_600_000) / 60_000)).padStart(2, '0')}:${String(Math.floor((total % 60_000) / 1_000)).padStart(2, '0')}`;
}

function setDirty(value) {
  page.dirty = value;
  document.getElementById('unsavedBadge').hidden = !value;
  document.getElementById('saveTranscript').disabled = !value;
}

function askConfirmation(title, message, confirmLabel) {
  const dialog = document.getElementById('transcriptConfirmDialog');
  dialog.querySelector('[data-confirm-title]').textContent = title;
  dialog.querySelector('[data-confirm-message]').textContent = message;
  const accept = dialog.querySelector('[data-confirm-accept]'); accept.textContent = confirmLabel;
  return new Promise((resolve) => {
    const close = () => { dialog.removeEventListener('close', close); resolve(dialog.returnValue === 'confirm'); };
    dialog.addEventListener('close', close); dialog.showModal(); accept.focus();
  });
}

function filteredSegments() {
  const query = document.getElementById('transcriptSearch').value.trim().toLowerCase();
  const speaker = document.getElementById('speakerFilter').value;
  return (page.transcript?.segments || []).filter((segment) => (!query || `${segment.participantName} ${segment.text}`.toLowerCase().includes(query)) && (!speaker || (segment.participantIdentity || segment.participantName) === speaker));
}

function renderSegments() {
  const container = document.getElementById('transcriptSegments'); container.replaceChildren();
  const segments = filteredSegments();
  if (!segments.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state branded-empty';
    const image = document.createElement('img'); image.src = 'assets/icon-192.png'; image.alt = 'Icono de R.A. Training Streaming';
    const message = document.createElement('strong'); message.textContent = COMPLETE.has(page.transcript?.status) ? 'No hay intervenciones que coincidan con la búsqueda.' : 'La transcripción todavía no contiene intervenciones.';
    empty.append(image, message); container.appendChild(empty); return;
  }
  for (const segment of segments) {
    const article = document.createElement('article'); article.className = 'transcript-segment'; article.dataset.segmentId = segment.id;
    const header = document.createElement('div'); header.className = 'segment-heading';
    const seek = document.createElement('button'); seek.type = 'button'; seek.className = 'timestamp-button'; seek.textContent = timestamp(segment.startMs); seek.title = 'Ir a este momento de la grabación'; seek.onclick = () => {
      const link = document.getElementById('openRecording'); if (!page.recording?.url) return notice('La grabación no está disponible.', true);
      link.href = `${page.recording.url}#t=${Math.floor(segment.startMs / 1000)}`; link.click();
    };
    if (page.editing) {
      const name = document.createElement('input'); name.value = segment.participantName; name.maxLength = 100; name.setAttribute('aria-label', `Participante en ${timestamp(segment.startMs)}`); name.oninput = () => setDirty(true);
      header.append(seek, name);
      const text = document.createElement('textarea'); text.value = segment.text; text.maxLength = 20_000; text.rows = 3; text.setAttribute('aria-label', `Texto en ${timestamp(segment.startMs)}`); text.oninput = () => setDirty(true); article.append(header, text);
    } else {
      const name = document.createElement('strong'); name.textContent = segment.participantName; header.append(seek, name);
      if (segment.confidence !== null) { const confidence = document.createElement('span'); confidence.className = 'muted small'; confidence.textContent = `Confianza ${Math.round(segment.confidence * 100)}%`; header.appendChild(confidence); }
      const text = document.createElement('p'); text.textContent = segment.text; article.append(header, text);
    }
    container.appendChild(article);
  }
}

function render() {
  const transcript = page.transcript; const meeting = RATCore.normalizeMeeting(page.meeting || {});
  document.getElementById('transcriptTitle').textContent = meeting.title;
  document.getElementById('transcriptMeta').textContent = `${RATCore.validDate(meeting.scheduledAt)?.toLocaleString('es-EC') || 'Fecha por definir'} · ${meeting.trainerName} · ${meeting.durationMinutes} min`;
  const status = document.getElementById('transcriptStatus'); status.textContent = STATUS_LABELS[transcript.status] || 'Estado no disponible'; status.className = `status-pill transcript-status-${String(transcript.status).toLowerCase()}`;
  document.getElementById('transcriptLanguage').textContent = `Idioma: ${transcript.language || 'es'}`;
  document.getElementById('transcriptParticipants').textContent = `${transcript.speakers?.length || 0} participante${transcript.speakers?.length === 1 ? '' : 's'} detectado${transcript.speakers?.length === 1 ? '' : 's'}`;
  const progress = Math.max(0, Math.min(100, Number(transcript.progress) || 0)); document.getElementById('transcriptProgress').style.width = `${progress}%`; document.getElementById('transcriptProgressTrack').setAttribute('aria-valuenow', String(progress)); document.getElementById('transcriptProgressLabel').textContent = `${progress}% · ${transcript.errorMessageSafe || STATUS_LABELS[transcript.status] || ''}`;
  const filter = document.getElementById('speakerFilter'); const selected = filter.value; filter.replaceChildren(new Option('Todos', ''));
  for (const speaker of transcript.speakers || []) filter.appendChild(new Option(speaker.participantName, speaker.participantIdentity || speaker.participantName)); filter.value = selected;
  const canManage = ['ADMIN', 'ORGANIZER'].includes(page.user.role); document.querySelectorAll('.manage-transcript').forEach((element) => { element.hidden = !canManage; });
  document.getElementById('editTranscript').hidden = !canManage || !COMPLETE.has(transcript.status) || page.editing;
  document.getElementById('saveTranscript').hidden = !canManage || !page.editing;
  document.getElementById('cancelEdit').hidden = !canManage || !page.editing;
  document.getElementById('retryTranscript').hidden = !canManage || !['FAILED', 'CANCELLED', 'COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(transcript.status);
  document.getElementById('cancelTranscript').hidden = !canManage || TERMINAL.has(transcript.status);
  document.getElementById('deleteTranscript').hidden = !canManage || !TERMINAL.has(transcript.status);
  document.querySelectorAll('[data-export]').forEach((link) => {
    const available = COMPLETE.has(transcript.status);
    if (available) link.href = `/api/transcriptions/${encodeURIComponent(transcript.id)}/export?format=${link.dataset.export}`;
    else link.removeAttribute('href');
    link.toggleAttribute('aria-disabled', !available);
    link.onclick = available ? null : (event) => { event.preventDefault(); notice('La transcripción todavía no está lista para descargar.', true); };
  });
  const recording = document.getElementById('openRecording'); recording.hidden = !page.recording?.url; if (page.recording?.url) recording.href = page.recording.url;
  renderSegments();
}

async function loadTranscript() {
  const data = await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}`);
  page.transcript = data.transcript; page.meeting = data.meeting; page.recording = data.recording;
  render();
  clearTimeout(page.pollTimer);
  if (!TERMINAL.has(page.transcript.status) && data.configured) page.pollTimer = setTimeout(() => loadTranscript().catch((error) => notice(error.message, true)), 2_000);
  else if (!TERMINAL.has(page.transcript.status) && !data.configured) notice('El proveedor no está configurado; el estado no puede actualizarse en este entorno.', true);
}

async function saveEdits() {
  const segments = page.transcript.segments.map((segment) => {
    const row = document.querySelector(`[data-segment-id="${CSS.escape(segment.id)}"]`);
    return { ...segment, participantName: row?.querySelector('input')?.value || segment.participantName, text: row?.querySelector('textarea')?.value || segment.text };
  });
  try {
    const data = await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}`, { method: 'PATCH', body: { revision: page.transcript.revision, language: page.transcript.language, segments } });
    page.transcript = data.transcript; page.editing = false; setDirty(false); render(); notice('Cambios guardados.');
  } catch (error) { notice(error.message, true); }
}

document.getElementById('transcriptSearch').addEventListener('input', renderSegments);
document.getElementById('speakerFilter').addEventListener('change', renderSegments);
document.getElementById('editTranscript').addEventListener('click', () => { page.editing = true; setDirty(false); render(); });
document.getElementById('cancelEdit').addEventListener('click', () => { page.editing = false; setDirty(false); render(); });
document.getElementById('saveTranscript').addEventListener('click', saveEdits);
document.getElementById('copyTranscript').addEventListener('click', async () => { try { await navigator.clipboard.writeText((page.transcript.segments || []).map((segment) => `${timestamp(segment.startMs)} — ${segment.participantName}\n${segment.text}`).join('\n\n')); notice('Texto copiado.'); } catch { notice('No fue posible copiar el texto. Selecciónalo manualmente.', true); } });
document.getElementById('retryTranscript').addEventListener('click', async () => {
  if (!await askConfirmation('Regenerar transcripción', 'El texto actual se retirará y se reemplazará cuando el nuevo trabajo termine.', 'Regenerar')) return;
  try { const data = await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}/retry`, { method: 'POST', body: {} }); page.transcript = data.transcript; render(); loadTranscript(); } catch (error) { notice(error.message, true); }
});
document.getElementById('cancelTranscript').addEventListener('click', async () => { if (!await askConfirmation('Cancelar trabajo', 'Se detendrá el procesamiento de esta transcripción.', 'Cancelar trabajo')) return; try { const data = await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}/cancel`, { method: 'POST', body: {} }); page.transcript = data.transcript; render(); } catch (error) { notice(error.message, true); } });
document.getElementById('deleteTranscript').addEventListener('click', async () => { if (!await askConfirmation('Eliminar transcripción', 'Se eliminarán el texto y sus ediciones. La grabación asociada no se eliminará.', 'Eliminar')) return; try { await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}`, { method: 'DELETE' }); location.href = '/dashboard.html'; } catch (error) { notice(error.message, true); } });
window.addEventListener('beforeunload', (event) => { if (!page.dirty) return; event.preventDefault(); event.returnValue = ''; });

(async function initialize() {
  if (!transcriptId) return notice('Falta el identificador de la transcripción.', true);
  try { const me = await api('/api/auth/me'); page.user = me.user; page.csrf = me.csrfToken; await loadTranscript(); } catch (error) { notice(error.message, true); }
}());
