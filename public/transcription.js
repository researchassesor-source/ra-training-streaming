renderBrand(document.getElementById('brand'), { tagline: false });

const transcriptId = new URLSearchParams(location.search).get('id');
const page = { user: null, csrf: '', transcript: null, meeting: null, recording: null, editing: false, dirty: false, pollTimer: null };
const STATUS_LABELS = {
  NOT_AVAILABLE: 'No disponible', READY: 'Lista para transcribir', PENDING: 'Pendiente', VALIDATING: 'Validando grabaci\u00f3n',
  FETCHING_RECORDING: 'Preparando audio', SUBMITTING: 'Enviando a transcripci\u00f3n', PROCESSING: 'Procesando',
  QUEUED: 'En cola', PROCESSING_AUDIO: 'Procesando audio', IDENTIFYING_PARTICIPANTS: 'Identificando participantes',
  GENERATING_TRANSCRIPT: 'Generando transcripci\u00f3n', COMPLETED: 'Completada', COMPLETED_WITH_WARNINGS: 'Completada con advertencias',
  FAILED: 'Fallida', CANCELLED: 'Cancelada',
};
const TERMINAL = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED']);
const COMPLETE = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS']);

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = page.csrf;
  const response = await fetch(path, { ...options, credentials: 'same-origin', headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) { location.replace('/index.html'); throw new Error('La sesi\u00f3n expir\u00f3.'); }
  if (!response.ok) throw new Error(data.error || 'No fue posible completar la solicitud.');
  return data;
}

function notice(message, error = false) {
  const element = document.getElementById('transcriptNotice');
  element.hidden = false;
  element.className = `notice ${error ? 'error' : 'success'}`;
  element.textContent = message;
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
  const accept = dialog.querySelector('[data-confirm-accept]');
  accept.textContent = confirmLabel;
  return new Promise((resolve) => {
    const close = () => { dialog.removeEventListener('close', close); resolve(dialog.returnValue === 'confirm'); };
    dialog.addEventListener('close', close);
    dialog.showModal();
    accept.focus();
  });
}

function filteredSegments() {
  const query = document.getElementById('transcriptSearch').value.trim().toLowerCase();
  const speaker = document.getElementById('speakerFilter').value;
  return (page.transcript?.segments || []).filter((segment) =>
    (!query || `${segment.participantName} ${segment.text}`.toLowerCase().includes(query)) &&
    (!speaker || segment.speakerId === speaker));
}

function renderSegments() {
  const container = document.getElementById('transcriptSegments');
  container.replaceChildren();
  const segments = filteredSegments();
  if (!segments.length) {
    const empty = document.createElement('div'); empty.className = 'empty-state branded-empty';
    const image = document.createElement('img'); image.src = 'assets/icon-192.png'; image.alt = 'Icono de R.A. Training Streaming';
    const message = document.createElement('strong'); message.textContent = COMPLETE.has(page.transcript?.status) ? 'No hay intervenciones que coincidan con la b\u00fasqueda.' : 'La transcripci\u00f3n todav\u00eda no contiene intervenciones.';
    empty.append(image, message); container.appendChild(empty); return;
  }
  for (const segment of segments) {
    const article = document.createElement('article'); article.className = 'transcript-segment'; article.dataset.segmentId = segment.id;
    const header = document.createElement('div'); header.className = 'segment-heading';
    const time = document.createElement('time'); time.className = 'timestamp-label'; time.textContent = timestamp(segment.startMs); time.dateTime = `PT${Math.max(0, Math.floor(segment.startMs / 1_000))}S`; time.title = 'Marca de tiempo dentro de la grabaci\u00f3n';
    if (page.editing) {
      const name = document.createElement('input'); name.value = segment.participantName; name.maxLength = 100; name.setAttribute('aria-label', `Participante en ${timestamp(segment.startMs)}`); name.oninput = () => setDirty(true);
      header.append(time, name);
      const text = document.createElement('textarea'); text.value = segment.text; text.maxLength = 20_000; text.rows = 3; text.setAttribute('aria-label', `Texto en ${timestamp(segment.startMs)}`); text.oninput = () => setDirty(true);
      article.append(header, text);
    } else {
      const name = document.createElement('strong'); name.textContent = segment.participantName; name.title = segment.participantName;
      header.append(time, name);
      if (segment.confidence !== null && Number.isFinite(Number(segment.confidence))) {
        const confidence = document.createElement('span'); confidence.className = 'muted small'; confidence.textContent = `Confianza ${Math.round(segment.confidence * 100)}%`; header.appendChild(confidence);
      }
      const text = document.createElement('p'); text.textContent = segment.text; article.append(header, text);
    }
    container.appendChild(article);
  }
}

function canManage() {
  return ['ADMIN', 'ORGANIZER'].includes(page.user?.role);
}

function openSpeakerRename(speaker) {
  const dialog = document.getElementById('speakerRenameDialog');
  document.getElementById('speakerRenameId').value = speaker.speakerId;
  document.getElementById('speakerRenameCurrent').textContent = `Nombre actual: ${speaker.participantName || speaker.speakerLabel}`;
  document.getElementById('speakerRenameName').value = speaker.participantName || speaker.speakerLabel;
  document.getElementById('speakerRenameError').textContent = '';
  dialog.showModal();
  document.getElementById('speakerRenameName').focus();
}

function renderSpeakerManager() {
  const container = document.getElementById('speakerManagerList');
  container.replaceChildren();
  const speakers = page.transcript?.speakers || [];
  if (!speakers.length) {
    const empty = document.createElement('span'); empty.className = 'muted small'; empty.textContent = 'Los hablantes aparecer\u00e1n cuando termine el procesamiento.'; container.appendChild(empty); return;
  }
  for (const speaker of speakers) {
    const row = document.createElement('div'); row.className = 'speaker-manager-row';
    const label = document.createElement('span'); label.textContent = speaker.participantName || speaker.speakerLabel; label.title = label.textContent;
    row.appendChild(label);
    if (canManage() && COMPLETE.has(page.transcript.status)) {
      const rename = document.createElement('button'); rename.type = 'button'; rename.className = 'secondary compact'; rename.textContent = 'Renombrar'; rename.addEventListener('click', () => openSpeakerRename(speaker)); row.appendChild(rename);
    }
    container.appendChild(row);
  }
}

function providerLabel(provider) {
  return ({ deepgram: 'Deepgram', mock: 'Simulaci\u00f3n de prueba', http: 'Proveedor externo' })[String(provider || '').toLowerCase()] || 'No especificado';
}

function render() {
  const transcript = page.transcript;
  const meeting = RATCore.normalizeMeeting(page.meeting || {});
  document.getElementById('transcriptTitle').textContent = meeting.title;
  document.getElementById('transcriptMeta').textContent = `${RATCore.validDate(meeting.scheduledAt)?.toLocaleString('es-EC') || 'Fecha por definir'} \u00b7 ${meeting.trainerName} \u00b7 ${meeting.durationMinutes} min`;
  const status = document.getElementById('transcriptStatus'); status.textContent = STATUS_LABELS[transcript.status] || 'Estado no disponible'; status.className = `status-pill transcript-status-${String(transcript.status).toLowerCase()}`;
  document.getElementById('transcriptLanguage').textContent = `Idioma: ${transcript.language || 'es'}`;
  document.getElementById('transcriptProvider').textContent = `Proveedor: ${providerLabel(transcript.provider)}`;
  document.getElementById('transcriptParticipants').textContent = `${transcript.speakers?.length || 0} hablante${transcript.speakers?.length === 1 ? '' : 's'} detectado${transcript.speakers?.length === 1 ? '' : 's'}`;
  const retention = RATCore.validDate(transcript.retentionUntil); document.getElementById('transcriptRetention').textContent = `Retenci\u00f3n objetivo: ${retention ? retention.toLocaleDateString('es-EC') : 'no disponible'}`;
  const progress = Math.max(0, Math.min(100, Number(transcript.progress) || 0));
  document.getElementById('transcriptProgress').style.width = `${progress}%`;
  document.getElementById('transcriptProgressTrack').setAttribute('aria-valuenow', String(progress));
  document.getElementById('transcriptProgressLabel').textContent = transcript.errorMessageSafe || `Etapa del flujo: ${STATUS_LABELS[transcript.status] || 'Estado no disponible'} (${progress} %)`;
  const filter = document.getElementById('speakerFilter'); const selected = filter.value; filter.replaceChildren(new Option('Todos', ''));
  for (const speaker of transcript.speakers || []) filter.appendChild(new Option(speaker.participantName || speaker.speakerLabel, speaker.speakerId));
  filter.value = [...filter.options].some((option) => option.value === selected) ? selected : '';
  document.querySelectorAll('.manage-transcript').forEach((element) => { element.hidden = !canManage(); });
  document.getElementById('editTranscript').hidden = !canManage() || !COMPLETE.has(transcript.status) || page.editing;
  document.getElementById('saveTranscript').hidden = !canManage() || !page.editing;
  document.getElementById('cancelEdit').hidden = !canManage() || !page.editing;
  document.getElementById('retryTranscript').hidden = !canManage() || !['FAILED', 'CANCELLED', 'COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(transcript.status);
  document.getElementById('cancelTranscript').hidden = !canManage() || TERMINAL.has(transcript.status);
  document.getElementById('deleteTranscript').hidden = !canManage() || !TERMINAL.has(transcript.status);
  document.querySelectorAll('[data-export]').forEach((link) => {
    const available = COMPLETE.has(transcript.status);
    if (available) link.href = `/api/transcriptions/${encodeURIComponent(transcript.id)}/export?format=${link.dataset.export}`;
    else link.removeAttribute('href');
    link.toggleAttribute('aria-disabled', !available);
    link.onclick = available ? null : (event) => { event.preventDefault(); notice('La transcripci\u00f3n todav\u00eda no est\u00e1 lista para descargar.', true); };
  });
  renderSpeakerManager();
  renderSegments();
}

async function loadTranscript() {
  const data = await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}`);
  page.transcript = data.transcript; page.meeting = data.meeting; page.recording = data.recording;
  render();
  clearTimeout(page.pollTimer);
  if (!TERMINAL.has(page.transcript.status) && data.configured) page.pollTimer = setTimeout(() => loadTranscript().catch((error) => notice(error.message, true)), 2_000);
  else if (!TERMINAL.has(page.transcript.status) && !data.configured) notice('El proveedor no est\u00e1 configurado; el estado no puede actualizarse en este entorno.', true);
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
document.getElementById('cancelEdit').addEventListener('click', async () => {
  if (page.dirty && !await askConfirmation('Descartar cambios', 'Los cambios de texto y nombres que no guardaste se perderán.', 'Descartar')) return;
  page.editing = false; setDirty(false); render();
});
document.getElementById('saveTranscript').addEventListener('click', saveEdits);
document.getElementById('copyTranscript').addEventListener('click', async () => {
  try { await navigator.clipboard.writeText((page.transcript.segments || []).map((segment) => `${timestamp(segment.startMs)} \u2014 ${segment.participantName}\n${segment.text}`).join('\n\n')); notice('Texto copiado.'); }
  catch { notice('No fue posible copiar el texto. Selecci\u00f3nalo manualmente.', true); }
});
document.getElementById('retryTranscript').addEventListener('click', async () => {
  if (!await askConfirmation('Regenerar transcripci\u00f3n', 'El texto actual se retirar\u00e1 y se reemplazar\u00e1 cuando el nuevo trabajo termine.', 'Regenerar')) return;
  try { const data = await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}/retry`, { method: 'POST', body: {} }); page.transcript = data.transcript; render(); await loadTranscript(); }
  catch (error) { notice(error.message, true); }
});
document.getElementById('cancelTranscript').addEventListener('click', async () => {
  if (!await askConfirmation('Cancelar trabajo', 'Se abortar\u00e1 el procesamiento activo de esta transcripci\u00f3n.', 'Cancelar trabajo')) return;
  try {
    const data = await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}/cancel`, { method: 'POST', body: {} });
    page.transcript = data.transcript; render();
    notice(COMPLETE.has(data.transcript.status) ? 'El proveedor ya hab\u00eda completado la transcripci\u00f3n.' : data.transcript.status === 'FAILED' ? 'El trabajo ya hab\u00eda fallado.' : 'Transcripci\u00f3n cancelada.');
  } catch (error) { notice(error.message, true); }
});
document.getElementById('deleteTranscript').addEventListener('click', async () => {
  if (!await askConfirmation('Eliminar transcripci\u00f3n', 'Se eliminar\u00e1n el texto y sus ediciones. La grabaci\u00f3n asociada no se eliminar\u00e1.', 'Eliminar')) return;
  try { await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}`, { method: 'DELETE' }); location.href = '/dashboard.html'; }
  catch (error) { notice(error.message, true); }
});
document.getElementById('speakerRenameCancel').addEventListener('click', () => document.getElementById('speakerRenameDialog').close());
document.getElementById('speakerRenameForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const speakerId = document.getElementById('speakerRenameId').value;
  const participantName = document.getElementById('speakerRenameName').value.trim();
  const error = document.getElementById('speakerRenameError'); error.textContent = '';
  try {
    const data = await api(`/api/transcriptions/${encodeURIComponent(transcriptId)}/speakers/${encodeURIComponent(speakerId)}`, { method: 'PATCH', body: { revision: page.transcript.revision, participantName } });
    page.transcript = data.transcript; document.getElementById('speakerRenameDialog').close(); render(); notice('Nombre del hablante actualizado en la transcripci\u00f3n y sus exportaciones.');
  } catch (requestError) { error.textContent = requestError.message; }
});
document.getElementById('backToDashboard').addEventListener('click', async (event) => {
  if (!page.dirty) return;
  event.preventDefault();
  if (await askConfirmation('Salir sin guardar', 'Los cambios de texto y nombres que no guardaste se perderán.', 'Salir')) location.href = event.currentTarget.href;
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const speakerDialog = document.getElementById('speakerRenameDialog');
  const confirmDialog = document.getElementById('transcriptConfirmDialog');
  if (speakerDialog.open) { event.preventDefault(); speakerDialog.close('cancel'); }
  else if (confirmDialog.open) { event.preventDefault(); confirmDialog.close('cancel'); }
});
window.addEventListener('beforeunload', (event) => { if (!page.dirty) return; event.preventDefault(); event.returnValue = ''; });

(async function initialize() {
  if (!transcriptId) return notice('Falta el identificador de la transcripci\u00f3n.', true);
  try { const me = await api('/api/auth/me'); page.user = me.user; page.csrf = me.csrfToken; await loadTranscript(); }
  catch (error) { notice(error.message, true); }
}());
