renderBrand(document.getElementById('brand'), { tagline: false });

const state = { payload: null, csrfToken: '', previewStream: null, meterFrame: null, pollTimer: null, countdownTimer: null };
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

function phaseContent(resolution, series, access) {
  const scheduled = resolution.meeting ? formatDate(resolution.meeting.scheduledAt, series.timezone) : '';
  if (resolution.phase === 'LIVE') return ['La sesión ha comenzado', `Sesión ${resolution.meeting.sessionNumber} disponible ahora. La conexión solo comenzará cuando pulses “Entrar ahora”.`];
  if (resolution.phase === 'WAITING') return ['Sala de espera abierta', `La sesión ${resolution.meeting.sessionNumber} está programada para ${scheduled}. Puedes preparar tus dispositivos; todavía no estás conectado.`];
  if (resolution.phase === 'UPCOMING') return ['Tu acceso está confirmado', `La preparación se habilitará ${series.earlyAccessMinutes} minutos antes. Próxima sesión: ${scheduled}.`];
  if (resolution.phase === 'COMPLETED') return [access?.mode === 'GENERAL' ? 'Capacitación finalizada' : 'Capacitación completada', 'Finalizaste el ciclo. Este enlace conserva el historial de sesiones, pero ya no conecta a ninguna sala.'];
  return ['Capacitación no disponible', 'No existe una próxima sesión disponible en este momento.'];
}

function renderCountdown() {
  const resolution = state.payload?.resolution;
  const element = document.getElementById('phaseCountdown');
  if (!resolution || !['UPCOMING', 'WAITING'].includes(resolution.phase) || !resolution.meeting?.scheduledAt) { element.textContent = ''; return; }
  const distance = new Date(resolution.meeting.scheduledAt).getTime() - Date.now();
  if (distance <= 0) { element.textContent = 'Esperando confirmación del organizador…'; return; }
  const hours = Math.floor(distance / 3_600_000);
  const minutes = Math.floor((distance % 3_600_000) / 60_000);
  const seconds = Math.floor((distance % 60_000) / 1_000);
  element.textContent = `Comienza en ${hours ? `${hours} h ` : ''}${minutes} min ${seconds} s`;
}

function renderSessions(series, resolution) {
  const container = document.getElementById('seriesSessions');
  container.replaceChildren();
  for (const session of series.sessions) {
    const item = document.createElement('li');
    item.className = `series-session-item status-${String(session.status).toLowerCase()}`;
    if (resolution.meeting?.id === session.id) item.classList.add('current');
    const body = document.createElement('div');
    const title = document.createElement('strong'); title.textContent = `Sesión ${session.sessionNumber}`;
    const date = document.createElement('span'); date.textContent = `${formatDate(session.scheduledAt, series.timezone)} · ${session.durationMinutes} min`;
    const status = document.createElement('span'); status.className = 'badge';
    status.textContent = ({ SCHEDULED: 'Programada', LIVE: 'En vivo', COMPLETED: 'Completada', CANCELLED: 'Cancelada', ARCHIVED: 'Archivada' })[session.status] || session.status;
    body.append(title, date); item.append(body, status); container.appendChild(item);
  }
}

function render(payload) {
  state.payload = payload; state.csrfToken = payload.csrfToken;
  const { series, resolution, access, consents } = payload;
  document.title = `${series.title} | R.A. Training Streaming`;
  document.getElementById('seriesTitle').textContent = series.title;
  document.getElementById('seriesDescription').textContent = series.description || 'Ciclo de capacitación en vivo.';
  document.getElementById('seriesTrainer').textContent = `Capacitador: ${series.trainerName}`;
  document.getElementById('seriesProgress').textContent = `${resolution.completedCount} de ${resolution.totalSessions} sesiones completadas`;
  document.getElementById('seriesRole').textContent = access.mode === 'GENERAL' ? `Acceso general · ${RATCore.roleLabel(access.meetingRole)}` : `Acceso individual · ${RATCore.roleLabel(access.meetingRole)}`;
  const nameInput = document.getElementById('participantName');
  if (document.activeElement !== nameInput) nameInput.value = access.participantName;
  const [title, message] = phaseContent(resolution, series, access);
  document.getElementById('phaseTitle').textContent = title;
  document.getElementById('phaseMessage').textContent = message;
  document.getElementById('phaseEyebrow').textContent = resolution.phase === 'LIVE' ? 'En vivo' : resolution.phase === 'COMPLETED' ? 'Ciclo finalizado' : 'Próxima sesión';
  document.getElementById('phaseCard').dataset.phase = resolution.phase;
  document.getElementById('enterButton').hidden = !resolution.canEnter;
  document.getElementById('preparationCard').hidden = !resolution.canPrepare;
  document.getElementById('privacyConsent').checked = consents?.privacy === true;
  document.getElementById('recordingConsent').checked = consents?.recording === true;
  document.getElementById('transcriptionConsent').checked = consents?.transcription === true;
  updateEnterAvailability();
  renderSessions(series, resolution); renderCountdown();
  clearInterval(state.countdownTimer); state.countdownTimer = setInterval(renderCountdown, 1_000);
}

async function loadAccess({ quiet = false } = {}) {
  try { render(await request('/api/series-access')); }
  catch (error) {
    if (!quiet) {
      document.getElementById('seriesTitle').textContent = 'Acceso no disponible';
      document.getElementById('phaseTitle').textContent = error.message;
      document.getElementById('phaseMessage').textContent = 'Solicita un nuevo enlace al organizador.';
    }
  } finally {
    clearTimeout(state.pollTimer);
    state.pollTimer = setTimeout(() => loadAccess({ quiet: true }), 15_000);
  }
}

async function enumerateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const targets = { audioinput: document.getElementById('seriesMicrophone'), videoinput: document.getElementById('seriesCamera'), audiooutput: document.getElementById('seriesSpeaker') };
  for (const [kind, select] of Object.entries(targets)) {
    const previous = select.value; select.replaceChildren(new Option('Predeterminado', ''));
    devices.filter((device) => device.kind === kind).forEach((device, index) => select.appendChild(new Option(device.label || `${kind === 'videoinput' ? 'Cámara' : kind === 'audioinput' ? 'Micrófono' : 'Altavoz'} ${index + 1}`, device.deviceId)));
    if ([...select.options].some((option) => option.value === previous)) select.value = previous;
  }
}

function stopPreview() {
  cancelAnimationFrame(state.meterFrame);
  state.previewStream?.getTracks().forEach((track) => track.stop());
  state.previewStream = null;
  const video = document.getElementById('seriesPreview'); video.srcObject = null; video.hidden = true;
  document.querySelector('#audioMeter span').style.width = '0%';
}

async function startPreview() {
  stopPreview();
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite probar dispositivos.');
  const audioId = document.getElementById('seriesMicrophone').value;
  const videoId = document.getElementById('seriesCamera').value;
  const stream = await navigator.mediaDevices.getUserMedia({ audio: audioId ? { deviceId: { exact: audioId } } : true, video: videoId ? { deviceId: { exact: videoId } } : true });
  state.previewStream = stream;
  const video = document.getElementById('seriesPreview'); video.srcObject = stream; video.hidden = false;
  const Context = window.AudioContext || window.webkitAudioContext;
  if (Context && stream.getAudioTracks().length) {
    const context = new Context(); const analyser = context.createAnalyser(); const data = new Uint8Array(analyser.frequencyBinCount);
    context.createMediaStreamSource(stream).connect(analyser);
    const update = () => { analyser.getByteFrequencyData(data); const level = Math.min(100, Math.round(data.reduce((sum, value) => sum + value, 0) / data.length)); document.querySelector('#audioMeter span').style.width = `${level}%`; state.meterFrame = requestAnimationFrame(update); };
    update(); stream.getAudioTracks()[0].addEventListener('ended', () => context.close(), { once: true });
  }
  await enumerateDevices();
  document.getElementById('seriesFeedback').textContent = 'Prueba local activa. Aún no estás conectado a la sesión.';
}

async function testSpeaker() {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) throw new Error('La prueba de altavoz no está disponible.');
  const context = new Context(); const output = document.getElementById('seriesSpeaker').value;
  if (output && typeof context.setSinkId === 'function') await context.setSinkId(output);
  const oscillator = context.createOscillator(); const gain = context.createGain();
  oscillator.connect(gain).connect(context.destination); oscillator.frequency.value = 660; gain.gain.value = 0.12;
  oscillator.start(); oscillator.stop(context.currentTime + 0.45);
  await new Promise((resolve) => { oscillator.onended = resolve; }); await context.close();
}

async function savePreparation() {
  const feedback = document.getElementById('seriesFeedback'); feedback.textContent = '';
  const displayName = document.getElementById('participantName').value.trim();
  const current = state.payload.access.participantName;
  if (displayName !== current) {
    const profile = await request('/api/series-access/profile', { method: 'PATCH', body: { displayName } });
    state.csrfToken = profile.csrfToken;
  }
  const consent = await request('/api/series-access/consent', { method: 'POST', body: {
    privacy: document.getElementById('privacyConsent').checked,
    recording: document.getElementById('recordingConsent').checked,
    transcription: document.getElementById('transcriptionConsent').checked,
  } });
  state.csrfToken = consent.csrfToken; feedback.textContent = 'Preparación guardada para este acceso.';
  await loadAccess({ quiet: true });
}

function updateEnterAvailability() {
  const button = document.getElementById('enterButton');
  const validName = document.getElementById('participantName').value.trim().length >= 2;
  button.disabled = !document.getElementById('privacyConsent').checked || !validName;
}

document.getElementById('previewButton').addEventListener('click', () => startPreview().catch((error) => { document.getElementById('seriesFeedback').textContent = error.message; }));
document.getElementById('speakerButton').addEventListener('click', () => testSpeaker().then(() => { document.getElementById('seriesFeedback').textContent = 'Prueba de altavoz completada.'; }).catch((error) => { document.getElementById('seriesFeedback').textContent = error.message; }));
document.getElementById('savePreparation').addEventListener('click', () => savePreparation().catch((error) => { document.getElementById('seriesFeedback').textContent = error.message; }));
document.getElementById('privacyConsent').addEventListener('change', updateEnterAvailability);
document.getElementById('participantName').addEventListener('input', updateEnterAvailability);
document.getElementById('enterButton').addEventListener('click', async () => {
  const button = document.getElementById('enterButton'); button.disabled = true;
  try { await savePreparation(); const result = await request('/api/series-access/enter', { method: 'POST', body: {} }); stopPreview(); window.location.assign(result.redirect); }
  catch (error) { document.getElementById('phaseMessage').textContent = error.message; button.disabled = false; await loadAccess({ quiet: true }); }
});
window.addEventListener('pagehide', () => { stopPreview(); clearTimeout(state.pollTimer); clearInterval(state.countdownTimer); });
enumerateDevices().catch(() => {});
loadAccess();
