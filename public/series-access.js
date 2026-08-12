renderBrand(document.getElementById('brand'), { tagline: false });

const state = { payload: null, csrfToken: '', pollTimer: null, countdownTimer: null, entering: false };
const dateFormatter = new Intl.DateTimeFormat('es-EC', { dateStyle: 'full', timeStyle: 'short', timeZone: 'America/Guayaquil' });

async function request(path, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrfToken && options.method && options.method !== 'GET') headers['X-Series-CSRF'] = state.csrfToken;
  const response = await fetch(path, { credentials: 'same-origin', ...options, headers, body: options.body === undefined ? undefined : JSON.stringify(options.body) });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || 'No fue posible completar la acción.');
  return payload;
}

function formatDate(value, timezone) {
  if (!value) return 'Fecha por confirmar';
  try { return new Intl.DateTimeFormat('es-EC', { dateStyle: 'full', timeStyle: 'short', timeZone: timezone || 'America/Guayaquil' }).format(new Date(value)); }
  catch { return dateFormatter.format(new Date(value)); }
}

function renderCountdown() {
  const resolution = state.payload?.resolution;
  const element = document.getElementById('phaseCountdown');
  if (!resolution || resolution.phase !== 'WAITING' || !resolution.meeting?.scheduledAt) { element.textContent = ''; return; }
  const distance = new Date(resolution.meeting.scheduledAt).getTime() - Date.now();
  if (distance <= 0) { element.textContent = '00 : 00 : 00'; return; }
  const hours = Math.floor(distance / 3_600_000);
  const minutes = Math.floor((distance % 3_600_000) / 60_000);
  const seconds = Math.floor((distance % 60_000) / 1_000);
  element.textContent = [hours, minutes, seconds].map((part) => String(part).padStart(2, '0')).join(' : ');
}

function isPrepared(payload = state.payload) {
  return Boolean(payload?.access?.participantName?.trim().length >= 2 && payload?.consents?.privacy === true);
}

function setBusy(busy, label = 'CONFIRMAR ACCESO', enterLabel = 'ENTRAR A LA REUNIÓN') {
  const confirm = document.getElementById('confirmAccessButton');
  const enter = document.getElementById('enterButton');
  confirm.disabled = busy;
  enter.disabled = busy;
  confirm.setAttribute('aria-busy', String(busy));
  enter.setAttribute('aria-busy', String(busy));
  confirm.textContent = busy ? 'Confirmando...' : label;
  enter.textContent = busy ? 'Entrando...' : enterLabel;
}

function render(payload) {
  state.payload = payload; state.csrfToken = payload.csrfToken;
  const { series, resolution, access } = payload;
  const meeting = resolution.meeting;
  const prepared = isPrepared(payload);
  document.title = `${series.title} | R.A. Training Streaming`;
  document.getElementById('seriesTitle').textContent = series.title;
  document.getElementById('seriesTrainer').textContent = series.trainerName || '';
  document.getElementById('seriesSessionBadge').textContent = meeting ? `Sesión ${meeting.sessionNumber} de ${resolution.totalSessions}` : 'Ciclo finalizado';
  document.getElementById('seriesSchedule').textContent = meeting ? formatDate(meeting.scheduledAt, series.timezone) : '';
  document.getElementById('phaseCard').dataset.phase = resolution.phase;
  document.getElementById('phaseCard').dataset.prepared = String(prepared);
  const nameInput = document.getElementById('participantName');
  if (document.activeElement !== nameInput) nameInput.value = access.participantName || '';

  const form = document.getElementById('seriesAccessForm');
  const preparedState = document.getElementById('preparedState');
  const enterButton = document.getElementById('enterButton');
  const feedback = document.getElementById('seriesFeedback');
  feedback.textContent = '';
  form.hidden = prepared || resolution.phase === 'COMPLETED' || (!resolution.canPrepare && resolution.phase !== 'LIVE');
  preparedState.hidden = !prepared || resolution.phase === 'COMPLETED' || resolution.phase === 'LIVE';
  enterButton.hidden = true;

  if (resolution.phase === 'LIVE') {
    document.getElementById('phaseEyebrow').textContent = 'Sesión en vivo';
    document.getElementById('phaseTitle').textContent = '● La sesión ya está en vivo';
    document.getElementById('phaseMessage').textContent = prepared ? 'Tu acceso está listo. Ya puedes entrar a la sesión.' : 'Ingresa tu nombre para entrar ahora.';
    document.getElementById('confirmAccessButton').textContent = 'ENTRAR AHORA';
    enterButton.textContent = 'ENTRAR A LA REUNIÓN';
    enterButton.hidden = !prepared || state.entering;
  } else if (resolution.phase === 'WAITING') {
    document.getElementById('phaseEyebrow').textContent = 'Comenzamos en';
    document.getElementById('phaseTitle').textContent = prepared ? `Todo listo, ${access.participantName}` : '';
    document.getElementById('phaseMessage').textContent = prepared
      ? 'Tu acceso está preparado. Cuando el anfitrión inicie, se habilitará el ingreso.'
      : 'Puedes dejar esta página abierta. Te avisaremos cuando la sesión esté disponible.';
    document.getElementById('confirmAccessButton').textContent = 'CONFIRMAR ACCESO';
    document.getElementById('preparedTitle').textContent = `Todo listo, ${access.participantName}`;
    document.getElementById('preparedMessage').textContent = 'Tu acceso está preparado. Puedes dejar esta página abierta.';
  } else if (resolution.phase === 'COMPLETED') {
    document.getElementById('phaseEyebrow').textContent = 'Ciclo finalizado';
    document.getElementById('phaseTitle').textContent = '✓ Capacitación finalizada';
    document.getElementById('phaseMessage').textContent = 'El ciclo ya no tiene sesiones disponibles.';
  } else {
    document.getElementById('phaseEyebrow').textContent = 'Acceso confirmado';
    document.getElementById('phaseTitle').textContent = 'Tu acceso está confirmado';
    document.getElementById('phaseMessage').textContent = meeting ? `La sala de espera se habilitará antes de ${formatDate(meeting.scheduledAt, series.timezone)}.` : 'No existe una próxima sesión disponible.';
    document.getElementById('confirmAccessButton').textContent = 'CONFIRMAR ACCESO';
  }

  renderCountdown();
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(renderCountdown, 1_000);
}

async function loadAccess({ quiet = false } = {}) {
  try { render(await request('/api/series-access')); }
  catch (error) {
    if (!quiet) {
      document.getElementById('seriesTitle').textContent = 'Acceso no disponible';
      document.getElementById('phaseTitle').textContent = error.message;
      document.getElementById('phaseMessage').textContent = 'Solicita un nuevo enlace al organizador.';
      document.getElementById('seriesAccessForm').hidden = true;
    }
  } finally {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => loadAccess({ quiet: true }), 15_000);
  }
}

async function prepareAccess() {
  const displayName = document.getElementById('participantName').value.trim();
  if (displayName.length < 2) throw new Error('Ingresa tu nombre visible para continuar.');
  if (displayName !== state.payload.access.participantName) {
    const profile = await request('/api/series-access/profile', { method: 'PATCH', body: { displayName } });
    state.csrfToken = profile.csrfToken;
  }
  const consent = await request('/api/series-access/consent', { method: 'POST', body: { privacy: true, recording: false, transcription: false } });
  state.csrfToken = consent.csrfToken;
  await loadAccess({ quiet: true });
}

async function enterSeriesRoom() {
  if (state.entering) return;
  state.entering = true;
  setBusy(true);
  try {
    const result = await request('/api/series-access/enter', { method: 'POST', body: {} });
    window.location.assign(result.redirect);
  } catch (error) {
    state.entering = false;
    setBusy(false, state.payload?.resolution?.phase === 'LIVE' ? 'ENTRAR AHORA' : 'CONFIRMAR ACCESO');
    throw error;
  }
}

async function submitAccess(event) {
  event.preventDefault();
  const feedback = document.getElementById('seriesFeedback'); feedback.textContent = '';
  setBusy(true, state.payload?.resolution?.phase === 'LIVE' ? 'ENTRAR AHORA' : 'CONFIRMAR ACCESO');
  try {
    await prepareAccess();
    if (state.payload?.resolution?.phase === 'LIVE') await enterSeriesRoom();
  } catch (error) { feedback.textContent = error.message; }
  finally { if (!state.entering) setBusy(false, state.payload?.resolution?.phase === 'LIVE' ? 'ENTRAR AHORA' : 'CONFIRMAR ACCESO'); }
}

document.getElementById('seriesAccessForm').addEventListener('submit', submitAccess);
document.getElementById('enterButton').addEventListener('click', () => enterSeriesRoom().catch((error) => { document.getElementById('seriesFeedback').textContent = error.message; }));
document.getElementById('changeNameButton').addEventListener('click', () => {
  document.getElementById('preparedState').hidden = true;
  document.getElementById('seriesAccessForm').hidden = false;
  document.getElementById('participantName').focus();
});
window.addEventListener('pagehide', () => { clearTimeout(state.pollTimer); clearInterval(state.countdownTimer); });
loadAccess();
