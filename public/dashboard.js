renderBrand(document.getElementById('brand'), { tagline: false });

const state = {
  user: null,
  csrf: '',
  meetings: [],
  series: [],
  recordings: [],
  users: [],
  summary: null,
  invitation: null,
  seriesShare: null,
  seriesGeneralShare: null,
  activeSeriesId: null,
  calendarDate: new Date(),
  calendarView: 'month',
};

const STATUS_LABELS = {
  DRAFT: 'Borrador', ACTIVE: 'Activa', SCHEDULED: 'Programada', LIVE: 'En vivo', COMPLETED: 'Finalizada',
  CANCELLED: 'Cancelada', ARCHIVED: 'Archivada',
};
const TYPE_LABELS = { WEBINAR: 'Webinar', SESSION: 'Sesión', CLASS: 'Clase' };
const ROLE_LABELS = { ADMIN: 'Administrador', ORGANIZER: 'Organizador', PANELIST: 'Panelista', VIEWER: 'Asistente' };
const ENVIRONMENT_LABELS = { development: 'Desarrollo', preview: 'Vista previa', production: 'Producción', test: 'Pruebas' };
const PROVIDER_LABELS = { mock: 'Simulación local', http: 'Proveedor HTTP', deepgram: 'Deepgram' };
const TRANSCRIPT_STATUS_LABELS = {
  PENDING: 'Preparando transcripción', VALIDATING: 'Preparando transcripción', FETCHING_RECORDING: 'Preparando transcripción',
  SUBMITTING: 'Transcripción en proceso', PROCESSING: 'Transcripción en proceso', QUEUED: 'Preparando transcripción',
  PROCESSING_AUDIO: 'Transcripción en proceso', IDENTIFYING_PARTICIPANTS: 'Transcripción en proceso', GENERATING_TRANSCRIPT: 'Transcripción en proceso',
  COMPLETED: 'Transcripción completada', COMPLETED_WITH_WARNINGS: 'Completada con advertencias', FAILED: 'No se pudo transcribir', CANCELLED: 'Transcripción cancelada',
};
const AUDIT_LABELS = {
  AUTH_LOGIN: 'Inicio de sesión', AUTH_LOGIN_FAILED: 'Inicio de sesión fallido', AUTH_LOGOUT: 'Cierre de sesión',
  USER_CREATED: 'Usuario creado', USER_UPDATED: 'Usuario actualizado', USER_DEACTIVATED: 'Usuario desactivado',
  USER_ROLE_CHANGED: 'Rol de usuario cambiado', USER_PASSWORD_RESET: 'Contraseña restablecida',
  USER_SESSIONS_REVOKED: 'Sesiones revocadas', USER_DELETED: 'Usuario eliminado',
  MEETING_CREATED: 'Reunión creada', MEETING_UPDATED: 'Reunión actualizada', MEETING_STARTED: 'Reunión iniciada',
  MEETING_CANCELLED: 'Reunión cancelada', MEETING_ARCHIVED: 'Reunión archivada', MEETING_RESTORED: 'Reunión restaurada',
  MEETING_ENDED: 'Reunión finalizada', MEETING_DELETED: 'Reunión eliminada', INVITATION_CREATED: 'Invitación creada',
  INVITATION_REVOKED: 'Invitación revocada', RECORDING_STARTED: 'Grabación iniciada', RECORDING_STOPPED: 'Grabación detenida',
  RECORDING_FAILED: 'Fallo de grabación', RECORDING_DELETED: 'Grabación eliminada', TRANSCRIPTION_CREATED: 'Transcripción solicitada',
  TRANSCRIPTION_COMPLETED: 'Transcripción completada', TRANSCRIPTION_FAILED: 'Transcripción fallida',
  TRANSCRIPTION_EDITED: 'Transcripción editada', TRANSCRIPTION_RETRIED: 'Transcripción regenerada',
  TRANSCRIPTION_CANCELLED: 'Transcripción cancelada', TRANSCRIPTION_DELETED: 'Transcripción eliminada',
  TRANSCRIPTION_REQUESTED: 'Transcripción solicitada', TRANSCRIPTION_VALIDATION_FAILED: 'Solicitud de transcripción rechazada',
  TRANSCRIPTION_STARTED: 'Procesamiento de transcripción iniciado', TRANSCRIPTION_PROVIDER_SUBMITTED: 'Audio enviado al proveedor',
  TRANSCRIPTION_SPEAKER_RENAMED: 'Hablante renombrado', TRANSCRIPTION_EXPORTED: 'Transcripción exportada',
  SERIES_CREATED: 'Capacitación creada', SERIES_UPDATED: 'Capacitación actualizada', SERIES_RESCHEDULED: 'Sesión reprogramada',
  SERIES_ACCESS_CREATED: 'Acceso estable creado', SERIES_ACCESS_REVOKED: 'Acceso estable revocado', SERIES_ACCESS_REGENERATED: 'Acceso estable regenerado',
  SPEAKER_REQUESTED: 'Solicitud de palabra creada', SPEAKER_GRANTED: 'Palabra concedida', SPEAKER_REJECTED: 'Solicitud de palabra rechazada', SPEAKER_REVOKED: 'Palabra retirada',
  ATTENDANCE_UPDATED: 'Asistencia actualizada', SERIES_SESSION_ENTERED: 'Entrada a sesión de capacitación',
  ROOM_OPEN_ATTEMPT: 'Intento de abrir reunión', ROOM_CONNECTION_FAILED: 'Error de conexión a la reunión',
  ROOM_RETRY: 'Reintento de conexión', ROOM_CONNECTED: 'Reunión iniciada', ROOM_ENDED: 'Reunión finalizada',
  PARTICIPANT_CONSENT_RECORDED: 'Consentimiento de participante registrado',
};
const fmtDate = new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeStyle: 'short' });

function formatDate(value, fallback = 'Fecha por definir') {
  const date = RATCore.validDate(value);
  return date ? fmtDate.format(date) : fallback;
}

function emptyState(title, detail = '') {
  const empty = document.createElement('div'); empty.className = 'empty-state branded-empty';
  const image = document.createElement('img'); image.src = 'assets/streaming-app-logo.png'; image.alt = 'Logo oficial de R.A. Training Streaming';
  empty.append(image, textElement('strong', title));
  if (detail) empty.appendChild(textElement('span', detail, 'muted'));
  return empty;
}

function askConfirmation({ title, message, confirmLabel = 'Confirmar', danger = false }) {
  const dialog = document.getElementById('dashboardConfirmDialog');
  dialog.querySelector('[data-confirm-title]').textContent = title;
  dialog.querySelector('[data-confirm-message]').textContent = message;
  const accept = dialog.querySelector('[data-confirm-accept]');
  accept.textContent = confirmLabel;
  accept.className = danger ? 'danger' : 'primary';
  return new Promise((resolve) => {
    const close = () => { dialog.removeEventListener('close', close); resolve(dialog.returnValue === 'confirm'); };
    dialog.addEventListener('close', close);
    dialog.showModal(); accept.focus();
  });
}

function requestPassword(username) {
  const dialog = document.getElementById('passwordDialog');
  dialog.querySelector('[data-password-user]').textContent = username;
  const input = dialog.querySelector('[data-password-new]'); const confirmation = dialog.querySelector('[data-password-confirm]');
  input.value = ''; confirmation.value = ''; input.type = 'password'; confirmation.type = 'password';
  RATPasswordToggle.sync(dialog);
  const error = dialog.querySelector('.form-error'); error.textContent = '';
  return new Promise((resolve) => {
    const form = dialog.querySelector('form');
    const validate = (event) => { if (event.submitter?.value === 'confirm' && input.value !== confirmation.value) { event.preventDefault(); error.textContent = 'Las contraseñas no coinciden.'; confirmation.focus(); } };
    const close = () => { dialog.removeEventListener('close', close); form.removeEventListener('submit', validate); resolve(dialog.returnValue === 'confirm' ? input.value : ''); };
    form.addEventListener('submit', validate);
    dialog.addEventListener('close', close);
    dialog.showModal(); input.focus();
  });
}

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.body !== undefined && !(options.body instanceof FormData)) headers['Content-Type'] = 'application/json';
  if (options.method && options.method !== 'GET') headers['X-CSRF-Token'] = state.csrf;
  const response = await fetch(path, {
    ...options,
    credentials: 'same-origin',
    headers,
    body: options.body === undefined || options.body instanceof FormData ? options.body : JSON.stringify(options.body),
  });
  const data = response.status === 204 ? null : await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.replace('/index.html');
    throw new Error('Sesión expirada');
  }
  if (!response.ok) {
    const error = new Error(data.error || 'No fue posible completar la solicitud');
    error.code = data.code; error.status = response.status; error.requestId = data.requestId || response.headers.get('x-request-id') || null;
    error.message = RATCore.apiErrorMessage(error);
    throw error;
  }
  return data;
}

function notice(message, type = 'success') {
  const element = document.getElementById('globalNotice');
  element.textContent = message;
  element.className = `notice ${type}`;
  element.hidden = false;
  clearTimeout(notice.timer);
  notice.timer = setTimeout(() => { element.hidden = true; }, 5_000);
}

function markFieldError(input, active) {
  if (!input) return;
  input.setAttribute('aria-invalid', active ? 'true' : 'false');
}

function firstInvalidMeetingField() {
  const checks = [
    ['meetingTitle', 'El título es obligatorio.'],
    ['meetingTrainer', 'El nombre del capacitador es obligatorio.'],
    ['meetingDuration', 'La duración debe estar entre 1 y 1440 minutos.'],
    ['meetingCapacity', 'La capacidad debe estar entre 0 y 100000.'],
    ['meetingTranscriptionRetention', 'La retención debe estar entre 1 y 3650 días.'],
  ];
  for (const [id, message] of checks) {
    const input = document.getElementById(id);
    markFieldError(input, false);
    const value = input.type === 'number' ? Number(input.value) : input.value.trim();
    if (!input.checkValidity() || (input.type === 'number' && !Number.isFinite(value))) {
      markFieldError(input, true);
      return { input, message };
    }
  }
  return null;
}

function showSection(name) {
  document.querySelectorAll('[data-section-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.sectionPanel === name));
  document.querySelectorAll('[data-section]').forEach((button) => {
    const active = button.dataset.section === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.getElementById('dashboardSidebar').classList.remove('open');
  document.getElementById('sidebarOverlay').classList.remove('visible');
  document.getElementById('sidebarOverlay').setAttribute('aria-hidden', 'true');
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'false');
  const titles = { summary: 'Panel organizador', agenda: 'Agenda', trainings: 'Capacitaciones', meetings: 'Reuniones', recordings: 'Grabaciones', users: 'Usuarios', audit: 'Auditoría', settings: 'Configuración' };
  document.title = `${titles[name] || 'Panel organizador'} | R.A. Training Streaming`;
  history.replaceState(null, '', `#${name}`);
  if (name === 'recordings') loadRecordings();
  if (name === 'users' && state.user.role === 'ADMIN') loadUsers();
  if (name === 'audit' && state.user.role === 'ADMIN') loadAudit();
  if (name === 'agenda') renderCalendar();
  if (name === 'trainings') renderTrainingSeries();
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function statusPill(status) {
  const safeStatus = STATUS_LABELS[status] ? status : 'SCHEDULED';
  const pill = textElement('span', STATUS_LABELS[safeStatus], `status-pill status-${safeStatus.toLowerCase()}`);
  return pill;
}

function meetingMatchesFilters(meeting) {
  const query = document.getElementById('meetingSearch').value.trim().toLowerCase();
  const status = document.getElementById('meetingStatusFilter').value;
  const haystack = `${meeting.title} ${meeting.room} ${meeting.trainerName}`.toLowerCase();
  return (!query || haystack.includes(query)) && (!status || meeting.status === status);
}

function meetingAction(label, action, meeting, className = 'secondary compact') {
  const button = textElement('button', label, className);
  button.type = 'button';
  button.addEventListener('click', () => {
    closeActionMenus({ restoreFocus: false });
    action(meeting);
  });
  return button;
}

function seriesMatchesFilters(series) {
  const query = document.getElementById('seriesSearch')?.value.trim().toLowerCase() || '';
  const status = document.getElementById('seriesStatusFilter')?.value || '';
  const haystack = `${series.title} ${series.trainerName} ${(series.sessions || []).map((session) => `${session.title} ${session.room}`).join(' ')}`.toLowerCase();
  const seriesStatus = String(series.status || 'ACTIVE').toUpperCase();
  return (!query || haystack.includes(query)) && (!status || seriesStatus === status || series.sessions.some((session) => session.status === status));
}

function renderSeriesCard(series) {
  const card = document.createElement('details'); card.className = 'training-series-card compact-series-card';
  const summary = document.createElement('summary'); summary.className = 'training-series-summary';
  const title = document.createElement('div'); title.className = 'training-series-title';
  const nextSession = series.resolution?.meeting;
  title.append(
    textElement('p', 'Capacitación', 'eyebrow'),
    textElement('h2', series.title),
    textElement('p', `${series.trainerName} · ${TYPE_LABELS[series.type] || 'Webinar'} · ${series.sessions.length} sesiones`, 'muted')
  );
  const progress = document.createElement('div'); progress.className = 'series-progress';
  const progressValue = series.sessions.length ? Math.round((Number(series.resolution?.completedCount || 0) / series.sessions.length) * 100) : 0;
  const progressFill = document.createElement('span'); progressFill.style.width = `${progressValue}%`; progress.appendChild(progressFill);
  const stats = document.createElement('div'); stats.className = 'series-compact-stats';
  stats.append(
    statusPill(series.resolution?.phase === 'LIVE' ? 'LIVE' : series.resolution?.phase === 'COMPLETED' || series.status === 'COMPLETED' ? 'COMPLETED' : series.status || 'ACTIVE'),
    textElement('span', nextSession ? `Próxima: ${formatDate(nextSession.scheduledAt)}` : 'Sin próxima sesión', 'muted small'),
    textElement('span', `${progressValue}% completado`, 'muted small')
  );
  summary.append(title, stats, progress);
  const actions = document.createElement('div'); actions.className = 'meeting-actions series-primary-actions';
  actions.append(
    meetingAction('Compartir acceso', openSeriesShare, series, 'primary compact'),
    meetingAction('Participantes', openSeriesAttendance, series),
    meetingAction('Editar capacitación', openSeriesDialog, series)
  );
  if (series.resolution?.meeting && !['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(series.resolution.meeting.status)) {
    actions.append(meetingAction(series.resolution.meeting.status === 'LIVE' ? 'Abrir sesión actual' : 'Abrir próxima sesión', () => launchMeeting(series.resolution.meeting), series));
  }
  const more = document.createElement('details'); more.className = 'action-menu';
  const moreSummary = document.createElement('summary'); moreSummary.textContent = 'Más acciones';
  const moreItems = document.createElement('div'); moreItems.className = 'action-menu-items';
  moreItems.appendChild(meetingAction('Copiar calendario', async () => {
    const calendar = `${series.title}\n\n${series.sessions.map((session) => `Sesión ${session.sessionNumber}: ${formatDate(session.scheduledAt)}`).join('\n')}`;
    try { await copyText(calendar); notice('Calendario copiado.'); } catch (error) { notice(error.message, 'error'); }
  }, series));
  if (series.resolution?.meeting) moreItems.appendChild(meetingAction('Editar próxima sesión', () => openMeetingDialog(series.resolution.meeting), series));
  if (series.status === 'ARCHIVED') moreItems.appendChild(meetingAction('Restaurar capacitación', (item) => seriesTransition(item, 'ACTIVE'), series, 'primary compact'));
  else moreItems.appendChild(meetingAction('Archivar capacitación', (item) => seriesTransition(item, 'ARCHIVED'), series, 'danger compact'));
  more.append(moreSummary, moreItems); actions.appendChild(more);
  const sessionList = document.createElement('ol'); sessionList.className = 'series-dashboard-session-list';
  for (const session of series.sessions) {
    const row = document.createElement('li');
    const info = document.createElement('div'); info.append(textElement('strong', `Sesión ${session.sessionNumber}`), textElement('span', `${formatDate(session.scheduledAt)} · ${session.durationMinutes} min`, 'muted small'));
    const rowActions = document.createElement('div'); rowActions.className = 'series-session-actions';
    rowActions.append(statusPill(session.status), meetingAction('Editar', openMeetingDialog, session));
    if (!['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(session.status)) rowActions.append(meetingAction(session.status === 'LIVE' ? 'Abrir' : 'Iniciar', launchMeeting, session, 'secondary compact'));
    row.append(info, rowActions); sessionList.appendChild(row);
  }
  card.append(summary, textElement('p', series.description || 'Sin descripción', 'muted clamp'), textElement('p', `${series.resolution?.completedCount || 0} de ${series.sessions.length} sesiones completadas`, 'muted small'), actions, sessionList);
  return card;
}

function renderTrainingSeries() {
  const list = document.getElementById('trainingSeriesList');
  if (!list) return;
  list.replaceChildren();
  const filteredSeries = state.series.filter(seriesMatchesFilters);
  if (!filteredSeries.length) {
    list.appendChild(emptyState('No hay capacitaciones que coincidan con los filtros.', 'Crea un ciclo formativo o activa “Ver archivadas” para restaurar capacitaciones cerradas.'));
    return;
  }
  for (const series of filteredSeries) list.appendChild(renderSeriesCard(series));
}

function mobileActionMenus() {
  return window.matchMedia('(max-width: 700px)').matches;
}

function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function openActionMenus() {
  return [...document.querySelectorAll('.action-menu[open]')];
}

function closeActionMenus({ except = null, restoreFocus = false } = {}) {
  for (const menu of openActionMenus()) {
    if (menu === except) continue;
    const trigger = menu.querySelector(':scope > summary');
    menu.open = false;
    menu.classList.remove('opens-up', 'opens-down');
    menu.closest('.training-series-card, .meeting-card, .recording-card')?.classList.remove('menu-open');
    const items = menu.querySelector('.action-menu-items');
    if (items) {
      items.style.left = '';
      items.style.top = '';
      items.style.right = '';
      items.style.bottom = '';
      items.style.maxHeight = '';
      items.style.width = '';
    }
    if (restoreFocus) trigger?.focus();
  }
}

function positionActionMenu(menu) {
  if (!menu?.open) return;
  const items = menu.querySelector('.action-menu-items');
  const trigger = menu.querySelector(':scope > summary');
  if (!items || !trigger) return;
  menu.closest('.training-series-card, .meeting-card, .recording-card')?.classList.add('menu-open');
  if (mobileActionMenus()) {
    menu.classList.remove('opens-up', 'opens-down');
    items.style.left = '';
    items.style.top = '';
    items.style.right = '';
    items.style.bottom = '';
    items.style.maxHeight = '';
    items.style.width = '';
    return;
  }
  const margin = 12;
  const gap = 8;
  const triggerRect = trigger.getBoundingClientRect();
  const viewportWidth = document.documentElement.clientWidth;
  const viewportHeight = document.documentElement.clientHeight;
  items.style.width = `${Math.min(280, viewportWidth - margin * 2)}px`;
  items.style.maxHeight = `${viewportHeight - margin * 2}px`;
  const itemRect = items.getBoundingClientRect();
  const width = itemRect.width || Math.min(280, viewportWidth - margin * 2);
  const height = Math.min(itemRect.height || 0, viewportHeight - margin * 2);
  const spaceBelow = viewportHeight - triggerRect.bottom - margin;
  const spaceAbove = triggerRect.top - margin;
  const opensUp = spaceBelow < height + gap && spaceAbove > spaceBelow;
  const left = clampNumber(triggerRect.right - width, margin, Math.max(margin, viewportWidth - width - margin));
  const top = opensUp
    ? clampNumber(triggerRect.top - height - gap, margin, Math.max(margin, viewportHeight - height - margin))
    : clampNumber(triggerRect.bottom + gap, margin, Math.max(margin, viewportHeight - height - margin));
  menu.classList.toggle('opens-up', opensUp);
  menu.classList.toggle('opens-down', !opensUp);
  items.style.left = `${left}px`;
  items.style.top = `${top}px`;
  items.style.right = 'auto';
  items.style.bottom = 'auto';
}

function renderMeetings() {
  const list = document.getElementById('meetingsList');
  list.replaceChildren();
  const filtered = state.meetings.filter((meeting) => !meeting.seriesId && meetingMatchesFilters(meeting));
  if (!filtered.length) {
    list.appendChild(emptyState('No hay reuniones que coincidan con los filtros.', 'Ajusta los filtros o crea una nueva reunión.'));
    return;
  }
  for (const meeting of filtered) {
    const card = document.createElement('article');
    card.className = 'meeting-card';
    const main = document.createElement('div');
    main.className = 'meeting-card-main';
    const heading = document.createElement('div');
    heading.className = 'meeting-card-heading';
    heading.append(textElement('h2', meeting.title), statusPill(meeting.status));
    main.append(
      heading,
      textElement('p', meeting.description?.trim() || 'Sin descripción', 'muted clamp'),
      textElement('p', `${meeting.trainerName || 'Capacitador por definir'} · ${TYPE_LABELS[meeting.type] || 'Webinar'} · ${meeting.durationMinutes || 60} min`, 'meeting-meta'),
      textElement('p', formatDate(meeting.scheduledAt), 'meeting-time'),
      textElement('p', `Sala: ${meeting.room} · Capacidad: ${meeting.capacity}`, 'muted small')
    );
    const actions = document.createElement('div');
    actions.className = 'meeting-actions';
    if (!meeting.deletedAt) {
      actions.append(meetingAction('Editar', openMeetingDialog, meeting));
      if (!['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) {
        actions.append(meetingAction(meeting.status === 'LIVE' ? 'Abrir sala' : 'Iniciar', launchMeeting, meeting, 'primary compact'));
        actions.append(meetingAction('Enlace anfitrión', (item) => openSimpleMeetingAccessDialog(item, 'HOST'), meeting, 'secondary compact'));
        actions.append(meetingAction('Enlace participante', (item) => openSimpleMeetingAccessDialog(item, 'PARTICIPANT'), meeting, 'secondary compact'));
      }
      const recording = state.recordings.find((item) => item.meetingId === meeting.id && item.status === 'READY');
      if (recording?.transcript) {
        const transcriptLink = document.createElement('a'); transcriptLink.className = 'button secondary compact'; transcriptLink.href = `/transcription.html?id=${encodeURIComponent(recording.transcript.id)}`; transcriptLink.textContent = ['FAILED', 'CANCELLED'].includes(recording.transcript.status) ? 'Reintentar transcripción' : ['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(recording.transcript.status) ? 'Ver transcripción' : 'Ver proceso de transcripción'; actions.appendChild(transcriptLink);
      } else if (meeting.status === 'COMPLETED' && meeting.allowTranscription && recording) {
        actions.append(meetingAction('Transcribir reunión', () => startTranscription(meeting, recording), meeting, 'secondary compact'));
      }
      const menu = document.createElement('details'); menu.className = 'action-menu';
      const summary = document.createElement('summary'); summary.textContent = 'Más acciones'; menu.appendChild(summary);
      const menuItems = document.createElement('div'); menuItems.className = 'action-menu-items';
      menuItems.append(meetingAction('Duplicar', duplicateMeeting, meeting));
      if (!['CANCELLED', 'COMPLETED', 'ARCHIVED'].includes(meeting.status)) menuItems.append(meetingAction('Cancelar', (item) => meetingTransition(item, 'cancel'), meeting));
      if (meeting.status !== 'ARCHIVED') menuItems.append(meetingAction('Archivar', (item) => meetingTransition(item, 'archive'), meeting));
      if (state.user.role === 'ADMIN') menuItems.append(meetingAction('Eliminar', softDeleteMeeting, meeting, 'danger compact'));
      menu.appendChild(menuItems); actions.appendChild(menu);
    } else {
      actions.append(meetingAction('Restaurar', (item) => meetingTransition(item, 'restore'), meeting, 'primary compact'));
    }
    card.append(main, actions);
    list.appendChild(card);
  }
}

async function startTranscription(meeting, recording) {
  try {
    const data = await api(`/api/meetings/${encodeURIComponent(meeting.id)}/transcriptions`, {
      method: 'POST', body: { recordingId: recording.id, language: meeting.transcriptionLanguage || 'es' },
    });
    notice('La transcripción fue enviada a la cola.');
    window.location.href = `/transcription.html?id=${encodeURIComponent(data.transcript.id)}`;
  } catch (error) { notice(error.message, 'error'); }
}

function localDateTimeValue(value) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function defaultSeriesDate(dayOffset = 1) {
  const date = new Date(Date.now() + dayOffset * 86_400_000);
  date.setHours(10, 0, 0, 0);
  return localDateTimeValue(date);
}

function addSeriesSession(value = {}) {
  const container = document.getElementById('seriesSessionRows');
  const row = document.createElement('div'); row.className = 'series-form-session-row';
  const number = container.children.length + 1;
  const dateLabel = document.createElement('label'); dateLabel.textContent = `Sesión ${number} · fecha y hora`;
  const date = document.createElement('input'); date.type = 'datetime-local'; date.required = true; date.dataset.seriesDate = 'true'; date.value = value.scheduledAt ? localDateTimeValue(value.scheduledAt) : defaultSeriesDate(number * 7);
  const durationLabel = document.createElement('label'); durationLabel.textContent = 'Duración (minutos)';
  const duration = document.createElement('input'); duration.type = 'number'; duration.min = '1'; duration.max = '1440'; duration.required = true; duration.dataset.seriesDuration = 'true'; duration.value = String(value.durationMinutes || 60);
  const remove = textElement('button', 'Quitar', 'secondary compact'); remove.type = 'button'; remove.addEventListener('click', () => { row.remove(); [...container.children].forEach((item, index) => { item.querySelector('label').firstChild.textContent = `Sesión ${index + 1} · fecha y hora`; }); });
  dateLabel.appendChild(date); durationLabel.appendChild(duration); row.append(dateLabel, durationLabel, remove); container.appendChild(row);
}

function openSeriesDialog(series = null) {
  document.getElementById('seriesForm').reset();
  document.getElementById('seriesOriginalId').value = series?.id || '';
  document.getElementById('seriesDialogTitle').textContent = series ? 'Editar capacitación' : 'Nueva capacitación';
  document.getElementById('seriesDialogIntro').textContent = series
    ? 'Actualiza los datos principales del ciclo. Las fechas de cada sesión se editan desde la sesión correspondiente.'
    : 'Cada fecha crea una sala independiente. Los participantes conservarán un único enlace personal.';
  document.getElementById('seriesFormTimezone').value = 'America/Guayaquil';
  document.getElementById('seriesEarlyAccess').value = '120';
  const rows = document.getElementById('seriesSessionRows'); rows.replaceChildren();
  document.getElementById('seriesSessionsFieldset').hidden = Boolean(series);
  document.getElementById('seriesFeaturesFieldset').hidden = Boolean(series);
  if (series) {
    document.getElementById('seriesFormTitle').value = series.title || '';
    document.getElementById('seriesFormDescription').value = series.description || '';
    document.getElementById('seriesFormTrainer').value = series.trainerName || '';
    document.getElementById('seriesFormType').value = series.type || 'WEBINAR';
    document.getElementById('seriesFormTimezone').value = series.timezone || 'America/Guayaquil';
    document.getElementById('seriesEarlyAccess').value = String(series.earlyAccessMinutes ?? 120);
  } else {
    addSeriesSession({ scheduledAt: defaultSeriesDate(1) }); addSeriesSession({ scheduledAt: defaultSeriesDate(8) });
  }
  document.getElementById('saveSeries').textContent = series ? 'Guardar capacitación' : 'Crear capacitación';
  document.getElementById('seriesFormError').textContent = '';
  document.getElementById('seriesDialog').showModal();
}

async function saveSeries(event) {
  event.preventDefault();
  const original = document.getElementById('seriesOriginalId').value;
  const sessions = [...document.querySelectorAll('.series-form-session-row')].map((row) => ({
    scheduledLocal: row.querySelector('[data-series-date]').value,
    durationMinutes: Number(row.querySelector('[data-series-duration]').value),
  }));
  const payload = {
    title: document.getElementById('seriesFormTitle').value.trim(), description: document.getElementById('seriesFormDescription').value.trim(),
    trainerName: document.getElementById('seriesFormTrainer').value.trim(), type: document.getElementById('seriesFormType').value,
    timezone: document.getElementById('seriesFormTimezone').value.trim(), earlyAccessMinutes: Number(document.getElementById('seriesEarlyAccess').value), sessions,
    allowChat: document.getElementById('seriesAllowChat').checked, allowFiles: document.getElementById('seriesAllowFiles').checked,
    allowReactions: document.getElementById('seriesAllowReactions').checked, allowRaiseHand: document.getElementById('seriesAllowRaiseHand').checked,
    allowRecording: document.getElementById('seriesAllowRecording').checked, allowTranscription: document.getElementById('seriesAllowTranscription').checked,
  };
  const error = document.getElementById('seriesFormError'); error.textContent = '';
  try {
    if (original) {
      await api(`/api/series/${encodeURIComponent(original)}`, {
        method: 'PATCH',
        body: {
          title: payload.title,
          description: payload.description,
          trainerName: payload.trainerName,
          type: payload.type,
          timezone: payload.timezone,
          earlyAccessMinutes: payload.earlyAccessMinutes,
        },
      });
      notice('Capacitación actualizada.');
    } else {
      await api('/api/series', { method: 'POST', body: payload });
      notice('Capacitación y sesiones creadas.');
    }
    document.getElementById('seriesDialog').close(); await loadMeetings();
  }
  catch (requestError) { error.textContent = requestError.message; }
}

async function seriesTransition(series, status) {
  const archived = status === 'ARCHIVED';
  if (!await askConfirmation({
    title: archived ? '¿Archivar esta capacitación?' : '¿Restaurar esta capacitación?',
    message: archived
      ? 'Se desactivará la capacitación, se cerrarán sesiones activas y se impedirán nuevos accesos. Las grabaciones y el historial se conservarán.'
      : `“${series.title}” volverá al listado principal de capacitaciones.`,
    confirmLabel: archived ? 'Archivar capacitación' : 'Restaurar capacitación',
    danger: archived,
  })) return;
  try {
    await api(`/api/series/${encodeURIComponent(series.id)}`, { method: 'PATCH', body: { status } });
    notice(archived ? 'Capacitación archivada.' : 'Capacitación restaurada.');
    await loadMeetings();
  } catch (error) { notice(error.message, 'error'); }
}

function showSeriesShare(access) {
  state.seriesShare = access;
  document.getElementById('seriesShareResult').hidden = false;
  document.getElementById('seriesAccessUrl').value = access.url || '';
  document.getElementById('seriesInvitationMessage').value = access.invitationMessage || '';
}

function showGeneralSeriesShare(access, { reveal = false } = {}) {
  state.seriesGeneralShare = access;
  const result = document.getElementById('seriesGeneralShareResult');
  result.hidden = false;
  document.getElementById('seriesGeneralAccessUrl').value = access.url || '';
  document.getElementById('seriesGeneralInvitationMessage').value = access.invitationMessage || '';
  if (reveal) window.requestAnimationFrame(() => { result.focus({ preventScroll: true }); result.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
}

function showSeriesShareError(message) {
  const error = document.getElementById('seriesShareError');
  error.textContent = message;
  error.focus({ preventScroll: true });
  error.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function renderSeriesAccessList(items) {
  const container = document.getElementById('seriesAccessList'); container.replaceChildren();
  if (!items.length) { container.appendChild(emptyState('Todavía no hay accesos individuales.', 'Crea uno con el nombre del participante.')); return; }
  for (const access of items) {
    const row = document.createElement('article'); row.className = 'series-access-admin-row';
    const info = document.createElement('div'); info.append(textElement('strong', access.participantName), textElement('span', `${access.status === 'ACTIVE' ? 'Activo' : 'Revocado'} · ${access.usageCount || 0} aperturas`, 'muted small'));
    const actions = document.createElement('div'); actions.className = 'series-session-actions';
    if (access.status === 'ACTIVE') {
      actions.append(meetingAction('Ver y copiar', () => showSeriesShare(access), access), meetingAction('Revocar', async () => {
        if (!await askConfirmation({ title: 'Revocar acceso individual', message: `El enlace de ${access.participantName} dejará de funcionar en todas las sesiones.`, confirmLabel: 'Revocar', danger: true })) return;
        await api(`/api/series/${encodeURIComponent(state.activeSeriesId)}/accesses/${encodeURIComponent(access.id)}`, { method: 'DELETE' }); await loadSeriesAccesses(); notice('Acceso revocado.');
      }, access, 'danger compact'));
    } else actions.append(meetingAction('Regenerar', async () => {
      const result = await api(`/api/series/${encodeURIComponent(state.activeSeriesId)}/accesses/${encodeURIComponent(access.id)}/regenerate`, { method: 'POST', body: {} }); showSeriesShare(result.access); await loadSeriesAccesses(); notice('Se generó un nuevo enlace individual.');
    }, access, 'secondary compact'));
    row.append(info, actions); container.appendChild(row);
  }
}

async function loadSeriesAccesses() {
  const data = await api(`/api/series/${encodeURIComponent(state.activeSeriesId)}/accesses`);
  const items = data.items || [];
  const general = items.find((access) => access.mode === 'GENERAL' && access.status === 'ACTIVE');
  if (general) showGeneralSeriesShare(general);
  else { state.seriesGeneralShare = null; document.getElementById('seriesGeneralShareResult').hidden = true; }
  renderSeriesAccessList(items.filter((access) => access.mode !== 'GENERAL'));
  return items;
}

async function openSeriesShare(series) {
  state.activeSeriesId = series.id; state.seriesShare = null; state.seriesGeneralShare = null;
  document.getElementById('seriesShareTitle').textContent = series.title;
  document.getElementById('seriesParticipantName').value = ''; document.getElementById('seriesParticipantKey').value = '';
  document.getElementById('seriesShareResult').hidden = true; document.getElementById('seriesGeneralShareResult').hidden = true; document.getElementById('seriesGeneralStatus').textContent = ''; document.getElementById('seriesShareError').textContent = '';
  document.getElementById('seriesShareDialog').showModal();
  try { await loadSeriesAccesses(); } catch (error) { document.getElementById('seriesShareError').textContent = error.message; }
}

async function createGeneralSeriesAccess() {
  const button = document.getElementById('createGeneralSeriesAccess');
  const status = document.getElementById('seriesGeneralStatus');
  document.getElementById('seriesShareError').textContent = '';
  button.disabled = true; button.setAttribute('aria-busy', 'true'); status.textContent = 'Creando o recuperando el enlace general…';
  try {
    const result = await api(`/api/series/${encodeURIComponent(state.activeSeriesId)}/general-access`, { method: 'POST', body: {} });
    showGeneralSeriesShare(result.access, { reveal: true }); status.textContent = 'Enlace general listo.'; await loadSeriesAccesses();
    notice(result.reused ? 'Se recuperó el enlace general existente.' : 'Enlace general creado.');
  } catch (requestError) { status.textContent = ''; showSeriesShareError(requestError.message); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); }
}

async function regenerateGeneralSeriesAccess() {
  const access = state.seriesGeneralShare;
  if (!access) return;
  if (!await askConfirmation({ title: 'Revocar y regenerar enlace general', message: 'El enlace general actual dejará de funcionar para todo el grupo y se creará uno nuevo.', confirmLabel: 'Revocar y regenerar', danger: true })) return;
  const error = document.getElementById('seriesShareError'); error.textContent = '';
  try {
    const result = await api(`/api/series/${encodeURIComponent(state.activeSeriesId)}/accesses/${encodeURIComponent(access.id)}/regenerate`, { method: 'POST', body: {} });
    showGeneralSeriesShare(result.access); await loadSeriesAccesses(); notice('Enlace general revocado y regenerado.');
  } catch (requestError) { error.textContent = requestError.message; }
}

async function createSeriesAccess(event) {
  event.preventDefault();
  try {
    const result = await api(`/api/series/${encodeURIComponent(state.activeSeriesId)}/accesses`, { method: 'POST', body: { participantName: document.getElementById('seriesParticipantName').value.trim(), participantKey: document.getElementById('seriesParticipantKey').value.trim() || undefined } });
    showSeriesShare(result.access); await loadSeriesAccesses(); notice(result.reused ? 'Se recuperó el acceso estable existente.' : 'Acceso estable creado.');
  } catch (error) { document.getElementById('seriesShareError').textContent = error.message; }
}

async function openSeriesAttendance(series) {
  document.getElementById('seriesAttendanceTitle').textContent = `Participantes · ${series.title}`;
  const container = document.getElementById('seriesAttendanceTable'); container.replaceChildren(textElement('p', 'Cargando asistencia…', 'muted'));
  document.getElementById('seriesAttendanceDialog').showModal();
  try {
    const data = await api(`/api/series/${encodeURIComponent(series.id)}/attendance`);
    if (!data.items.length) { container.replaceChildren(emptyState('Aún no hay asistencia confirmada.', 'La asistencia aparece después de una conexión real a LiveKit.')); return; }
    const table = document.createElement('table'); table.className = 'data-table';
    const head = document.createElement('thead'); const headRow = document.createElement('tr'); headRow.appendChild(textElement('th', 'Participante'));
    for (let index = 1; index <= data.totalSessions; index += 1) headRow.appendChild(textElement('th', `Sesión ${index}`)); head.appendChild(headRow);
    const body = document.createElement('tbody');
    for (const person of data.items) {
      const row = document.createElement('tr'); row.appendChild(textElement('td', person.participantName || person.participantKey));
      for (let index = 1; index <= data.totalSessions; index += 1) {
        const record = person.sessions[index]; const minutes = record ? Math.max(1, Math.round(record.accumulatedMs / 60_000)) : 0;
        row.appendChild(textElement('td', record ? `${minutes} min · ${formatDate(record.firstJoinedAt)}` : 'Sin conexión'));
      }
      body.appendChild(row);
    }
    table.append(head, body); container.replaceChildren(table);
  } catch (error) { container.replaceChildren(textElement('p', error.message, 'form-error')); }
}

function openMeetingDialog(meeting = null) {
  const edit = meeting && meeting.id;
  document.getElementById('meetingDialogTitle').textContent = edit ? 'Editar reunión' : 'Nueva reunión';
  document.getElementById('meetingOriginalRoom').value = edit ? meeting.room : '';
  document.getElementById('meetingTitle').value = edit ? meeting.title : '';
  document.getElementById('meetingDescription').value = edit ? meeting.description || '' : '';
  document.getElementById('meetingRoom').value = edit ? meeting.room : '';
  document.getElementById('meetingRoom').disabled = Boolean(edit);
  document.getElementById('meetingTrainer').value = edit ? meeting.trainerName : '';
  document.getElementById('meetingScheduledAt').value = edit ? localDateTimeValue(meeting.scheduledAt) : '';
  document.getElementById('meetingDuration').value = edit ? meeting.durationMinutes : 60;
  document.getElementById('meetingType').value = edit ? meeting.type : 'WEBINAR';
  document.getElementById('meetingCapacity').value = edit ? meeting.capacity : 100;
  document.getElementById('meetingViewerAccess').value = edit ? meeting.viewerAccessMode : 'INVITATION';
  document.getElementById('meetingPanelistAccess').value = edit ? meeting.panelistAccessMode : 'INVITATION';
  const booleanFields = {
    meetingAllowChat: 'allowChat', meetingAllowFiles: 'allowFiles', meetingAllowReactions: 'allowReactions',
    meetingAllowRaiseHand: 'allowRaiseHand', meetingAllowRecording: 'allowRecording', meetingConsent: 'recordingConsentRequired',
    meetingAllowTranscription: 'allowTranscription', meetingTranscriptionConsent: 'transcriptionConsentRequired',
    meetingPanelistTranscript: 'allowPanelistTranscriptAccess',
    meetingPanelistScreen: 'allowPanelistScreenShare', meetingParticipantScreen: 'allowParticipantScreenShare',
    meetingStudentScreen: 'allowStudentScreenShare',
  };
  for (const [id, field] of Object.entries(booleanFields)) {
    const defaultEnabled = ['allowChat', 'allowFiles', 'allowReactions', 'allowRaiseHand', 'allowPanelistScreenShare', 'allowParticipantScreenShare'].includes(field);
    document.getElementById(id).checked = edit ? Boolean(meeting[field]) : defaultEnabled;
  }
  document.getElementById('meetingTranscriptionLanguage').value = edit ? meeting.transcriptionLanguage || 'es' : 'es';
  document.getElementById('meetingTranscriptionRetention').value = edit ? meeting.transcriptionRetentionDays || 90 : 90;
  document.getElementById('meetingTranscriptionConsent').disabled = !document.getElementById('meetingAllowTranscription').checked;
  document.getElementById('meetingPanelistTranscript').disabled = !document.getElementById('meetingAllowTranscription').checked;
  document.getElementById('meetingFormError').textContent = '';
  document.getElementById('meetingDialog').showModal();
  document.getElementById('meetingTitle').focus();
}

async function saveMeeting(event) {
  event.preventDefault();
  const originalRoom = document.getElementById('meetingOriginalRoom').value;
  const scheduledInput = document.getElementById('meetingScheduledAt').value;
  const payload = {
    title: document.getElementById('meetingTitle').value.trim(),
    description: document.getElementById('meetingDescription').value.trim(),
    trainerName: document.getElementById('meetingTrainer').value.trim(),
    scheduledAt: scheduledInput ? new Date(scheduledInput).toISOString() : null,
    durationMinutes: Number(document.getElementById('meetingDuration').value),
    type: document.getElementById('meetingType').value,
    capacity: Number(document.getElementById('meetingCapacity').value),
    viewerAccessMode: document.getElementById('meetingViewerAccess').value,
    panelistAccessMode: document.getElementById('meetingPanelistAccess').value,
    allowChat: document.getElementById('meetingAllowChat').checked,
    allowFiles: document.getElementById('meetingAllowFiles').checked,
    allowReactions: document.getElementById('meetingAllowReactions').checked,
    allowRaiseHand: document.getElementById('meetingAllowRaiseHand').checked,
    allowRecording: document.getElementById('meetingAllowRecording').checked,
    recordingConsentRequired: document.getElementById('meetingConsent').checked,
    allowTranscription: document.getElementById('meetingAllowTranscription').checked,
    transcriptionConsentRequired: document.getElementById('meetingTranscriptionConsent').checked,
    allowPanelistTranscriptAccess: document.getElementById('meetingPanelistTranscript').checked,
    allowPanelistScreenShare: document.getElementById('meetingPanelistScreen').checked,
    allowParticipantScreenShare: document.getElementById('meetingParticipantScreen').checked,
    allowStudentScreenShare: document.getElementById('meetingStudentScreen').checked,
    transcriptionLanguage: document.getElementById('meetingTranscriptionLanguage').value,
    transcriptionRetentionDays: Number(document.getElementById('meetingTranscriptionRetention').value),
  };
  if (!originalRoom) payload.room = document.getElementById('meetingRoom').value.trim() || payload.title;
  const error = document.getElementById('meetingFormError');
  error.textContent = '';
  const invalid = firstInvalidMeetingField();
  if (invalid) {
    error.textContent = invalid.message;
    invalid.input.focus();
    invalid.input.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  try {
    if (originalRoom) await api(`/api/meetings/${encodeURIComponent(originalRoom)}`, { method: 'PATCH', body: payload });
    else await api('/api/meetings', { method: 'POST', body: payload });
    document.getElementById('meetingDialog').close();
    notice(originalRoom ? 'Reunión actualizada.' : 'Reunión creada.');
    await loadMeetings();
  } catch (requestError) {
    error.textContent = requestError.message;
    error.focus();
  }
}

async function meetingTransition(meeting, action) {
  const labels = { cancel: 'Cancelar reunión', archive: 'Archivar reunión', restore: 'Restaurar reunión', complete: 'Completar reunión' };
  if (!await askConfirmation({ title: labels[action] || 'Actualizar reunión', message: `Se actualizará “${meeting.title}”.`, confirmLabel: labels[action] || 'Continuar', danger: action === 'cancel' })) return;
  try {
    await api(`/api/meetings/${encodeURIComponent(meeting.room)}/actions/${action}`, { method: 'POST', body: {} });
    notice('Estado de la reunión actualizado.');
    await loadMeetings();
  } catch (error) { notice(error.message, 'error'); }
}

async function softDeleteMeeting(meeting) {
  if (!await askConfirmation({ title: 'Eliminar reunión', message: `“${meeting.title}” quedará eliminada lógicamente y conservará su historial.`, confirmLabel: 'Eliminar', danger: true })) return;
  try {
    await api(`/api/meetings/${encodeURIComponent(meeting.room)}`, { method: 'DELETE' });
    notice('Reunión eliminada lógicamente.');
    await loadMeetings();
  } catch (error) { notice(error.message, 'error'); }
}

async function duplicateMeeting(meeting) {
  try {
    await api(`/api/meetings/${encodeURIComponent(meeting.room)}/duplicate`, { method: 'POST', body: {} });
    notice('Se creó una copia en borrador.');
    await loadMeetings();
  } catch (error) { notice(error.message, 'error'); }
}

async function createInvitation(meeting, role) {
  const singleUse = ['HOST', 'TEACHER', 'COHOST'].includes(role);
  const data = await api(`/api/meetings/${encodeURIComponent(meeting.room)}/invitations`, {
    method: 'POST', body: { meetingRole: role, singleUse, expiresInMinutes: singleUse ? 720 : 1_440 },
  });
  return data;
}

async function createSimpleMeetingAccess(meeting, kind) {
  const data = await api(`/api/meetings/${encodeURIComponent(meeting.room)}/simple-accesses/${kind}`, { method: 'POST', body: {} });
  return data.access;
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value; input.style.position = 'fixed'; input.style.opacity = '0';
  document.body.appendChild(input); input.select();
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) throw new Error('No se pudo copiar el contenido.');
}

async function openInvitationDialog(meeting, role) {
  try {
    const payload = await createInvitation(meeting, role);
    state.invitation = { ...payload, title: meeting.title, role };
    document.getElementById('invitationDialogTitle').textContent = meeting.title;
    document.getElementById('invitationRole').textContent = `${RATCore.roleLabel(role)} · ${RATCore.roleDescription(meeting.type, role)}`;
    document.getElementById('invitationMessage').value = payload.message;
    document.getElementById('invitationUrl').value = payload.url;
    document.getElementById('shareInvitation').hidden = typeof navigator.share !== 'function';
    document.getElementById('invitationDialog').showModal();
  } catch (error) { notice(error.message, 'error'); }
}

async function openSimpleMeetingAccessDialog(meeting, kind) {
  try {
    const access = await createSimpleMeetingAccess(meeting, kind);
    state.invitation = { ...access, title: meeting.title, role: access.meetingRole };
    document.getElementById('invitationDialogTitle').textContent = meeting.title;
    document.getElementById('invitationRole').textContent = access.kind === 'HOST'
      ? 'Acceso único de anfitrión · reutilizable por varios anfitriones autorizados.'
      : 'Acceso único de participante · reutilizable por todo el grupo con identidades separadas.';
    document.getElementById('invitationMessage').value = access.message;
    document.getElementById('invitationUrl').value = access.url;
    document.getElementById('shareInvitation').hidden = typeof navigator.share !== 'function';
    document.getElementById('invitationDialog').showModal();
  } catch (error) { notice(error.message, 'error'); }
}

async function copyCurrentInvitation(field) {
  if (!state.invitation) return;
  try {
    await copyText(state.invitation[field]);
    notice(field === 'url' ? 'Enlace copiado.' : 'Mensaje de invitación copiado.');
  } catch (error) { notice(error.message, 'error'); }
}

async function shareCurrentInvitation() {
  if (!state.invitation || typeof navigator.share !== 'function') return;
  try {
    await navigator.share({ title: state.invitation.title, text: state.invitation.message });
  } catch (error) { if (error.name !== 'AbortError') notice('No fue posible abrir el menú para compartir.', 'error'); }
}

function openCurrentInvitation() {
  if (!state.invitation?.url) return;
  window.open(state.invitation.url, '_blank', 'noopener,noreferrer');
}

async function launchMeeting(meeting) {
  try {
    const data = await api(`/api/meetings/${encodeURIComponent(meeting.room)}/launch`, { method: 'POST', body: {} });
    window.location.href = data.redirect;
  } catch (error) { notice(error.message, 'error'); }
}

async function loadMeetings() {
  const includeDeleted = state.user?.role === 'ADMIN' && document.getElementById('includeDeleted').checked;
  const includeArchivedSeries = state.user?.role === 'ADMIN' && document.getElementById('includeArchivedSeries')?.checked;
  const [data, seriesData] = await Promise.all([
    api(`/api/meetings${includeDeleted ? '?includeDeleted=true' : ''}`),
    api(`/api/series${includeArchivedSeries ? '?includeArchived=true' : ''}`),
  ]);
  state.meetings = data.items.map(RATCore.normalizeMeeting);
  state.series = (seriesData.items || []).map((series) => ({ ...series, sessions: (series.sessions || []).map(RATCore.normalizeMeeting) }));
  renderMeetings();
  renderTrainingSeries();
  renderCalendar();
  renderUpcoming();
}

function filteredCalendarMeetings() {
  const trainer = document.getElementById('filterTrainer').value.trim().toLowerCase();
  const status = document.getElementById('filterStatus').value;
  const type = document.getElementById('filterType').value;
  const date = document.getElementById('filterDate').value;
  return state.meetings.filter((meeting) =>
    (!trainer || meeting.trainerName.toLowerCase().includes(trainer)) &&
    (!status || meeting.status === status) && (!type || meeting.type === type) &&
    (!date || RATCore.localDateKey(meeting.scheduledAt) === date)
  );
}

function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  if (!grid) return;
  grid.replaceChildren();
  grid.className = `calendar-grid view-${state.calendarView}`;
  const date = new Date(state.calendarDate);
  const calendarDays = RATCore.calendarRange(date, state.calendarView);
  if (state.calendarView === 'month') {
    const label = new Intl.DateTimeFormat('es-EC', { month: 'long', year: 'numeric' }).format(date);
    document.getElementById('calendarLabel').textContent = label.charAt(0).toUpperCase() + label.slice(1);
  } else if (state.calendarView === 'week') {
    const start = calendarDays[0];
    document.getElementById('calendarLabel').textContent = `${start.toLocaleDateString('es-EC')} – ${new Date(start.getTime() + 6 * 86_400_000).toLocaleDateString('es-EC')}`;
  } else {
    const label = new Intl.DateTimeFormat('es-EC', { dateStyle: 'full' }).format(date);
    document.getElementById('calendarLabel').textContent = label.charAt(0).toUpperCase() + label.slice(1);
  }
  const items = filteredCalendarMeetings();
  for (const day of calendarDays) {
    const isoDay = RATCore.localDateKey(day);
    const cell = document.createElement('article');
    cell.className = 'calendar-day';
    cell.setAttribute('aria-label', new Intl.DateTimeFormat('es-EC', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(day));
    if (state.calendarView === 'month' && day.getMonth() !== date.getMonth()) cell.classList.add('adjacent-month');
    if (isoDay === RATCore.localDateKey(new Date())) { cell.classList.add('today'); cell.setAttribute('aria-current', 'date'); }
    cell.appendChild(textElement('h3', new Intl.DateTimeFormat('es-EC', { weekday: 'short', day: 'numeric', month: calendarDays.length === 1 ? 'long' : undefined }).format(day)));
    const dayMeetings = RATCore.meetingsForLocalDay(items, day);
    if (!dayMeetings.length) cell.appendChild(textElement('span', 'Sin reuniones', 'muted calendar-empty'));
    const visibleMeetings = state.calendarView === 'month' ? dayMeetings.slice(0, 3) : dayMeetings;
    for (const meeting of visibleMeetings) {
      const event = document.createElement('button');
      event.type = 'button';
      event.className = `calendar-event status-${meeting.status.toLowerCase()} ${meeting.seriesId ? 'calendar-event-series' : 'calendar-event-meeting'}`;
      const meetingDate = RATCore.validDate(meeting.scheduledAt);
      event.setAttribute('aria-label', `${meeting.title}, ${STATUS_LABELS[meeting.status] || 'Programada'}, ${meetingDate ? meetingDate.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }) : 'hora por definir'}`);
      const time = meetingDate ? meetingDate.toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }) : 'Sin hora';
      const kind = meeting.seriesId ? 'Sesión de capacitación' : 'Reunión';
      event.append(textElement('strong', state.calendarView === 'month' ? `${time} — ${meeting.title}` : meeting.title), textElement('span', state.calendarView === 'month' ? `${kind} · ${STATUS_LABELS[meeting.status]}` : `${time} · ${kind} · ${meeting.trainerName} · ${STATUS_LABELS[meeting.status]}`));
      event.addEventListener('click', () => openMeetingDialog(meeting));
      cell.appendChild(event);
    }
    if (state.calendarView === 'month' && dayMeetings.length > visibleMeetings.length) cell.appendChild(textElement('span', `+${dayMeetings.length - visibleMeetings.length} más`, 'calendar-more'));
    grid.appendChild(cell);
  }
}

function renderUpcoming() {
  const container = document.getElementById('upcomingList');
  container.replaceChildren();
  const next = RATCore.upcomingMeetings(state.meetings, new Date(), 5);
  if (!next.length) return container.appendChild(textElement('p', 'No hay reuniones próximas.', 'empty-state'));
  for (const meeting of next) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'compact-list-item';
    row.append(textElement('strong', meeting.title), textElement('span', `${fmtDate.format(new Date(meeting.scheduledAt))} · ${meeting.trainerName} · ${STATUS_LABELS[meeting.status]}`), textElement('span', 'Ver reunión', 'quick-action'));
    row.addEventListener('click', () => { showSection('meetings'); openMeetingDialog(meeting); });
    container.appendChild(row);
  }
}

function summaryCard(label, value, detail) {
  const card = document.createElement('article'); card.className = 'summary-card';
  card.append(textElement('span', label, 'summary-label'), textElement('strong', String(value ?? '—')), textElement('small', detail || ''));
  return card;
}

function serviceLabel(value) {
  const mode = typeof value === 'object' ? value?.mode : value;
  return ({ configured: 'Configurado', filesystem: 'Archivos de desarrollo', s3: 'S3/R2', disabled: 'Deshabilitado' })[mode] || String(mode || 'No disponible');
}

async function loadSummary() {
  const data = await api('/api/dashboard/summary');
  state.summary = data;
  const cards = document.getElementById('summaryCards'); cards.replaceChildren(
    summaryCard('Reuniones de hoy', data.meetingsToday, 'programadas'),
    summaryCard('Reuniones activas', data.activeMeetings, 'en vivo ahora'),
    summaryCard('Próxima capacitación', data.nextMeeting ? (RATCore.validDate(data.nextMeeting.scheduledAt)?.toLocaleDateString('es-EC') || 'Fecha por definir') : '—', data.nextMeeting?.title || 'No hay reuniones próximas'),
    summaryCard('Credenciales activas', state.user.role === 'ADMIN' ? data.activeCredentials : '—', state.user.role === 'ADMIN' ? 'usuarios habilitados' : 'Visible para administradores'),
    summaryCard('Intentos fallidos de acceso', data.recentErrors, data.recentErrors === null ? 'Visible para administradores' : 'últimas 24 horas')
  );
  const services = document.getElementById('serviceStatus'); services.replaceChildren();
  const livekitLabel = `${data.livekit?.mode === 'local' ? 'Desarrollo' : 'Remoto'} — ${data.livekit?.available ? 'disponible' : 'no disponible'}`;
  const recordingLabel = data.recordingAvailable ? 'Disponible' : data.recordingConfigured ? 'No disponible' : 'Deshabilitada';
  const transcriptionLabel = data.transcriptionAvailable ? 'Disponible' : data.transcriptionConfigured ? 'No disponible' : 'Deshabilitada';
  for (const [name, value, stateName] of [['Almacenamiento', `${serviceLabel(data.storage)} — ${data.storage?.available ? 'disponible' : 'no disponible'}`, data.storage?.available ? 'available' : 'unavailable'], ['LiveKit', livekitLabel, data.livekit?.available ? 'available' : 'unavailable'], ['Grabación', recordingLabel, data.recordingAvailable ? 'available' : data.recordingConfigured ? 'unavailable' : 'disabled'], ['Transcripción', transcriptionLabel, data.transcriptionAvailable ? 'available' : data.transcriptionConfigured ? 'unavailable' : 'disabled']]) {
    const row = document.createElement('div'); row.className = `service-row service-${stateName}`; row.append(textElement('span', name), textElement('strong', value)); services.appendChild(row);
  }
  const settings = document.getElementById('settingsIntegrations'); settings.replaceChildren();
  const environment = String(data.environment || 'development').toLowerCase();
  const provider = String(data.transcriptionProvider || '').toLowerCase();
  const rows = [
    ['Aplicación', data.app?.name || 'R.A. Training Streaming'], ['Entorno', data.displayEnvironment || ENVIRONMENT_LABELS[environment] || 'Desarrollo'],
    ['Almacenamiento', `${serviceLabel(data.storage)} · ${data.storage?.available ? 'Disponible' : 'No disponible'}`], ['LiveKit · modo', data.livekit?.mode === 'local' ? 'Desarrollo' : 'Remoto'], ['LiveKit · estado', data.livekit?.available ? 'Disponible' : 'No disponible · revisa la integración'], ['Grabación', recordingLabel],
    ['Transcripción', data.transcriptionConfigured ? `${transcriptionLabel} · ${PROVIDER_LABELS[provider] || 'Proveedor externo'}` : 'Deshabilitada'],
    ['Cookies seguras', data.security?.secureCookies ? 'Activadas' : 'Solo desarrollo local'], ['Salas abiertas de desarrollo', data.security?.openDevRooms ? 'Activadas' : 'Desactivadas'],
    ['Versión', data.version || 'Sin identificar'], ['Última comprobación', data.livekit?.checkedAt ? formatDate(data.livekit.checkedAt) : 'No disponible'], ['Configuración pendiente', data.missingConfiguration?.length ? data.missingConfiguration.join(', ') : 'Ninguna'],
  ];
  for (const [label, value] of rows) { const row = document.createElement('div'); row.append(textElement('span', label), textElement('strong', value)); settings.appendChild(row); }
}

function userActions(user) {
  const wrap = document.createElement('div'); wrap.className = 'table-actions';
  if (user.bootstrap) {
    wrap.appendChild(textElement('span', 'Gestionado por entorno', 'muted small'));
    return wrap;
  }
  wrap.appendChild(meetingAction('Editar', () => openUserDialog(user), user));
  const menu = document.createElement('details'); menu.className = 'action-menu'; const summary = document.createElement('summary'); summary.textContent = 'Más acciones';
  const items = document.createElement('div'); items.className = 'action-menu-items'; items.append(meetingAction('Cambiar contraseña', () => resetUserPassword(user), user), meetingAction(user.active ? 'Desactivar' : 'Activar', () => toggleUser(user), user), meetingAction('Revocar sesiones', () => revokeUserSessions(user), user), meetingAction('Eliminar', () => deleteUser(user), user, 'danger compact'));
  menu.append(summary, items); wrap.appendChild(menu);
  return wrap;
}

async function loadUsers() {
  const data = await api('/api/auth/users'); state.users = data.users;
  const tbody = document.getElementById('usersTable'); tbody.replaceChildren();
  for (const user of data.users) {
    const row = document.createElement('tr');
    const values = [user.username, ROLE_LABELS[user.role] || 'Usuario', user.active ? 'Activo' : 'Inactivo', user.createdAt ? fmtDate.format(new Date(user.createdAt)) : 'Entorno', user.lastLoginAt ? fmtDate.format(new Date(user.lastLoginAt)) : 'Nunca'];
    const labels = ['Usuario', 'Rol', 'Estado', 'Creado', 'Último acceso'];
    values.forEach((value, index) => { const cell = textElement('td', value); cell.dataset.label = labels[index]; row.appendChild(cell); });
    const actions = document.createElement('td'); actions.dataset.label = 'Acciones'; actions.appendChild(userActions(user)); row.appendChild(actions); tbody.appendChild(row);
  }
}

function openUserDialog(user = null) {
  document.getElementById('userDialogTitle').textContent = user ? 'Editar usuario' : 'Nuevo usuario';
  document.getElementById('userOriginalUsername').value = user?.username || '';
  document.getElementById('userUsername').value = user?.username || '';
  document.getElementById('userUsername').disabled = Boolean(user);
  document.getElementById('userRole').value = user?.role || 'ORGANIZER';
  document.getElementById('userActive').checked = user ? user.active : true;
  document.getElementById('userPasswordLabel').hidden = Boolean(user);
  document.getElementById('userPasswordConfirmLabel').hidden = Boolean(user);
  document.getElementById('userPassword').required = !user;
  document.getElementById('userPasswordConfirm').required = !user;
  document.getElementById('userPassword').value = '';
  document.getElementById('userPasswordConfirm').value = '';
  document.getElementById('userPasswordMatch').textContent = '';
  document.getElementById('userPassword').type = 'password';
  RATPasswordToggle.sync(document.getElementById('userDialog'));
  document.getElementById('userFormError').textContent = '';
  document.getElementById('userDialog').showModal();
}

async function saveUser(event) {
  event.preventDefault();
  const original = document.getElementById('userOriginalUsername').value;
  const error = document.getElementById('userFormError'); error.textContent = '';
  try {
    if (original) {
      await api(`/api/auth/users/${encodeURIComponent(original)}`, { method: 'PATCH', body: { role: document.getElementById('userRole').value, active: document.getElementById('userActive').checked } });
    } else {
      if (document.getElementById('userPassword').value !== document.getElementById('userPasswordConfirm').value) throw new Error('Las contraseñas no coinciden.');
      await api('/api/auth/users', { method: 'POST', body: { username: document.getElementById('userUsername').value.trim(), password: document.getElementById('userPassword').value, role: document.getElementById('userRole').value, active: document.getElementById('userActive').checked } });
    }
    document.getElementById('userDialog').close(); notice('Usuario guardado.'); await loadUsers();
  } catch (requestError) { error.textContent = requestError.message; }
}

async function resetUserPassword(user) {
  const password = await requestPassword(user.username);
  if (!password) return;
  try { await api(`/api/auth/users/${encodeURIComponent(user.username)}/password`, { method: 'POST', body: { password } }); notice('Contraseña cambiada y sesiones revocadas.'); await loadUsers(); } catch (error) { notice(error.message, 'error'); }
}
async function toggleUser(user) {
  if (!await askConfirmation({ title: user.active ? 'Desactivar usuario' : 'Activar usuario', message: `${user.username} ${user.active ? 'perderá acceso y sus sesiones serán revocadas' : 'recuperará el acceso'}.`, confirmLabel: user.active ? 'Desactivar' : 'Activar', danger: user.active })) return;
  try { await api(`/api/auth/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', body: { active: !user.active, role: user.role } }); notice('Estado actualizado.'); await loadUsers(); } catch (error) { notice(error.message, 'error'); }
}
async function revokeUserSessions(user) {
  if (!await askConfirmation({ title: 'Revocar sesiones', message: `${user.username} tendrá que iniciar sesión nuevamente en todos sus dispositivos.`, confirmLabel: 'Revocar sesiones', danger: true })) return;
  try { await api(`/api/auth/users/${encodeURIComponent(user.username)}/revoke-sessions`, { method: 'POST', body: {} }); notice('Sesiones revocadas.'); await loadUsers(); } catch (error) { notice(error.message, 'error'); }
}
async function deleteUser(user) {
  if (!await askConfirmation({ title: 'Eliminar usuario', message: `Se eliminará de forma segura a ${user.username}. Su contraseña no puede recuperarse.`, confirmLabel: 'Eliminar', danger: true })) return;
  try { await api(`/api/auth/users/${encodeURIComponent(user.username)}`, { method: 'DELETE' }); notice('Usuario eliminado.'); await loadUsers(); } catch (error) { notice(error.message, 'error'); }
}

async function loadRecordings() {
  const container = document.getElementById('recordingsList'); container.replaceChildren(textElement('p', 'Cargando…', 'muted'));
  const room = document.getElementById('recordingRoomFilter').value.trim();
  try {
    const data = await api(`/api/recordings${room ? `?room=${encodeURIComponent(room)}` : ''}`);
    state.recordings = data.items;
    container.replaceChildren();
    renderMeetings();
    if (!data.items.length) return container.appendChild(emptyState('No hay grabaciones disponibles.', 'Cuando una grabación termine de procesarse aparecerá aquí.'));
    for (const item of data.items) {
      const row = document.createElement('article'); row.className = 'recording-card';
      const thumbnail = document.createElement('div'); thumbnail.className = 'recording-thumb'; thumbnail.setAttribute('aria-hidden', 'true'); thumbnail.textContent = '▶';
      const info = document.createElement('div'); info.append(textElement('h2', item.title || 'Reunión sin título'), textElement('p', `${item.trainerName || 'Capacitador por definir'} · ${formatDate(item.lastModified)}`, 'muted'), textElement('p', `${(Number(item.size || 0) / 1024 / 1024).toFixed(1)} MB · Lista`, 'small'));
      if (item.transcript) info.appendChild(textElement('p', TRANSCRIPT_STATUS_LABELS[item.transcript.status] || 'Estado de transcripción no disponible', 'small transcript-recording-state'));
      const actions = document.createElement('div'); actions.className = 'meeting-actions';
      if (item.key) {
        actions.append(
          meetingAction('Abrir', () => openRecording(item, false), item, 'secondary compact'),
          meetingAction('Descargar', () => openRecording(item, true), item, 'secondary compact')
        );
      }
      const meeting = state.meetings.find((entry) => entry.id === item.meetingId);
      if (item.transcript) {
        const transcript = document.createElement('a'); transcript.href = `/transcription.html?id=${encodeURIComponent(item.transcript.id)}`; transcript.className = 'button primary compact'; transcript.textContent = 'Ver transcripción'; actions.appendChild(transcript);
        transcript.textContent = ['FAILED', 'CANCELLED'].includes(item.transcript.status) ? 'Revisar y reintentar' : ['COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(item.transcript.status) ? 'Ver transcripción' : 'Ver proceso';
      } else if (item.transcriptionAllowed && meeting) actions.append(meetingAction('Transcribir', () => startTranscription(meeting, item), item, 'primary compact'));
      if (state.user.role === 'ADMIN') actions.appendChild(meetingAction('Eliminar', async () => {
        if (!await askConfirmation({ title: 'Eliminar grabación', message: `La grabación de “${item.title}” se eliminará permanentemente.`, confirmLabel: 'Eliminar', danger: true })) return;
        try { await api('/api/recordings', { method: 'DELETE', body: { key: item.key } }); notice('Grabación eliminada.'); await loadRecordings(); } catch (error) { notice(error.message, 'error'); }
      }, item, 'danger compact'));
      row.append(thumbnail, info, actions); container.appendChild(row);
    }
  } catch (error) {
    state.recordings = [];
    renderMeetings();
    if (error.code === 'STORAGE_NOT_CONFIGURED') {
      const empty = emptyState('Las grabaciones no están disponibles en este entorno.', 'Revisa el estado de almacenamiento y grabación en Configuración.');
      const actions = document.createElement('div'); actions.className = 'dialog-actions';
      const settings = document.createElement('a'); settings.className = 'button secondary compact'; settings.href = '#settings'; settings.textContent = 'Ver configuración'; settings.addEventListener('click', () => showSection('settings'));
      const guide = document.createElement('a'); guide.className = 'button secondary compact'; guide.href = '/docs/LOCAL_DEVELOPMENT.md'; guide.target = '_blank'; guide.rel = 'noopener'; guide.textContent = 'Consultar guía';
      actions.append(settings, guide); empty.appendChild(actions); container.replaceChildren(empty);
    }
    else container.replaceChildren(textElement('p', error.message, 'form-error'));
  }
}

async function openRecording(item, download = false) {
  const popup = window.open('', '_blank', 'noopener,noreferrer');
  try {
    const data = await api(`/api/recordings/download?key=${encodeURIComponent(item.key)}`);
    if (!data.url) throw new Error('No se recibió un enlace temporal de descarga.');
    if (popup) popup.location.href = data.url;
    else window.location.href = data.url;
    notice(download ? 'Enlace temporal de descarga preparado.' : 'Grabación abierta en otra pestaña.');
  } catch (error) {
    if (popup) popup.close();
    notice(error.message, 'error');
  }
}

async function loadAudit() {
  const actor = document.getElementById('auditActorFilter').value.trim();
  const actionInput = document.getElementById('auditActionFilter').value.trim();
  const action = Object.entries(AUDIT_LABELS).find(([code, label]) => code === actionInput.toUpperCase() || label.toLowerCase() === actionInput.toLowerCase())?.[0] || actionInput;
  const room = document.getElementById('auditRoomFilter').value.trim();
  const date = document.getElementById('auditDateFilter').value;
  const query = new URLSearchParams({ limit: '100' });
  if (actor) query.set('actor', actor);
  if (action) query.set('action', action);
  if (room) query.set('room', room);
  const data = await api(`/api/audit?${query}`);
  const tbody = document.getElementById('auditTable'); tbody.replaceChildren();
  const items = date ? data.items.filter((item) => RATCore.localDateKey(item.timestamp) === date) : data.items;
  if (!items.length) {
    const row = document.createElement('tr'); const cell = textElement('td', 'No hay eventos que coincidan con los filtros.', 'muted'); cell.colSpan = 5; row.appendChild(cell); tbody.appendChild(row); return;
  }
  for (const item of items) {
    const row = document.createElement('tr');
    const actionCell = document.createElement('td'); actionCell.append(textElement('span', AUDIT_LABELS[item.action] || 'Acción del sistema'));
    const details = document.createElement('details'); details.className = 'technical-detail'; const summary = document.createElement('summary'); summary.textContent = 'Código técnico'; details.append(summary, textElement('code', item.action)); actionCell.appendChild(details);
    for (const value of [formatDate(item.timestamp), item.actor || 'Sistema']) row.appendChild(textElement('td', value));
    row.appendChild(actionCell);
    const meeting = state.meetings.find((entry) => entry.id === item.target || entry.room === item.room);
    const targetCell = document.createElement('td'); targetCell.appendChild(textElement('span', meeting?.title || item.target || '—'));
    if (meeting && item.target) { const technical = document.createElement('details'); technical.className = 'technical-detail'; const heading = document.createElement('summary'); heading.textContent = 'Detalles técnicos'; technical.append(heading, textElement('code', item.target)); targetCell.appendChild(technical); }
    row.append(targetCell, textElement('td', item.room || '—'));
    tbody.appendChild(row);
  }
}

function bindDialog(dialog, closeSelector) {
  dialog.querySelectorAll(closeSelector).forEach((button) => button.addEventListener('click', () => dialog.close()));
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') dialog.close();
    if (event.key !== 'Tab') return;
    const focusable = [...dialog.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled])')];
    if (!focusable.length) return;
    const first = focusable[0]; const last = focusable.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  });
}

async function initialize() {
  try {
    const me = await api('/api/auth/me'); state.user = me.user; state.csrf = me.csrfToken;
    document.getElementById('currentUser').textContent = me.user.username;
    document.getElementById('currentRole').textContent = ROLE_LABELS[me.user.role] || 'Usuario';
    document.querySelectorAll('.admin-only').forEach((element) => { element.hidden = me.user.role !== 'ADMIN'; });
    for (const status of Object.keys(STATUS_LABELS)) {
      if (status !== 'ACTIVE') {
        document.getElementById('meetingStatusFilter').appendChild(new Option(STATUS_LABELS[status], status));
        document.getElementById('filterStatus').appendChild(new Option(STATUS_LABELS[status], status));
      }
      document.getElementById('seriesStatusFilter').appendChild(new Option(STATUS_LABELS[status], status));
    }
    for (const type of Object.keys(TYPE_LABELS)) document.getElementById('filterType').appendChild(new Option(TYPE_LABELS[type], type));
    await Promise.all([loadMeetings(), loadSummary()]);
    await loadRecordings();
    const requestedSection = location.hash.slice(1) === 'calendar' ? 'agenda' : location.hash.slice(1);
    if (document.querySelector(`[data-section="${CSS.escape(requestedSection)}"]`)) showSection(requestedSection);
  } catch (error) { notice(error.message, 'error'); }
}

document.getElementById('dashboardNav').addEventListener('click', (event) => { const button = event.target.closest('[data-section]'); if (button) showSection(button.dataset.section); });
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => showSection(button.dataset.go)));
document.querySelectorAll('[data-open-meeting]').forEach((button) => button.addEventListener('click', () => openMeetingDialog()));
document.querySelectorAll('[data-open-series]').forEach((button) => button.addEventListener('click', () => openSeriesDialog()));
document.getElementById('meetingForm').addEventListener('submit', saveMeeting);
document.getElementById('seriesForm').addEventListener('submit', saveSeries);
document.getElementById('seriesShareForm').addEventListener('submit', createSeriesAccess);
document.getElementById('createGeneralSeriesAccess').addEventListener('click', createGeneralSeriesAccess);
document.getElementById('regenerateGeneralSeriesAccess').addEventListener('click', regenerateGeneralSeriesAccess);
document.getElementById('addSeriesSession').addEventListener('click', () => addSeriesSession());
document.querySelectorAll('[data-copy-series]').forEach((button) => button.addEventListener('click', async () => {
  if (!state.seriesShare?.[button.dataset.copySeries]) return;
  try { await copyText(state.seriesShare[button.dataset.copySeries]); notice('Contenido copiado.'); } catch (error) { notice(error.message, 'error'); }
}));
document.querySelectorAll('[data-copy-series-general]').forEach((button) => button.addEventListener('click', async () => {
  if (!state.seriesGeneralShare?.[button.dataset.copySeriesGeneral]) return;
  try { await copyText(state.seriesGeneralShare[button.dataset.copySeriesGeneral]); notice('Contenido copiado.'); } catch (error) { notice(error.message, 'error'); }
}));
document.getElementById('seriesWhatsApp').addEventListener('click', () => { if (state.seriesShare?.whatsappUrl) window.open(state.seriesShare.whatsappUrl, '_blank', 'noopener,noreferrer'); });
document.getElementById('userForm').addEventListener('submit', saveUser);
document.getElementById('openUserModal').addEventListener('click', () => openUserDialog());
document.getElementById('loadRecordings').addEventListener('click', loadRecordings);
document.getElementById('refreshAudit').addEventListener('click', loadAudit);
document.getElementById('refreshSettings').addEventListener('click', async () => { try { await loadSummary(); notice('Estado de integraciones actualizado.'); } catch (error) { notice(error.message, 'error'); } });
document.getElementById('copyInvitationLink').addEventListener('click', () => copyCurrentInvitation('url'));
document.getElementById('copyInvitationMessage').addEventListener('click', () => copyCurrentInvitation('message'));
document.getElementById('shareInvitation').addEventListener('click', shareCurrentInvitation);
document.getElementById('openInvitationLink').addEventListener('click', openCurrentInvitation);
document.getElementById('shareInvitationWhatsApp').addEventListener('click', () => {
  if (state.invitation?.whatsappUrl) window.open(state.invitation.whatsappUrl, '_blank', 'noopener,noreferrer');
});
for (const id of ['auditDateFilter', 'auditActorFilter', 'auditActionFilter', 'auditRoomFilter']) document.getElementById(id).addEventListener('change', loadAudit);
document.getElementById('meetingSearch').addEventListener('input', renderMeetings);
document.getElementById('meetingStatusFilter').addEventListener('change', renderMeetings);
document.getElementById('includeDeleted').addEventListener('change', loadMeetings);
document.getElementById('seriesSearch').addEventListener('input', renderTrainingSeries);
document.getElementById('seriesStatusFilter').addEventListener('change', renderTrainingSeries);
document.getElementById('includeArchivedSeries').addEventListener('change', loadMeetings);
for (const id of ['filterTrainer', 'filterStatus', 'filterType', 'filterDate']) document.getElementById(id).addEventListener('input', renderCalendar);
document.querySelectorAll('[data-calendar-view]').forEach((button) => button.addEventListener('click', () => { state.calendarView = button.dataset.calendarView; document.querySelectorAll('[data-calendar-view]').forEach((item) => item.classList.toggle('active', item === button)); renderCalendar(); }));
document.getElementById('calendarPrev').addEventListener('click', () => { const amount = state.calendarView === 'month' ? -1 : state.calendarView === 'week' ? -7 : -1; if (state.calendarView === 'month') state.calendarDate.setMonth(state.calendarDate.getMonth() + amount); else state.calendarDate.setDate(state.calendarDate.getDate() + amount); renderCalendar(); });
document.getElementById('calendarNext').addEventListener('click', () => { const amount = state.calendarView === 'month' ? 1 : state.calendarView === 'week' ? 7 : 1; if (state.calendarView === 'month') state.calendarDate.setMonth(state.calendarDate.getMonth() + amount); else state.calendarDate.setDate(state.calendarDate.getDate() + amount); renderCalendar(); });
document.getElementById('calendarToday').addEventListener('click', () => { state.calendarDate = new Date(); renderCalendar(); });
function closeSidebar() { document.getElementById('dashboardSidebar').classList.remove('open'); document.getElementById('sidebarOverlay').classList.remove('visible'); document.getElementById('sidebarOverlay').setAttribute('aria-hidden', 'true'); document.getElementById('menuToggle').setAttribute('aria-expanded', 'false'); }
document.getElementById('menuToggle').addEventListener('click', () => { const sidebar = document.getElementById('dashboardSidebar'); const open = sidebar.classList.toggle('open'); document.getElementById('sidebarOverlay').classList.toggle('visible', open); document.getElementById('sidebarOverlay').setAttribute('aria-hidden', String(!open)); document.getElementById('menuToggle').setAttribute('aria-expanded', String(open)); if (open) sidebar.querySelector('button:not([hidden])')?.focus(); });
document.getElementById('sidebarOverlay').addEventListener('click', closeSidebar);
document.addEventListener('click', (event) => {
  const summary = event.target.closest('.action-menu > summary');
  if (summary) {
    const menu = summary.parentElement;
    closeActionMenus({ except: menu });
    window.requestAnimationFrame(() => {
      if (menu.open) positionActionMenu(menu);
      else {
        menu.classList.remove('opens-up', 'opens-down');
        menu.closest('.training-series-card, .meeting-card, .recording-card')?.classList.remove('menu-open');
      }
    });
    return;
  }
  if (!event.target.closest('.action-menu')) closeActionMenus();
});
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  const hadOpenMenu = openActionMenus().length > 0;
  closeActionMenus({ restoreFocus: hadOpenMenu });
  if (!hadOpenMenu) { closeSidebar(); document.getElementById('menuToggle').focus(); }
});
window.addEventListener('resize', () => openActionMenus().forEach(positionActionMenu));
document.getElementById('dashboardMain').addEventListener('scroll', () => openActionMenus().forEach(positionActionMenu), { passive: true });
window.addEventListener('offline', () => notice('Parece que no tienes conexión. Algunas acciones pueden fallar hasta reconectarte.', 'error'));
window.addEventListener('online', () => notice('Conexión restaurada.'));
for (const id of ['userPassword', 'userPasswordConfirm']) document.getElementById(id).addEventListener('input', () => { const password = document.getElementById('userPassword').value; const confirmation = document.getElementById('userPasswordConfirm').value; const match = document.getElementById('userPasswordMatch'); match.textContent = confirmation ? (password === confirmation ? 'Las contraseñas coinciden.' : 'Las contraseñas no coinciden.') : ''; match.className = `password-match ${password === confirmation ? 'matches' : 'mismatch'}`; });
document.getElementById('logoutButton').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } finally { window.location.replace('/index.html'); } });
bindDialog(document.getElementById('meetingDialog'), '[data-close-dialog]');
bindDialog(document.getElementById('seriesDialog'), '[data-close-series]');
bindDialog(document.getElementById('seriesShareDialog'), '[data-close-series-share]');
bindDialog(document.getElementById('seriesAttendanceDialog'), '[data-close-series-attendance]');
bindDialog(document.getElementById('userDialog'), '[data-close-user]');
bindDialog(document.getElementById('invitationDialog'), '[data-close-invitation]');
document.getElementById('meetingAllowTranscription').addEventListener('change', (event) => {
  document.getElementById('meetingTranscriptionConsent').disabled = !event.target.checked;
  document.getElementById('meetingPanelistTranscript').disabled = !event.target.checked;
});

initialize();
