renderBrand(document.getElementById('brand'), { tagline: false });

const state = {
  user: null,
  csrf: '',
  meetings: [],
  users: [],
  calendarDate: new Date(),
  calendarView: 'month',
};

const STATUS_LABELS = {
  DRAFT: 'Borrador', SCHEDULED: 'Programada', LIVE: 'En vivo', COMPLETED: 'Completada',
  CANCELLED: 'Cancelada', ARCHIVED: 'Archivada',
};
const TYPE_LABELS = { WEBINAR: 'Webinar', SESSION: 'Sesión', CLASS: 'Clase' };
const fmtDate = new Intl.DateTimeFormat('es-EC', { dateStyle: 'medium', timeStyle: 'short' });

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
  if (!response.ok) throw new Error(data.error || 'No fue posible completar la solicitud');
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

function showSection(name) {
  document.querySelectorAll('[data-section-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.sectionPanel === name));
  document.querySelectorAll('[data-section]').forEach((button) => {
    const active = button.dataset.section === name;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'page');
    else button.removeAttribute('aria-current');
  });
  document.getElementById('dashboardSidebar').classList.remove('open');
  document.getElementById('menuToggle').setAttribute('aria-expanded', 'false');
  if (name === 'recordings') loadRecordings();
  if (name === 'users' && state.user.role === 'ADMIN') loadUsers();
  if (name === 'audit' && state.user.role === 'ADMIN') loadAudit();
  if (name === 'calendar') renderCalendar();
}

function textElement(tag, text, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = text;
  return element;
}

function statusPill(status) {
  const pill = textElement('span', STATUS_LABELS[status] || status, `status-pill status-${String(status).toLowerCase()}`);
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
  button.addEventListener('click', () => action(meeting));
  return button;
}

function renderMeetings() {
  const list = document.getElementById('meetingsList');
  list.replaceChildren();
  const filtered = state.meetings.filter(meetingMatchesFilters);
  if (!filtered.length) {
    list.appendChild(textElement('p', 'No hay reuniones que coincidan con los filtros.', 'empty-state'));
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
      textElement('p', meeting.description || 'Sin descripción', 'muted clamp'),
      textElement('p', `${meeting.trainerName} · ${TYPE_LABELS[meeting.type] || meeting.type} · ${meeting.durationMinutes} min`, 'meeting-meta'),
      textElement('p', meeting.scheduledAt ? fmtDate.format(new Date(meeting.scheduledAt)) : 'Sin fecha programada', 'meeting-time'),
      textElement('p', `Sala: ${meeting.room} · Capacidad: ${meeting.capacity}`, 'muted small')
    );
    const actions = document.createElement('div');
    actions.className = 'meeting-actions';
    if (!meeting.deletedAt) {
      actions.append(
        meetingAction('Editar', openMeetingDialog, meeting),
        meetingAction('Panelista', (item) => copyInvitation(item, 'PANELIST'), meeting),
        meetingAction('Asistente', (item) => copyInvitation(item, 'VIEWER'), meeting),
        meetingAction('WhatsApp', (item) => shareWhatsApp(item), meeting),
        meetingAction('Duplicar', duplicateMeeting, meeting)
      );
      if (!['CANCELLED', 'ARCHIVED', 'COMPLETED'].includes(meeting.status)) {
        actions.append(meetingAction(meeting.status === 'LIVE' ? 'Abrir sala' : 'Iniciar', launchMeeting, meeting, 'primary compact'));
      }
      if (!['CANCELLED', 'COMPLETED', 'ARCHIVED'].includes(meeting.status)) actions.append(meetingAction('Cancelar', (item) => meetingTransition(item, 'cancel'), meeting));
      if (meeting.status !== 'ARCHIVED') actions.append(meetingAction('Archivar', (item) => meetingTransition(item, 'archive'), meeting));
      if (state.user.role === 'ADMIN') actions.append(meetingAction('Eliminar', softDeleteMeeting, meeting, 'danger compact'));
    } else {
      actions.append(meetingAction('Restaurar', (item) => meetingTransition(item, 'restore'), meeting, 'primary compact'));
    }
    card.append(main, actions);
    list.appendChild(card);
  }
}

function localDateTimeValue(value) {
  if (!value) return '';
  const date = new Date(value);
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
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
  document.getElementById('meetingStatus').value = edit ? meeting.status : 'DRAFT';
  document.getElementById('meetingCapacity').value = edit ? meeting.capacity : 500;
  document.getElementById('meetingViewerAccess').value = edit ? meeting.viewerAccessMode : 'INVITATION';
  document.getElementById('meetingPanelistAccess').value = edit ? meeting.panelistAccessMode : 'INVITATION';
  for (const [id, field] of Object.entries({
    meetingAllowChat: 'allowChat', meetingAllowFiles: 'allowFiles', meetingAllowReactions: 'allowReactions',
    meetingAllowRaiseHand: 'allowRaiseHand', meetingAllowRecording: 'allowRecording', meetingConsent: 'recordingConsentRequired',
  })) document.getElementById(id).checked = edit ? meeting[field] : true;
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
    status: document.getElementById('meetingStatus').value,
    capacity: Number(document.getElementById('meetingCapacity').value),
    viewerAccessMode: document.getElementById('meetingViewerAccess').value,
    panelistAccessMode: document.getElementById('meetingPanelistAccess').value,
    allowChat: document.getElementById('meetingAllowChat').checked,
    allowFiles: document.getElementById('meetingAllowFiles').checked,
    allowReactions: document.getElementById('meetingAllowReactions').checked,
    allowRaiseHand: document.getElementById('meetingAllowRaiseHand').checked,
    allowRecording: document.getElementById('meetingAllowRecording').checked,
    recordingConsentRequired: document.getElementById('meetingConsent').checked,
  };
  if (!originalRoom) payload.room = document.getElementById('meetingRoom').value.trim() || payload.title;
  const error = document.getElementById('meetingFormError');
  error.textContent = '';
  try {
    if (originalRoom) await api(`/api/meetings/${encodeURIComponent(originalRoom)}`, { method: 'PATCH', body: payload });
    else await api('/api/meetings', { method: 'POST', body: payload });
    document.getElementById('meetingDialog').close();
    notice(originalRoom ? 'Reunión actualizada.' : 'Reunión creada.');
    await loadMeetings();
  } catch (requestError) {
    error.textContent = requestError.message;
  }
}

async function meetingTransition(meeting, action) {
  if (!confirm(`¿Confirmas la acción “${action}” para ${meeting.title}?`)) return;
  try {
    await api(`/api/meetings/${encodeURIComponent(meeting.room)}/actions/${action}`, { method: 'POST', body: {} });
    notice('Estado de la reunión actualizado.');
    await loadMeetings();
  } catch (error) { notice(error.message, 'error'); }
}

async function softDeleteMeeting(meeting) {
  if (!confirm(`La reunión quedará eliminada lógicamente y conservará su historial. ¿Continuar con “${meeting.title}”?`)) return;
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
  const singleUse = role === 'PANELIST';
  const data = await api(`/api/meetings/${encodeURIComponent(meeting.room)}/invitations`, {
    method: 'POST', body: { role, singleUse, expiresInMinutes: role === 'PANELIST' ? 720 : 1_440 },
  });
  return `${location.origin}${data.path}`;
}

async function copyInvitation(meeting, role) {
  try {
    const url = await createInvitation(meeting, role);
    await navigator.clipboard.writeText(url);
    notice(`Enlace de ${role === 'PANELIST' ? 'panelista' : 'asistente'} copiado. Expira automáticamente.`);
  } catch (error) { notice(error.message, 'error'); }
}

async function shareWhatsApp(meeting) {
  try {
    const url = await createInvitation(meeting, 'VIEWER');
    const text = `Te invitamos a ${meeting.title}\n${meeting.scheduledAt ? fmtDate.format(new Date(meeting.scheduledAt)) : ''}\n${url}`;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank', 'noopener,noreferrer');
  } catch (error) { notice(error.message, 'error'); }
}

async function launchMeeting(meeting) {
  try {
    const data = await api(`/api/meetings/${encodeURIComponent(meeting.room)}/launch`, { method: 'POST', body: {} });
    window.location.href = data.redirect;
  } catch (error) { notice(error.message, 'error'); }
}

async function loadMeetings() {
  const includeDeleted = state.user?.role === 'ADMIN' && document.getElementById('includeDeleted').checked;
  const data = await api(`/api/meetings${includeDeleted ? '?includeDeleted=true' : ''}`);
  state.meetings = data.items;
  renderMeetings();
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
    (!date || String(meeting.scheduledAt || '').slice(0, 10) === date)
  );
}

function startOfWeek(date) {
  const copy = new Date(date);
  const day = (copy.getDay() + 6) % 7;
  copy.setDate(copy.getDate() - day);
  copy.setHours(0, 0, 0, 0);
  return copy;
}

function renderCalendar() {
  const grid = document.getElementById('calendarGrid');
  if (!grid) return;
  grid.replaceChildren();
  grid.className = `calendar-grid view-${state.calendarView}`;
  const date = new Date(state.calendarDate);
  let start;
  let days;
  if (state.calendarView === 'month') {
    start = new Date(date.getFullYear(), date.getMonth(), 1);
    const offset = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - offset);
    days = 42;
    document.getElementById('calendarLabel').textContent = new Intl.DateTimeFormat('es-EC', { month: 'long', year: 'numeric' }).format(date);
  } else if (state.calendarView === 'week') {
    start = startOfWeek(date);
    days = 7;
    document.getElementById('calendarLabel').textContent = `${start.toLocaleDateString('es-EC')} – ${new Date(start.getTime() + 6 * 86_400_000).toLocaleDateString('es-EC')}`;
  } else {
    start = new Date(date); start.setHours(0, 0, 0, 0); days = 1;
    document.getElementById('calendarLabel').textContent = new Intl.DateTimeFormat('es-EC', { dateStyle: 'full' }).format(date);
  }
  const items = filteredCalendarMeetings();
  for (let index = 0; index < days; index += 1) {
    const day = new Date(start); day.setDate(start.getDate() + index);
    const isoDay = day.toISOString().slice(0, 10);
    const cell = document.createElement('article');
    cell.className = 'calendar-day';
    if (isoDay === new Date().toISOString().slice(0, 10)) cell.classList.add('today');
    cell.appendChild(textElement('h3', new Intl.DateTimeFormat('es-EC', { weekday: 'short', day: 'numeric', month: days === 1 ? 'long' : undefined }).format(day)));
    const dayMeetings = items.filter((meeting) => String(meeting.scheduledAt || '').slice(0, 10) === isoDay);
    if (!dayMeetings.length) cell.appendChild(textElement('span', 'Sin reuniones', 'muted calendar-empty'));
    for (const meeting of dayMeetings) {
      const event = document.createElement('button');
      event.type = 'button';
      event.className = `calendar-event status-${meeting.status.toLowerCase()}`;
      event.append(textElement('strong', meeting.title), textElement('span', meeting.scheduledAt ? new Date(meeting.scheduledAt).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' }) : 'Sin hora'));
      event.addEventListener('click', () => openMeetingDialog(meeting));
      cell.appendChild(event);
    }
    grid.appendChild(cell);
  }
}

function renderUpcoming() {
  const container = document.getElementById('upcomingList');
  container.replaceChildren();
  const next = state.meetings.filter((meeting) => meeting.scheduledAt && new Date(meeting.scheduledAt) >= new Date() && !['CANCELLED', 'ARCHIVED'].includes(meeting.status)).slice(0, 5);
  if (!next.length) return container.appendChild(textElement('p', 'No hay reuniones próximas.', 'empty-state'));
  for (const meeting of next) {
    const row = document.createElement('button'); row.type = 'button'; row.className = 'compact-list-item';
    row.append(textElement('strong', meeting.title), textElement('span', `${fmtDate.format(new Date(meeting.scheduledAt))} · ${meeting.trainerName}`));
    row.addEventListener('click', () => { showSection('meetings'); openMeetingDialog(meeting); });
    container.appendChild(row);
  }
}

function summaryCard(label, value, detail) {
  const card = document.createElement('article'); card.className = 'summary-card';
  card.append(textElement('span', label, 'summary-label'), textElement('strong', String(value ?? '—')), textElement('small', detail || ''));
  return card;
}

async function loadSummary() {
  const data = await api('/api/dashboard/summary');
  const cards = document.getElementById('summaryCards'); cards.replaceChildren(
    summaryCard('Reuniones de hoy', data.meetingsToday, 'programadas'),
    summaryCard('Reuniones activas', data.activeMeetings, 'en vivo ahora'),
    summaryCard('Próxima capacitación', data.nextMeeting ? new Date(data.nextMeeting.scheduledAt).toLocaleDateString('es-EC') : '—', data.nextMeeting?.title || 'Sin próximas reuniones'),
    summaryCard('Credenciales activas', state.user.role === 'ADMIN' ? data.activeCredentials : '—', state.user.role === 'ADMIN' ? 'usuarios habilitados' : 'Visible para ADMIN'),
    summaryCard('Errores recientes', data.recentErrors, data.recentErrors === null ? 'Visible para ADMIN' : 'intentos fallidos registrados')
  );
  const services = document.getElementById('serviceStatus'); services.replaceChildren();
  for (const [name, value] of [['Almacenamiento', data.storage], ['LiveKit', data.livekit], ['Grabación', data.recordingConfigured ? 'configurada' : 'deshabilitada']]) {
    const row = document.createElement('div'); row.append(textElement('span', name), textElement('strong', value)); services.appendChild(row);
  }
  document.getElementById('settingsIntegrations').textContent = `Almacenamiento: ${data.storage}. LiveKit: ${data.livekit}. Grabación: ${data.recordingConfigured ? 'configurada' : 'deshabilitada'}.`;
}

function userActions(user) {
  const wrap = document.createElement('div'); wrap.className = 'table-actions';
  if (user.bootstrap) {
    wrap.appendChild(textElement('span', 'Gestionado por entorno', 'muted small'));
    return wrap;
  }
  wrap.append(
    meetingAction('Editar', () => openUserDialog(user), user),
    meetingAction('Contraseña', () => resetUserPassword(user), user),
    meetingAction(user.active ? 'Desactivar' : 'Activar', () => toggleUser(user), user),
    meetingAction('Revocar sesiones', () => revokeUserSessions(user), user),
    meetingAction('Eliminar', () => deleteUser(user), user, 'danger compact')
  );
  return wrap;
}

async function loadUsers() {
  const data = await api('/api/auth/users'); state.users = data.users;
  const tbody = document.getElementById('usersTable'); tbody.replaceChildren();
  for (const user of data.users) {
    const row = document.createElement('tr');
    for (const value of [user.username, user.role, user.active ? 'Activo' : 'Inactivo', user.createdAt ? fmtDate.format(new Date(user.createdAt)) : 'Entorno', user.lastLoginAt ? fmtDate.format(new Date(user.lastLoginAt)) : 'Nunca']) row.appendChild(textElement('td', value));
    const actions = document.createElement('td'); actions.appendChild(userActions(user)); row.appendChild(actions); tbody.appendChild(row);
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
  document.getElementById('userPassword').required = !user;
  document.getElementById('userPassword').value = '';
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
      await api('/api/auth/users', { method: 'POST', body: { username: document.getElementById('userUsername').value.trim(), password: document.getElementById('userPassword').value, role: document.getElementById('userRole').value, active: document.getElementById('userActive').checked } });
    }
    document.getElementById('userDialog').close(); notice('Usuario guardado.'); await loadUsers();
  } catch (requestError) { error.textContent = requestError.message; }
}

async function resetUserPassword(user) {
  const password = prompt(`Nueva contraseña para ${user.username} (mínimo 10 caracteres):`);
  if (!password) return;
  try { await api(`/api/auth/users/${encodeURIComponent(user.username)}/password`, { method: 'POST', body: { password } }); notice('Contraseña cambiada y sesiones revocadas.'); await loadUsers(); } catch (error) { notice(error.message, 'error'); }
}
async function toggleUser(user) {
  if (!confirm(`¿${user.active ? 'Desactivar' : 'Activar'} a ${user.username}?`)) return;
  try { await api(`/api/auth/users/${encodeURIComponent(user.username)}`, { method: 'PATCH', body: { active: !user.active, role: user.role } }); notice('Estado actualizado.'); await loadUsers(); } catch (error) { notice(error.message, 'error'); }
}
async function revokeUserSessions(user) {
  if (!confirm(`¿Revocar todas las sesiones de ${user.username}?`)) return;
  try { await api(`/api/auth/users/${encodeURIComponent(user.username)}/revoke-sessions`, { method: 'POST', body: {} }); notice('Sesiones revocadas.'); await loadUsers(); } catch (error) { notice(error.message, 'error'); }
}
async function deleteUser(user) {
  if (!confirm(`Eliminar de forma segura a ${user.username}. Esta acción no muestra ni recupera su contraseña. ¿Continuar?`)) return;
  try { await api(`/api/auth/users/${encodeURIComponent(user.username)}`, { method: 'DELETE' }); notice('Usuario eliminado.'); await loadUsers(); } catch (error) { notice(error.message, 'error'); }
}

async function loadRecordings() {
  const container = document.getElementById('recordingsList'); container.replaceChildren(textElement('p', 'Cargando…', 'muted'));
  const room = document.getElementById('recordingRoomFilter').value.trim();
  try {
    const data = await api(`/api/recordings${room ? `?room=${encodeURIComponent(room)}` : ''}`);
    container.replaceChildren();
    if (!data.items.length) return container.appendChild(textElement('p', 'No hay grabaciones disponibles.', 'empty-state'));
    for (const item of data.items) {
      const row = document.createElement('article'); row.className = 'recording-card';
      const info = document.createElement('div'); info.append(textElement('h2', item.title), textElement('p', `${item.trainerName || 'Sin capacitador'} · ${fmtDate.format(new Date(item.lastModified))}`, 'muted'), textElement('p', `${(item.size / 1024 / 1024).toFixed(1)} MB · Lista`, 'small'));
      const actions = document.createElement('div'); actions.className = 'meeting-actions';
      const open = document.createElement('a'); open.href = item.url; open.target = '_blank'; open.rel = 'noopener noreferrer'; open.className = 'button secondary compact'; open.textContent = 'Abrir';
      const download = document.createElement('a'); download.href = item.url; download.target = '_blank'; download.rel = 'noopener noreferrer'; download.className = 'button secondary compact'; download.textContent = 'Descargar'; download.setAttribute('download', '');
      actions.append(open, download, meetingAction('Copiar enlace', async () => { await navigator.clipboard.writeText(item.url); notice('Enlace temporal copiado.'); }, item));
      if (state.user.role === 'ADMIN') actions.appendChild(meetingAction('Eliminar', async () => {
        if (!confirm(`¿Eliminar permanentemente la grabación de ${item.title}?`)) return;
        try { await api('/api/recordings', { method: 'DELETE', body: { key: item.key } }); notice('Grabación eliminada.'); await loadRecordings(); } catch (error) { notice(error.message, 'error'); }
      }, item, 'danger compact'));
      row.append(info, actions); container.appendChild(row);
    }
  } catch (error) { container.replaceChildren(textElement('p', error.message, 'form-error')); }
}

async function loadAudit() {
  const data = await api('/api/audit?limit=200');
  const tbody = document.getElementById('auditTable'); tbody.replaceChildren();
  for (const item of data.items) {
    const row = document.createElement('tr');
    for (const value of [fmtDate.format(new Date(item.timestamp)), item.actor, item.action, item.target || '—', item.room || '—']) row.appendChild(textElement('td', value));
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
    document.getElementById('currentRole').textContent = me.user.role;
    document.querySelectorAll('.admin-only').forEach((element) => { element.hidden = me.user.role !== 'ADMIN'; });
    for (const status of Object.keys(STATUS_LABELS)) {
      document.getElementById('meetingStatus').appendChild(new Option(STATUS_LABELS[status], status));
      document.getElementById('meetingStatusFilter').appendChild(new Option(STATUS_LABELS[status], status));
      document.getElementById('filterStatus').appendChild(new Option(STATUS_LABELS[status], status));
    }
    for (const type of Object.keys(TYPE_LABELS)) document.getElementById('filterType').appendChild(new Option(TYPE_LABELS[type], type));
    await Promise.all([loadMeetings(), loadSummary()]);
  } catch (error) { notice(error.message, 'error'); }
}

document.getElementById('dashboardNav').addEventListener('click', (event) => { const button = event.target.closest('[data-section]'); if (button) showSection(button.dataset.section); });
document.querySelectorAll('[data-go]').forEach((button) => button.addEventListener('click', () => showSection(button.dataset.go)));
document.querySelectorAll('[data-open-meeting]').forEach((button) => button.addEventListener('click', () => openMeetingDialog()));
document.getElementById('meetingForm').addEventListener('submit', saveMeeting);
document.getElementById('userForm').addEventListener('submit', saveUser);
document.getElementById('openUserModal').addEventListener('click', () => openUserDialog());
document.getElementById('loadRecordings').addEventListener('click', loadRecordings);
document.getElementById('refreshAudit').addEventListener('click', loadAudit);
document.getElementById('meetingSearch').addEventListener('input', renderMeetings);
document.getElementById('meetingStatusFilter').addEventListener('change', renderMeetings);
document.getElementById('includeDeleted').addEventListener('change', loadMeetings);
for (const id of ['filterTrainer', 'filterStatus', 'filterType', 'filterDate']) document.getElementById(id).addEventListener('input', renderCalendar);
document.querySelectorAll('[data-calendar-view]').forEach((button) => button.addEventListener('click', () => { state.calendarView = button.dataset.calendarView; document.querySelectorAll('[data-calendar-view]').forEach((item) => item.classList.toggle('active', item === button)); renderCalendar(); }));
document.getElementById('calendarPrev').addEventListener('click', () => { const amount = state.calendarView === 'month' ? -1 : state.calendarView === 'week' ? -7 : -1; if (state.calendarView === 'month') state.calendarDate.setMonth(state.calendarDate.getMonth() + amount); else state.calendarDate.setDate(state.calendarDate.getDate() + amount); renderCalendar(); });
document.getElementById('calendarNext').addEventListener('click', () => { const amount = state.calendarView === 'month' ? 1 : state.calendarView === 'week' ? 7 : 1; if (state.calendarView === 'month') state.calendarDate.setMonth(state.calendarDate.getMonth() + amount); else state.calendarDate.setDate(state.calendarDate.getDate() + amount); renderCalendar(); });
document.getElementById('calendarToday').addEventListener('click', () => { state.calendarDate = new Date(); renderCalendar(); });
document.getElementById('menuToggle').addEventListener('click', () => { const sidebar = document.getElementById('dashboardSidebar'); const open = sidebar.classList.toggle('open'); document.getElementById('menuToggle').setAttribute('aria-expanded', String(open)); });
document.getElementById('logoutButton').addEventListener('click', async () => { try { await api('/api/auth/logout', { method: 'POST', body: {} }); } finally { window.location.replace('/index.html'); } });
bindDialog(document.getElementById('meetingDialog'), '[data-close-dialog]');
bindDialog(document.getElementById('userDialog'), '[data-close-user]');

initialize();
