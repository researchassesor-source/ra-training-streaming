renderBrand(document.getElementById('brand'), { tagline: false });
attachSoundToggle(document.getElementById('btnSoundToggle'));
renderSoundSettings(document.getElementById('soundSettings'));

const pageRole = document.body.dataset.pageRole;
const ui = {
  session: null,
  room: null,
  roomUi: null,
  chat: null,
  questions: null,
  stageEvents: null,
  companion: null,
  previewStream: null,
  meterFrame: null,
  microphone: false,
  camera: false,
  microphoneBusy: false,
  cameraBusy: false,
  screen: false,
  screenBusy: false,
  recording: false,
  recordingConfigured: false,
  egressId: null,
  facebookState: 'IDLE',
  facebookActive: false,
  facebookEgressId: null,
  handRaised: false,
  activeTab: null,
  effectsLoaded: false,
  backgroundObjectUrl: null,
  connectionAttempts: 0,
  controlsBound: false,
  locked: false,
  elapsedTimer: null,
  screenEndedHandler: null,
  selfView: true,
  reactionTimer: null,
  pendingMicrophoneRequestId: null,
  meetingVolume: 1,
  participantVolumes: new Map(),
  speakerMode: 'auto',
  pinnedSpeakerIdentity: null,
  livekitAvailable: false,
  temporaryMicrophoneAllowed: null,
  lastWordGrantNoticeAt: 0,
};
const handQueue = new RATCore.HandQueue();
const floatingModel = RATCore.createFloatingModel();
const notifier = createMeetingNotifier(document.getElementById('toastRegion'));
const unreadChat = RATCore.createUnreadCounter((count) => {
  updateCounter('chatUnread', count);
  updateCounter('chatControlUnread', count);
  floatingModel.update({ unreadMessages: count });
});
const unreadQuestions = RATCore.createUnreadCounter((count) => { updateCounter('questionUnread', count); floatingModel.update({ unreadQuestions: count }); });
const statusMachine = new RATCore.ConnectionStateMachine(renderConnectionState);
let recordingMachine = new RATCore.RecordingStateMachine(renderRecordingState, false);
let recordingPollTimer = null;
let facebookPollTimer = null;

function renderRecordingState(snapshot) {
  const wasRecording = ui.recording;
  ui.recording = snapshot.active;
  ui.egressId = snapshot.egressId;
  const badge = document.getElementById('recordingBadge');
  badge.hidden = !snapshot.active;
  badge.textContent = snapshot.active ? 'Grabando' : '';
  const button = document.getElementById('btnRecord');
  if (button) {
    button.disabled = snapshot.busy || snapshot.state === 'DISABLED';
    button.textContent = snapshot.state === 'DISABLED' ? 'Grabación no disponible' : snapshot.active ? 'Detener grabación' : snapshot.busy ? snapshot.label : 'Iniciar grabación';
    button.setAttribute('aria-busy', String(snapshot.busy));
    button.title = snapshot.state === 'DISABLED' ? 'La grabación no está configurada en este entorno' : snapshot.label;
  }
  const help = document.getElementById('recordingHelp');
  if (help) help.textContent = snapshot.state === 'DISABLED' ? 'Configura LiveKit Egress y almacenamiento S3/R2 para habilitarla.' : snapshot.active ? 'La grabación está activa y todos los participantes han sido avisados.' : snapshot.label;
  floatingModel.update({ recording: snapshot.active });
  if (snapshot.active !== wasRecording) {
    playAlert(snapshot.active ? 'recordingStart' : 'recordingStop');
    notifier.notify('recording-state', { title: snapshot.active ? 'Grabación iniciada' : 'Grabación detenida', message: snapshot.active ? 'Esta sesión está siendo grabada.' : 'La grabación dejó de estar activa.', tone: snapshot.active ? 'critical' : 'info' });
  }
}

function renderFacebookState(result = {}) {
  const state = ['IDLE', 'SENDING', 'ACTIVE', 'STOPPING', 'ERROR'].includes(result.state) ? result.state : 'ERROR';
  ui.facebookState = state;
  ui.facebookActive = result.active === true;
  ui.facebookEgressId = result.egressId || null;
  const labels = {
    IDLE: '○ No transmitiendo',
    SENDING: '◉ Enviando señal',
    ACTIVE: '🔴 Señal enviada a Facebook',
    STOPPING: '◉ Deteniendo señal',
    ERROR: '⚠ Error de transmisión',
  };
  const status = document.getElementById('facebookLiveState');
  if (status) status.textContent = labels[state];
  const notice = document.getElementById('externalBroadcastNotice');
  if (notice) notice.hidden = !ui.facebookActive;
  const configure = document.getElementById('btnFacebookConfig');
  const stop = document.getElementById('btnFacebookStop');
  if (configure) {
    configure.hidden = ui.facebookActive;
    configure.disabled = ['SENDING', 'STOPPING'].includes(state);
    configure.textContent = state === 'ERROR' ? 'Reintentar' : 'Configurar Facebook Live';
  }
  if (stop) {
    stop.hidden = !ui.facebookActive;
    stop.disabled = state === 'STOPPING' || !ui.facebookEgressId;
  }
  const help = document.getElementById('facebookLiveHelp');
  if (help) help.textContent = state === 'ACTIVE'
    ? 'LiveKit está enviando señal. Confirma la previsualización y la publicación desde Facebook Live Producer.'
    : state === 'ERROR' ? (result.message || 'La señal externa falló; la reunión y la grabación continúan.')
      : 'Conexión manual mediante LiveKit Egress, independiente de la grabación.';
  clearTimeout(facebookPollTimer);
  if (ui.room && (ui.facebookActive || ['SENDING', 'STOPPING'].includes(state))) {
    facebookPollTimer = window.setTimeout(queryFacebookStatus, state === 'ACTIVE' ? 5_000 : 1_500);
  }
  return result;
}

function renderConnectionState(snapshot) {
  const element = document.getElementById('connectionStatus');
  element.textContent = snapshot.label;
  element.className = `connection-status state-${snapshot.state}`;
  floatingModel.update({ connection: snapshot.state, live: snapshot.connected });
}

function updateCounter(id, count) {
  const element = document.getElementById(id);
  element.textContent = String(count);
  element.hidden = count < 1;
}

function showMessage(message, critical = false) {
  const element = document.getElementById('featureMessage');
  element.textContent = message;
  element.className = critical ? 'form-error' : 'muted';
  if (critical) playAlert('critical');
  notifier.notify(`message-${critical ? 'critical' : 'info'}`, { title: critical ? 'Atención' : 'Reunión', message, tone: critical ? 'critical' : 'info', system: false });
}

function showWordGrantNotice() {
  const now = Date.now();
  if (now - ui.lastWordGrantNoticeAt < 1_500) return;
  ui.lastWordGrantNoticeAt = now;
  showMessage('Se te concedió la palabra. Activa tu micrófono cuando estés listo.');
}

function askConfirmation({ title, message, confirmLabel = 'Confirmar', cancelLabel = 'Cancelar', danger = false }) {
  const dialog = document.getElementById('confirmationDialog');
  dialog.querySelector('[data-confirm-title]').textContent = title;
  dialog.querySelector('[data-confirm-message]').textContent = message;
  const accept = dialog.querySelector('[data-confirm-accept]');
  const cancel = dialog.querySelector('button[value="cancel"]');
  accept.textContent = confirmLabel;
  if (cancel) cancel.textContent = cancelLabel;
  accept.className = danger ? 'danger' : 'primary';
  return new Promise((resolve) => {
    const close = () => { dialog.removeEventListener('close', close); resolve(dialog.returnValue === 'confirm'); };
    dialog.addEventListener('close', close);
    dialog.showModal();
    accept.focus();
  });
}

function participantName(participant) {
  return participant?.name || participant?.identity || 'Participante';
}

function participantRole(participant) {
  try {
    const metadata = JSON.parse(participant?.metadata || '{}');
    return RATCore.roleLabel(metadata.meetingRole || metadata.role);
  } catch { return RATCore.roleLabel('VIEWER'); }
}

function participantRoleCode(participant) {
  try {
    const metadata = JSON.parse(participant?.metadata || '{}');
    return String(metadata.meetingRole || metadata.role || 'VIEWER').toUpperCase();
  } catch { return 'VIEWER'; }
}

function participantJoinedAt(participant) {
  try { return JSON.parse(participant?.metadata || '{}').joinedAt || null; } catch { return null; }
}

function publicationHasLiveTrack(publication, kind) {
  return RATCore.isLivePublication(publication, kind);
}

function participantMediaState(participant) {
  const cameraPublication = participant.getTrackPublication?.(LivekitClient.Track.Source.Camera);
  const microphonePublication = participant.getTrackPublication?.(LivekitClient.Track.Source.Microphone);
  const screenPublication = participant.getTrackPublication?.(LivekitClient.Track.Source.ScreenShare);
  return {
    cameraPublication,
    microphonePublication,
    screenPublication,
    camera: publicationHasLiveTrack(cameraPublication, 'video'),
    microphone: publicationHasLiveTrack(microphonePublication, 'audio'),
    screen: publicationHasLiveTrack(screenPublication, 'video'),
  };
}

function participantCanPublishSource(participant, sourceName) {
  const permission = participant?.permissions || participant?.permission || {};
  if (permission.canPublish !== true) return false;
  const sources = Array.isArray(permission.canPublishSources) ? permission.canPublishSources : [];
  if (!sources.length) return true;
  const requested = normalizedPermissionSource(sourceName);
  return sources.some((source) => normalizedPermissionSource(source).includes(requested));
}

function isOrganizer() {
  return ui.session?.capabilities?.canManageParticipants === true;
}

function normalizedPermissionSource(source) {
  const numeric = { 1: 'CAMERA', 2: 'MICROPHONE', 3: 'SCREENSHARE', 4: 'SCREENSHAREAUDIO' }[Number(source)];
  if (numeric) return numeric;
  return String(source || '').toUpperCase().replace(/[^A-Z]/g, '');
}

function hasPublishPermission(sourceName) {
  const permission = ui.room?.localParticipant?.permissions;
  const requested = normalizedPermissionSource(sourceName);
  if (permission) {
    if (permission.canPublish !== true) return false;
    const sources = Array.isArray(permission.canPublishSources) ? permission.canPublishSources : [];
    if (sources.length && requested) return sources.some((source) => normalizedPermissionSource(source).includes(requested));
  }
  const allowed = ui.session?.publishSources || [];
  return requested ? allowed.some((source) => normalizedPermissionSource(source).includes(requested)) : allowed.length > 0;
}

function setButtonState(button, active, activeLabel, inactiveLabel, { locked = false, lockedLabel = '' } = {}) {
  const labelText = locked ? lockedLabel || `${inactiveLabel} bloqueado por el anfitrión` : active ? activeLabel : inactiveLabel;
  button.setAttribute('aria-pressed', String(active));
  button.classList.toggle('active', active);
  button.classList.toggle('locked', locked);
  button.dataset.mediaState = locked ? 'locked' : active ? 'active' : 'off';
  const label = button.querySelector('span:last-child');
  if (label) label.textContent = labelText;
  else button.textContent = labelText;
  button.setAttribute('aria-label', labelText);
  button.title = labelText;
}

async function enumerateDevices() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const maps = [
    ['videoinput', ['preflightCamera', 'cameraSelect'], 'Cámara'],
    ['audioinput', ['preflightMicrophone', 'microphoneSelect'], 'Micrófono'],
    ['audiooutput', ['preflightSpeaker', 'speakerSelect'], 'Altavoz'],
  ];
  for (const [kind, ids, fallback] of maps) {
    const matches = devices.filter((device) => device.kind === kind);
    for (const id of ids) {
      const select = document.getElementById(id); select.replaceChildren();
      if (!matches.length) select.appendChild(new Option(`${fallback} predeterminado`, ''));
      matches.forEach((device, index) => select.appendChild(new Option(device.label || `${fallback} ${index + 1}`, device.deviceId)));
      if (kind === 'audiooutput' && typeof HTMLMediaElement.prototype.setSinkId !== 'function') {
        select.disabled = true; select.title = 'La selección de altavoz no está disponible en este navegador.';
      }
    }
    if (kind === 'videoinput' && !matches.length) { const button = document.getElementById('btnCam'); button.disabled = true; button.title = 'No se detectó una cámara.'; }
    if (kind === 'audioinput' && !matches.length) { const button = document.getElementById('btnMic'); button.disabled = true; button.title = 'No se detectó un micrófono.'; }
  }
}

function stopPreview() {
  cancelAnimationFrame(ui.meterFrame);
  ui.previewStream?.getTracks().forEach((track) => track.stop());
  ui.previewStream = null;
  document.getElementById('previewVideo').srcObject = null;
  document.getElementById('previewPlaceholder').hidden = false;
  document.getElementById('microphoneMeter').style.width = '0%';
}

function startMeter(stream) {
  const audioTrack = stream.getAudioTracks()[0];
  if (!audioTrack || !(window.AudioContext || window.webkitAudioContext)) return;
  const Context = window.AudioContext || window.webkitAudioContext;
  const context = new Context();
  const analyser = context.createAnalyser(); analyser.fftSize = 256;
  context.createMediaStreamSource(new MediaStream([audioTrack])).connect(analyser);
  const values = new Uint8Array(analyser.frequencyBinCount);
  function draw() {
    analyser.getByteFrequencyData(values);
    const average = values.reduce((sum, value) => sum + value, 0) / values.length;
    document.getElementById('microphoneMeter').style.width = `${Math.min(100, average * 1.6)}%`;
    ui.meterFrame = requestAnimationFrame(draw);
  }
  draw();
  audioTrack.addEventListener('ended', () => { cancelAnimationFrame(ui.meterFrame); context.close(); }, { once: true });
}

async function startPreview() {
  const error = document.getElementById('preflightError'); error.textContent = '';
  if (!navigator.mediaDevices?.getUserMedia) throw new Error('Este navegador no permite probar cámara y micrófono.');
  stopPreview();
  const cameraAllowed = (ui.session.publishSources || []).includes('CAMERA');
  const microphoneAllowed = (ui.session.publishSources || []).includes('MICROPHONE');
  if (!cameraAllowed && !microphoneAllowed) throw new Error('Tu función no requiere permisos de cámara o micrófono para ingresar.');
  statusMachine.set('requesting_permissions');
  const videoId = document.getElementById('preflightCamera').value;
  const audioId = document.getElementById('preflightMicrophone').value;
  try {
    ui.previewStream = await navigator.mediaDevices.getUserMedia({
      video: cameraAllowed ? (videoId ? { deviceId: { exact: videoId } } : true) : false,
      audio: microphoneAllowed ? (audioId ? { deviceId: { exact: audioId } } : true) : false,
    });
    document.getElementById('previewVideo').srcObject = ui.previewStream;
    const hasVideo = ui.previewStream.getVideoTracks().length > 0;
    document.getElementById('previewPlaceholder').hidden = hasVideo;
    if (!hasVideo) {
      document.getElementById('previewState').textContent = 'Micrófono listo · cámara no habilitada';
      document.querySelector('#previewPlaceholder span').textContent = 'Habla para comprobar el nivel del micrófono.';
    }
    document.getElementById('previewButton').textContent = 'Reiniciar prueba multimedia';
    startMeter(ui.previewStream);
    await enumerateDevices();
    statusMachine.set('waiting_for_room');
  } catch (mediaError) {
    statusMachine.set('waiting_for_room');
    const previewState = document.getElementById('previewState');
    if (previewState) previewState.textContent = mediaError.name === 'NotAllowedError'
      ? 'No permitiste el acceso a la cámara'
      : mediaError.name === 'NotFoundError' ? 'Cámara no disponible' : 'No se pudo iniciar la vista previa';
    throw new Error(RATCore.mediaDeviceErrorMessage(mediaError, 'cámara o micrófono'));
  }
}

async function refreshLiveKitStatus() {
  const status = document.getElementById('livekitStatus');
  const button = document.getElementById('enterRoomButton');
  status.textContent = 'Comprobando el servicio de videoconferencia…';
  status.className = 'service-notice checking';
  try {
    const livekit = await requestLiveKitStatus();
    ui.livekitAvailable = livekit.available === true;
    status.textContent = livekit.available ? 'Conexión lista. Todo preparado para ingresar.' : 'La conexión de la reunión no está disponible en este momento.';
    status.className = `service-notice ${livekit.available ? 'available' : 'unavailable'}`;
    const diagnostic = document.getElementById('preflightDiagnosticText');
    if (diagnostic) diagnostic.textContent = `Servicio de videoconferencia: ${livekit.mode || 'remoto'} · ${livekit.state || (livekit.available ? 'disponible' : 'no disponible')}`;
    button.disabled = !livekit.available || !requiredConsentsAccepted();
    return livekit;
  } catch (error) {
    status.textContent = 'No fue posible comprobar el servicio de videoconferencia.';
    status.className = 'service-notice unavailable';
    ui.livekitAvailable = false;
    button.disabled = true;
    throw error;
  }
}

function requiredConsentsAccepted() {
  if (!document.getElementById('privacyConsent')?.checked) return false;
  if (ui.session?.meeting.recordingConsentRequired && !document.getElementById('recordingConsent')?.checked) return false;
  if (ui.session?.meeting.transcriptionConsentRequired && !document.getElementById('transcriptionConsent')?.checked) return false;
  return true;
}

function updatePreflightReadiness() {
  const accepted = requiredConsentsAccepted();
  const button = document.getElementById('enterRoomButton');
  if (button.dataset.busy !== 'true') button.disabled = !ui.livekitAvailable || !accepted;
  document.getElementById('consentHelp').hidden = accepted;
}

async function setupPreflight() {
  const cameraAllowed = (ui.session.publishSources || []).includes('CAMERA');
  const microphoneAllowed = (ui.session.publishSources || []).includes('MICROPHONE');
  const previewButton = document.getElementById('previewButton');
  previewButton.hidden = !cameraAllowed && !microphoneAllowed;
  previewButton.textContent = cameraAllowed && microphoneAllowed
    ? 'Encender cámara y probar micrófono'
    : cameraAllowed ? 'Probar cámara' : 'Probar micrófono';
  document.querySelectorAll('.presenter-option').forEach((element) => { element.hidden = !cameraAllowed && !microphoneAllowed; });
  document.getElementById('joinCamera').parentElement.hidden = !cameraAllowed;
  document.getElementById('joinMicrophone').parentElement.hidden = !microphoneAllowed;
  const privacyConsent = document.getElementById('privacyConsent');
  privacyConsent.disabled = false;
  privacyConsent.required = true;
  document.getElementById('recordingConsent').disabled = false;
  document.getElementById('transcriptionConsent').disabled = false;
  document.getElementById('displayNameInput').value = ui.session.displayName && ui.session.displayName !== RATCore.roleLabel(ui.session.meetingRole) ? ui.session.displayName : '';
  const savedConsents = ui.session.consents || {};
  privacyConsent.checked = savedConsents.privacy === true;
  document.getElementById('recordingConsent').checked = savedConsents.recording === true;
  document.getElementById('transcriptionConsent').checked = savedConsents.transcription === true;
  document.getElementById('preflightMeeting').textContent = `${ui.session.meeting.title} · ${ui.session.meeting.trainerName}`;
  document.getElementById('preflightRole').textContent = RATCore.roleLabel(ui.session.meetingRole);
  document.getElementById('preflightType').textContent = ({ WEBINAR: 'Webinar', SESSION: 'Sesión', CLASS: 'Clase' })[ui.session.meeting.type] || 'Webinar';
  document.getElementById('recordingConsentLabel').hidden = !ui.session.meeting.allowRecording || !ui.session.meeting.recordingConsentRequired;
  document.getElementById('transcriptionConsentLabel').hidden = !ui.session.meeting.allowTranscription || !ui.session.meeting.transcriptionConsentRequired;
  document.getElementById('preflightDiagnostics').hidden = !ui.session.capabilities?.canViewDiagnostics;
  const processingNotice = document.getElementById('processingNotice');
  const recording = ui.session.meeting.allowRecording;
  const transcription = ui.session.meeting.allowTranscription;
  processingNotice.hidden = !recording && !transcription;
  processingNotice.textContent = recording && transcription
    ? 'Esta reunión puede grabarse y transcribirse. La transcripción automática puede contener errores.'
    : recording ? 'Esta reunión puede grabarse.' : 'Esta reunión puede transcribirse. La transcripción automática puede contener errores.';
  const connection = navigator.connection;
  const networkLabels = { '4g': 'Excelente', '3g': 'Buena', '2g': 'Aceptable', 'slow-2g': 'Inestable' };
  document.getElementById('networkStatus').textContent = connection
    ? `Conexión estimada: ${networkLabels[connection.effectiveType] || 'Buena'}`
    : 'La calidad se medirá al ingresar.';
  for (const input of [privacyConsent, document.getElementById('recordingConsent'), document.getElementById('transcriptionConsent')]) input.addEventListener('change', updatePreflightReadiness);
  updatePreflightReadiness();
  document.getElementById('preflightDialog').showModal();
  await refreshLiveKitStatus().catch(() => null);
}

async function submitPreflight(event) {
  event.preventDefault();
  const error = document.getElementById('preflightError'); error.textContent = '';
  const button = document.getElementById('enterRoomButton');
  const cameraAllowed = (ui.session.publishSources || []).includes('CAMERA');
  const microphoneAllowed = (ui.session.publishSources || []).includes('MICROPHONE');
  if (button.dataset.busy === 'true') return;
  if (!document.getElementById('privacyConsent').checked) return void (error.textContent = 'Debes aceptar el aviso de privacidad para entrar.');
  if (ui.session.meeting.recordingConsentRequired && !document.getElementById('recordingConsent').checked) return void (error.textContent = 'Debes confirmar el aviso de grabación para entrar.');
  if (ui.session.meeting.transcriptionConsentRequired && !document.getElementById('transcriptionConsent').checked) return void (error.textContent = 'Debes confirmar el aviso de transcripción para entrar.');
  let connectionAttempted = false;
  let shouldRetry = false;
  button.dataset.busy = 'true';
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = 'Conectando…';
  try {
    const livekit = await refreshLiveKitStatus();
    if (!livekit.available) throw Object.assign(new Error('El servicio de videoconferencia no está disponible.'), { code: 'LIVEKIT_UNAVAILABLE', status: 503 });
    const displayName = document.getElementById('displayNameInput').value.trim();
    if (displayName !== ui.session.displayName) {
      const updated = await updateRoomProfile(displayName, ui.session.csrfToken);
      ui.session.displayName = updated.displayName; ui.session.csrfToken = updated.csrfToken;
    }
    const accepted = await recordRoomConsent({
      privacy: document.getElementById('privacyConsent').checked,
      recording: document.getElementById('recordingConsent').checked,
      transcription: document.getElementById('transcriptionConsent').checked,
    }, ui.session.csrfToken);
    ui.session.consents = accepted.consents;
    ui.session.csrfToken = accepted.csrfToken;
    const joinCamera = cameraAllowed && document.getElementById('joinCamera').checked;
    const joinMicrophone = microphoneAllowed && document.getElementById('joinMicrophone').checked;
    stopPreview();
    connectionAttempted = true;
    if (ui.connectionAttempts > 0) await reportRoomConnection('retry', ui.session.csrfToken);
    ui.connectionAttempts += 1;
    await connectRoom({ joinCamera, joinMicrophone });
    document.getElementById('preflightDialog').close();
  } catch (requestError) {
    shouldRetry = connectionAttempted;
    if (connectionAttempted) await reportRoomConnection('failed', ui.session.csrfToken, requestError.code || requestError.name || 'CONNECTION_FAILED').catch(() => null);
    statusMachine.set('waiting_for_room');
    error.textContent = connectionAttempted ? RATCore.roomConnectionErrorMessage(requestError) : requestError.message;
    error.focus();
  } finally {
    button.dataset.busy = 'false';
    button.disabled = document.getElementById('livekitStatus').classList.contains('unavailable') || !requiredConsentsAccepted();
    button.setAttribute('aria-busy', 'false');
    button.textContent = shouldRetry ? 'Reintentar conexión' : 'Entrar a la reunión';
  }
}

function setupTabs() {
  document.querySelectorAll('[data-room-tab]').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.roomTab)));
  document.getElementById('btnChat').addEventListener('click', () => {
    const panel = document.getElementById('sidePanel');
    const visible = !panel.classList.toggle('closed');
    document.getElementById('btnChat').setAttribute('aria-pressed', String(visible));
    if (visible) openTab('chat');
  });
  document.getElementById('closeSidePanel').addEventListener('click', closeSidePanel);
  const mobile = window.matchMedia?.('(max-width: 700px)').matches === true;
  const saved = sessionStorage.getItem('rat:room-side-panel');
  if (mobile || saved === 'closed') closeSidePanel();
  else openTab('chat', { focus: false });
}

function closeSidePanel() {
  document.getElementById('sidePanel').classList.add('closed');
  document.querySelector('.room-layout').classList.add('panel-closed');
  document.getElementById('btnChat').setAttribute('aria-pressed', 'false');
  floatingModel.update({ panel: null });
  sessionStorage.setItem('rat:room-side-panel', 'closed');
  window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function openTab(name, { focus = true } = {}) {
  ui.activeTab = name;
  document.getElementById('sidePanel').classList.remove('closed');
  document.querySelector('.room-layout').classList.remove('panel-closed');
  document.getElementById('btnChat').setAttribute('aria-pressed', String(name === 'chat'));
  floatingModel.update({ panel: name });
  sessionStorage.setItem('rat:room-side-panel', name);
  document.querySelectorAll('[data-room-tab]').forEach((button) => { const active = button.dataset.roomTab === name; button.setAttribute('aria-selected', String(active)); button.classList.toggle('active', active); });
  document.querySelectorAll('[data-room-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.roomPanel === name));
  if (name === 'chat') unreadChat.clear();
  if (name === 'participants') {
    renderHandQueue();
    syncSpeakerRequests().catch(() => {});
  }
  if (focus && (name === 'chat' || name === 'questions')) window.setTimeout(() => document.getElementById('chatInput')?.focus(), 0);
  window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function renderParticipants(participants = []) {
  const container = document.getElementById('participantsList'); container.replaceChildren();
  const participantItems = [];
  for (const participant of participants) {
    const row = document.createElement('article'); row.className = 'participant-card';
    const info = document.createElement('div');
    const media = participantMediaState(participant);
    const permission = participant.permissions || participant.permission || {};
    const pendingHand = handQueue.list().find((item) => item.identity === participant.identity && item.status === 'PENDING');
    const temporarySpeaker = participantRoleCode(participant) === 'ATTENDEE' && participantCanPublishSource(participant, 'MICROPHONE');
    const compactActions = [];
    if (isOrganizer() && !participant.isLocal) {
      if (pendingHand && !temporarySpeaker) compactActions.push('grantWord');
      else if (temporarySpeaker) compactActions.push('revokeWord');
      if (!media.microphone) compactActions.push('requestMicrophone');
      compactActions.push('more');
    }
    participantItems.push({
      identity: participant.identity,
      name: participantName(participant),
      roleLabel: participantRole(participant),
      meetingRole: participantRoleCode(participant),
      microphone: media.microphone,
      camera: media.camera,
      screen: media.screen,
      handRaised: Boolean(pendingHand),
      canPublish: permission.canPublish === true,
      isLocal: participant.isLocal === true,
      actions: compactActions,
      volume: ui.participantVolumes.get(participant.identity) ?? 1,
    });
    const qualityLabels = { EXCELLENT: 'excelente', GOOD: 'buena', POOR: 'inestable', LOST: 'sin conexión' };
    const qualityValue = String(participant.connectionQuality || '').toUpperCase();
    const quality = isOrganizer() && qualityValue ? ` · Red ${qualityLabels[qualityValue] || 'desconocida'}` : '';
    if (participant.isLocal) {
      ui.microphone = media.microphone;
      ui.camera = media.camera;
      setButtonState(document.getElementById('btnMic'), ui.microphone, 'Silenciar micrófono', 'Activar micrófono', { locked: !hasPublishPermission('MICROPHONE'), lockedLabel: 'Micrófono bloqueado por el anfitrión' });
      setButtonState(document.getElementById('btnCam'), ui.camera, 'Apagar cámara', 'Encender cámara', { locked: !hasPublishPermission('CAMERA'), lockedLabel: 'Cámara bloqueada por el anfitrión' });
      floatingModel.update({ microphone: ui.microphone, camera: ui.camera });
      if (media.camera && media.cameraPublication?.track) ui.stage?.setTrack(participant.identity, `${participantName(participant)} (tú)`, 'camera', media.cameraPublication.track, { muted: true, local: true });
      else ui.stage?.removeTrack(participant.identity, 'camera');
    }
    if (participant.identity) {
      ui.stage?.setParticipantState(participant.identity, `${participantName(participant)}${participant.isLocal ? ' (tú)' : ''}`, {
        microphone: media.microphone,
        role: participantRole(participant),
        roleCode: participantRoleCode(participant),
        eligible: participantRoleCode(participant) !== 'ATTENDEE' || temporarySpeaker,
        local: participant.isLocal,
        keepVisible: true,
      });
    }
    const joinedAt = participantJoinedAt(participant);
    const joined = joinedAt ? ` · Entró ${new Date(joinedAt).toLocaleTimeString('es-EC', { hour: '2-digit', minute: '2-digit' })}` : '';
    const hand = pendingHand ? ' · Mano levantada' : '';
    info.append(
      Object.assign(document.createElement('strong'), { textContent: participantName(participant) }),
      Object.assign(document.createElement('span'), { textContent: `${participantRole(participant)} · Mic ${media.microphone ? 'activo' : 'apagado'} · Cámara ${media.camera ? 'activa' : 'apagada'} · Pantalla ${media.screen ? 'activa' : 'apagada'}${hand}${joined}${quality}` })
    );
    if (!participant.isLocal) {
      ui.stageEvents?.setParticipantVolume(participant.identity, ui.participantVolumes.get(participant.identity) ?? 1);
      const volumeLabel = document.createElement('label');
      volumeLabel.className = 'participant-volume';
      const value = document.createElement('output');
      const initial = Math.round((ui.participantVolumes.get(participant.identity) ?? 1) * 100);
      value.textContent = `${initial}%`;
      const slider = document.createElement('input');
      slider.type = 'range'; slider.min = '0'; slider.max = '100'; slider.step = '5'; slider.value = String(initial);
      slider.setAttribute('aria-label', `Volumen de ${participantName(participant)}`);
      slider.addEventListener('input', () => {
        const next = Number(slider.value) / 100;
        ui.participantVolumes.set(participant.identity, next);
        ui.stageEvents?.setParticipantVolume(participant.identity, next);
        value.textContent = `${slider.value}%`;
      });
      volumeLabel.append(document.createTextNode('Volumen'), slider, value);
      info.appendChild(volumeLabel);
    }
    row.appendChild(info);
    if (isOrganizer() && !participant.isLocal) {
      const actions = document.createElement('div'); actions.className = 'participant-actions';
      if (pendingHand && !temporarySpeaker) {
        actions.append(
          actionButton('Dar palabra', () => promoteParticipant(pendingHand), 'primary compact'),
          actionButton('Rechazar', () => rejectHand(pendingHand)),
        );
      } else if (temporarySpeaker) actions.appendChild(actionButton('Quitar palabra', () => demoteParticipant(participant.identity)));
      if (media.microphone) actions.appendChild(actionButton('Silenciar', () => muteParticipant(participant.identity)));
      else actions.appendChild(actionButton('Solicitar activar micrófono', () => requestParticipantMedia(participant.identity, 'request-microphone')));
      const more = document.createElement('details'); more.className = 'participant-more';
      const summary = document.createElement('summary'); summary.textContent = 'Más acciones';
      const menu = document.createElement('div'); menu.className = 'participant-more-menu';
      if (media.camera) menu.appendChild(actionButton('Solicitar apagar cámara', () => requestParticipantMedia(participant.identity, 'request-camera-off')));
      if (temporarySpeaker) menu.appendChild(actionButton('Revocar palabra', () => demoteParticipant(participant.identity)));
      else if (participantRoleCode(participant) === 'ATTENDEE') menu.appendChild(actionButton('Conceder palabra temporal', () => promoteParticipant({ identity: participant.identity })));
      if (ui.session.meeting.type === 'CLASS' && participantRoleCode(participant) === 'STUDENT') {
        const screenGranted = participantCanPublishSource(participant, 'SCREENSHARE');
        menu.appendChild(actionButton(screenGranted ? 'Retirar pantalla' : 'Autorizar pantalla', () => changeParticipantPermission(participant.identity, 'screen', !screenGranted)));
      }
      for (const role of RATCore.MEETING_ROLES[ui.session.meeting.type] || []) {
        if (role === participantRoleCode(participant) || ['HOST', 'TEACHER'].includes(role)) continue;
        if (role === 'COHOST' && !['HOST', 'TEACHER'].includes(ui.session.meetingRole)) continue;
        menu.appendChild(actionButton(`Cambiar a ${RATCore.roleLabel(role)}`, () => changeParticipantRole(participant.identity, role)));
      }
      menu.append(
        actionButton('Expulsar', () => removeParticipant(participant.identity), 'danger compact'),
        actionButton('Bloquear acceso', () => blockParticipant(participant.identity), 'danger compact'),
      );
      more.append(summary, menu); actions.appendChild(more); row.appendChild(actions);
    }
    container.appendChild(row);
  }
  floatingModel.update({ participantItems });
  updatePinnedSpeakers(participants);
  if (participants.length <= 1 && isOrganizer()) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact participants-empty';
    empty.append(
      Object.assign(document.createElement('strong'), { textContent: 'Esperando participantes…' }),
      Object.assign(document.createElement('span'), { textContent: 'Comparte un enlace seguro para invitar anfitriones o participantes.' }),
      actionButton('Copiar enlace de participante', () => createInRoomAccess('PARTICIPANT'), 'primary compact'),
      actionButton('Copiar enlace de anfitrión', () => createInRoomAccess('HOST'), 'secondary compact'),
    );
    container.appendChild(empty);
  }
}

function updatePinnedSpeakers(participants = []) {
  const select = document.getElementById('pinnedSpeaker');
  if (!select) return;
  const previous = ui.pinnedSpeakerIdentity || select.value;
  const eligible = participants.filter((participant) => participantRoleCode(participant) !== 'ATTENDEE' || participantCanPublishSource(participant, 'MICROPHONE'));
  const signature = eligible.map((participant) => participant.identity).join('|');
  if (select.dataset.signature !== signature) {
    select.dataset.signature = signature;
    select.replaceChildren();
    for (const participant of eligible) select.appendChild(new Option(`${participantName(participant)} · ${participantRole(participant)}`, participant.identity));
  }
  if (eligible.some((participant) => participant.identity === previous)) select.value = previous;
  ui.pinnedSpeakerIdentity = select.value || null;
}

function actionButton(label, action, className = 'secondary compact') {
  const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.onclick = action; return button;
}

function renderHandQueue() {
  const items = handQueue.list();
  updateCounter('handCount', items.filter((item) => item.status === 'PENDING').length);
  floatingModel.update({ raisedHands: items.filter((item) => item.status === 'PENDING').length });
  const container = document.getElementById('handQueue'); container.replaceChildren();
  if (!isOrganizer() && !ui.session.capabilities?.canModerateChat) return;
  for (const item of items) {
    const row = document.createElement('article'); row.className = 'hand-card';
    const handStatus = { PENDING: 'Pendiente', GRANTED: 'Con palabra', REJECTED: 'Rechazada' }[item.status] || 'Pendiente';
    const info = document.createElement('div'); info.append(Object.assign(document.createElement('strong'), { textContent: `${item.order}. ${item.displayName}` }), Object.assign(document.createElement('span'), { textContent: `${new Date(item.raisedAt).toLocaleTimeString('es-EC')} · ${handStatus}` })); row.appendChild(info);
    const actions = document.createElement('div');
    if (isOrganizer()) {
      const contextualActions = item.status === 'PENDING'
        ? [['Dar palabra', () => promoteParticipant(item)], ['Rechazar', () => rejectHand(item)]]
        : item.status === 'GRANTED' ? [['Quitar palabra', () => demoteParticipant(item.identity)]] : [];
      for (const [label, action] of contextualActions) {
        const button = document.createElement('button'); button.type = 'button'; button.className = label === 'Dar palabra' ? 'primary compact' : 'secondary compact'; button.textContent = label; button.onclick = action; actions.appendChild(button);
      }
    }
    row.appendChild(actions); container.appendChild(row);
  }
}

async function syncSpeakerRequests() {
  if (!ui.session) return [];
  const result = await roomRequest('/api/room/speaker-requests');
  const items = (result.items || []).map((item) => ({
    identity: item.participantIdentity,
    displayName: item.participantName,
    raisedAt: item.requestedAt,
    status: item.status,
  }));
  handQueue.replace(items);
  const ownRequest = items.find((item) => item.identity === ui.session.identity);
  ui.handRaised = ownRequest?.status === 'PENDING';
  floatingModel.update({ handRaised: ui.handRaised });
  setButtonState(document.getElementById('btnHand'), ui.handRaised, 'Cancelar', 'Mano');
  renderHandQueue();
  ui.roomUi?.updateCount();
  return items;
}

async function promoteParticipant(item) {
  try {
    await roomRequest('/api/participants/promote', { method: 'POST', body: { targetIdentity: item.identity } }, ui.session.csrfToken);
    await syncSpeakerRequests();
  } catch (error) { showMessage(error.message, true); }
}

async function rejectHand(item) {
  try {
    await ui.chat.sendSystem({ kind: 'hand-rejected', targetIdentity: item.identity });
    await syncSpeakerRequests();
  } catch (error) { showMessage(error.message, true); }
}

async function removeParticipant(identity) {
  if (!await askConfirmation({ title: 'Expulsar participante', message: 'La persona perderá el acceso inmediato a esta reunión.', confirmLabel: 'Expulsar', danger: true })) return;
  try { await roomRequest('/api/participants/remove', { method: 'POST', body: { targetIdentity: identity } }, ui.session.csrfToken); } catch (error) { showMessage(error.message, true); }
}

async function blockParticipant(identity) {
  if (!await askConfirmation({ title: 'Bloquear acceso', message: 'La persona será expulsada y, si ingresó con invitación, ese enlace quedará revocado para impedir el reingreso.', confirmLabel: 'Bloquear acceso', danger: true })) return;
  try { await roomRequest('/api/participants/block', { method: 'POST', body: { targetIdentity: identity } }, ui.session.csrfToken); }
  catch (error) { showMessage(error.message, true); }
}

async function requestParticipantMedia(targetIdentity, action) {
  try {
    await roomRequest('/api/participants/request-media', { method: 'POST', body: { targetIdentity, action } }, ui.session.csrfToken);
    showMessage(action === 'request-microphone' ? 'Se solicitó al participante que active su micrófono.' : 'Se solicitó al participante que apague su cámara.');
  } catch (error) { showMessage(error.message, true); }
}

async function waitForPublishPermission(timeoutMs = 4_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (hasPublishPermission('MICROPHONE')) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return hasPublishPermission('MICROPHONE');
}

async function respondToMediaRequest(requestId, status) {
  return roomRequest('/api/participants/media-response', { method: 'POST', body: { requestId, status } }, ui.session.csrfToken);
}

async function handleMicrophoneRequest(message) {
  if (!message.requestId || ui.pendingMicrophoneRequestId) return;
  ui.pendingMicrophoneRequestId = message.requestId;
  try {
    const accepted = await askConfirmation({
      title: 'Solicitud de micrófono',
      message: `${message.from || 'El organizador'} solicita que actives tu micrófono. La plataforma no lo encenderá sin tu confirmación.`,
      confirmLabel: 'Activar micrófono',
      cancelLabel: 'Ahora no',
    });
    if (!accepted) {
      await respondToMediaRequest(message.requestId, 'rejected');
      showMessage('Rechazaste la solicitud de activar el micrófono.');
      return;
    }
    await respondToMediaRequest(message.requestId, 'accepted');
    if (!await waitForPublishPermission()) throw new Error('LiveKit no actualizó tu permiso para publicar audio.');
    const activated = ui.microphone || await toggleMicrophone();
    await respondToMediaRequest(message.requestId, activated ? 'activated' : 'failed');
    if (!activated) throw new Error('No se pudo publicar el micrófono. Revisa el permiso del navegador y vuelve a intentarlo.');
    showMessage('Micrófono activado con tu consentimiento.');
  } catch (error) {
    await respondToMediaRequest(message.requestId, 'failed').catch(() => {});
    showMessage(error.message, true);
  } finally {
    ui.pendingMicrophoneRequestId = null;
  }
}

async function muteParticipant(targetIdentity) {
  try { await roomRequest('/api/participants/mute', { method: 'POST', body: { targetIdentity } }, ui.session.csrfToken); } catch (error) { showMessage(error.message, true); }
}

async function demoteParticipant(targetIdentity) {
  try {
    await roomRequest('/api/participants/demote', { method: 'POST', body: { targetIdentity } }, ui.session.csrfToken);
    await syncSpeakerRequests();
    showMessage('Se retiró el permiso temporal para publicar.');
  } catch (error) { showMessage(error.message, true); }
}

async function changeParticipantRole(targetIdentity, meetingRole) {
  if (!await askConfirmation({ title: 'Cambiar función', message: `La persona pasará a ${RATCore.roleLabel(meetingRole)} y sus permisos multimedia se actualizarán inmediatamente.`, confirmLabel: 'Cambiar función' })) return;
  try {
    await roomRequest('/api/participants/role', { method: 'POST', body: { targetIdentity, meetingRole } }, ui.session.csrfToken);
    showMessage(`Función actualizada a ${RATCore.roleLabel(meetingRole)}.`);
    ui.roomUi?.updateCount();
  } catch (error) { showMessage(error.message, true); }
}

async function changeParticipantPermission(targetIdentity, source, granted) {
  try {
    await roomRequest('/api/participants/permissions', { method: 'POST', body: { targetIdentity, source, granted } }, ui.session.csrfToken);
    showMessage(granted ? 'Permiso multimedia concedido.' : 'Permiso multimedia retirado.');
    ui.roomUi?.updateCount();
  } catch (error) { showMessage(error.message, true); }
}

async function toggleHand() {
  if (!ui.room) return;
  ui.handRaised = !ui.handRaised;
  setButtonState(document.getElementById('btnHand'), ui.handRaised, 'Cancelar', 'Mano');
  floatingModel.update({ handRaised: ui.handRaised });
  await ui.chat.sendSystem({ kind: ui.handRaised ? 'hand-raise' : 'hand-lower', identity: ui.session.identity, displayName: ui.session.displayName, raisedAt: new Date().toISOString() });
  await syncSpeakerRequests();
}

async function selfDemote() {
  await roomRequest('/api/participants/self-demote', { method: 'POST', body: {} }, ui.session.csrfToken);
}

function renderReaction(reaction, from = '') {
  const overlay = document.getElementById('reactionOverlay');
  const bubble = document.createElement('span');
  bubble.className = 'reaction-bubble';
  bubble.textContent = reaction;
  bubble.title = from ? `${from}: ${reaction}` : reaction;
  bubble.style.setProperty('--reaction-left', `${18 + Math.round(Math.random() * 64)}%`);
  overlay.appendChild(bubble);
  clearTimeout(ui.reactionTimer);
  floatingModel.update({ recentReaction: reaction });
  ui.reactionTimer = setTimeout(() => floatingModel.update({ recentReaction: '' }), 3_000);
  setTimeout(() => bubble.remove(), 3_000);
}

function renderRoomLock(locked) {
  ui.locked = locked === true;
  const badge = document.getElementById('roomLockBadge');
  badge.hidden = !ui.locked;
  const button = document.getElementById('btnLock');
  if (button) {
    button.textContent = ui.locked ? 'Desbloquear sala' : 'Bloquear sala';
    button.setAttribute('aria-pressed', String(ui.locked));
  }
  floatingModel.update({ locked: ui.locked });
}

function handleData(payload, participant) {
  try {
    const message = JSON.parse(new TextDecoder().decode(payload));
    if (message.kind === 'hand-raise' && (ui.session.capabilities?.canManageParticipants || ui.session.capabilities?.canModerateChat)) {
      handQueue.raise(message.identity || participant?.identity, message.displayName || participantName(participant), message.raisedAt);
      renderHandQueue(); ui.roomUi?.updateCount(); playAlert('hand'); systemNotification('Mano levantada', `${message.displayName || participantName(participant)} solicitó la palabra.`);
      notifier.notify('hand-raised', { title: 'Mano levantada', message: `${message.displayName || participantName(participant)} solicitó la palabra.`, system: false });
    }
    if (message.kind === 'hand-lower') { handQueue.remove(participant?.identity || message.identity); renderHandQueue(); ui.roomUi?.updateCount(); }
    if (message.kind === 'hand-approved' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; floatingModel.update({ handRaised: false }); setButtonState(document.getElementById('btnHand'), false, 'Cancelar', 'Mano'); renderMediaPermissions(); showWordGrantNotice(); }
    if (message.kind === 'hand-rejected' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; floatingModel.update({ handRaised: false }); setButtonState(document.getElementById('btnHand'), false, 'Cancelar', 'Mano'); showMessage('La solicitud fue cerrada por el organizador.'); }
    if (message.kind === 'word-revoked' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; if (ui.screen) finishScreenShare(true); renderMediaPermissions(); showMessage('El organizador retiró el permiso para hablar.'); }
    if (message.kind === 'permission-changed' && message.targetIdentity === ui.session.identity) {
      ui.session.publishSources = message.publishSources || [];
      renderMediaPermissions();
      showMessage(message.granted ? `El anfitrión habilitó ${message.source}.` : `El anfitrión retiró el permiso de ${message.source}.`);
    }
    if (message.kind === 'role-changed') {
      if (message.targetIdentity === ui.session.identity) {
        ui.session.meetingRole = message.meetingRole;
        ui.session.publishSources = message.publishSources || [];
        ui.session.capabilities = RATCore.meetingRoleCapabilities(ui.session.meeting.type, message.meetingRole);
        document.getElementById('meetingRoleBadge').textContent = RATCore.roleLabel(message.meetingRole);
        renderMediaPermissions();
        configureMeetingMode();
        showMessage(`Tu función cambió a ${RATCore.roleLabel(message.meetingRole)}.`);
      }
      ui.roomUi?.updateCount();
    }
    if (message.kind === 'recording-status') recordingMachine.set(message.state, {
      active: message.state === 'RECORDING' && message.active === true,
      egressId: message.egressId || null,
    });
    if (message.kind === 'external-stream-status') renderFacebookState(message);
    if (message.kind === 'reaction') { renderReaction(message.reaction, message.from); playAlert('reaction'); }
    if (message.kind === 'room-lock') {
      renderRoomLock(message.locked);
      notifier.notify('room-lock', { title: message.locked ? 'Sala bloqueada' : 'Sala desbloqueada', message: message.locked ? 'No se admitirán nuevos accesos.' : 'Las invitaciones vuelven a admitir accesos.', tone: message.locked ? 'info' : 'success' });
    }
    if (message.kind === 'request-microphone') {
      notifier.notify(`request-microphone-${message.requestId}`, {
        title: 'Solicitud del organizador',
        message: `${message.from || 'El organizador'} solicita que actives tu micrófono.`,
        actionLabel: 'Responder',
        onAction: () => handleMicrophoneRequest(message),
        secondaryLabel: 'Ahora no',
        onSecondary: () => respondToMediaRequest(message.requestId, 'rejected').catch((error) => showMessage(error.message, true)),
        duration: 60_000,
        sound: 'hand',
      });
    }
    if (message.kind === 'media-response') {
      const labels = {
        accepted: `${message.displayName || 'El participante'} aceptó y está activando su micrófono.`,
        activated: `${message.displayName || 'El participante'} activó su micrófono.`,
        rejected: `${message.displayName || 'El participante'} rechazó activar su micrófono.`,
        failed: `${message.displayName || 'El participante'} no pudo publicar su micrófono.`,
      };
      showMessage(labels[message.status] || 'La solicitud de micrófono cambió de estado.', ['rejected', 'failed'].includes(message.status));
    }
    if (message.kind === 'request-camera-off' && ui.camera) notifier.notify('request-camera-off', { title: 'Solicitud del organizador', message: `${message.from || 'El organizador'} te solicita apagar la cámara.`, actionLabel: 'Apagar', onAction: toggleCamera, sound: 'hand' });
    if (message.kind === 'screen-status' && message.identity !== ui.session.identity) notifier.notify(`screen-${message.identity}`, { title: message.event === 'screen-started' ? 'Pantalla compartida' : 'Pantalla detenida', message: `${message.displayName || 'Un participante'} ${message.event === 'screen-started' ? 'empezó a compartir.' : 'dejó de compartir.'}`, sound: 'message' });
  } catch { /* Other binary data is ignored. */ }
}

function renderMediaPermissions() {
  const previousTemporaryMicrophone = ui.temporaryMicrophoneAllowed;
  const microphoneAllowed = hasPublishPermission('MICROPHONE');
  const cameraAllowed = hasPublishPermission('CAMERA');
  const screenAllowed = hasPublishPermission('SCREENSHARE');
  const screenSupported = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const screenCompatibilityHelp = document.getElementById('screenCompatibilityHelp');
  screenCompatibilityHelp.hidden = screenSupported || !screenAllowed;
  document.getElementById('btnScreenMore').title = !screenSupported
    ? 'Compartir pantalla no está disponible en este navegador. Usa un computador o navegador compatible.'
    : screenAllowed ? 'Compartir pantalla' : 'Pantalla bloqueada por el anfitrión';
  document.getElementById('btnMic').hidden = ui.session?.meetingRole === 'ATTENDEE' && !microphoneAllowed;
  document.getElementById('btnMic').disabled = !microphoneAllowed;
  document.getElementById('btnCam').disabled = !cameraAllowed;
  document.getElementById('btnScreen').disabled = !screenAllowed || !screenSupported;
  document.getElementById('btnScreenMore').disabled = !screenAllowed || !screenSupported;
  document.getElementById('btnEffects').disabled = !cameraAllowed;
  setButtonState(document.getElementById('btnMic'), ui.microphone, 'Silenciar micrófono', 'Activar micrófono', { locked: !microphoneAllowed, lockedLabel: 'Micrófono bloqueado por el anfitrión' });
  setButtonState(document.getElementById('btnCam'), ui.camera, 'Apagar cámara', 'Encender cámara', { locked: !cameraAllowed, lockedLabel: 'Cámara bloqueada por el anfitrión' });
  setButtonState(document.getElementById('btnScreen'), ui.screen, 'Detener pantalla', 'Compartir pantalla', { locked: !screenAllowed || !screenSupported, lockedLabel: screenSupported ? 'Pantalla bloqueada por el anfitrión' : 'Pantalla no compatible con este navegador' });
  if (!microphoneAllowed) ui.microphone = false;
  if (!cameraAllowed) ui.camera = false;
  if (!screenAllowed && ui.screen) finishScreenShare(true);
  floatingModel.update({ microphone: ui.microphone, camera: ui.camera, screen: ui.screen });
  if (ui.session?.capabilities?.canRaiseHand) {
    const handButton = document.getElementById('btnHand');
    const temporaryMicrophone = microphoneAllowed && !['PANELIST', 'PARTICIPANT', 'STUDENT', 'MODERATOR', 'HOST', 'TEACHER', 'COHOST'].includes(ui.session.meetingRole);
    ui.temporaryMicrophoneAllowed = temporaryMicrophone;
    if (previousTemporaryMicrophone === false && temporaryMicrophone) showWordGrantNotice();
    if (temporaryMicrophone) {
      handButton.onclick = async () => { try { await selfDemote(); } catch (error) { showMessage(error.message, true); } };
      setButtonState(handButton, true, 'Bajar mano', 'Mano');
      floatingModel.update({ handRaised: true });
    } else {
      handButton.onclick = toggleHand;
      setButtonState(handButton, ui.handRaised, 'Cancelar', 'Mano');
      floatingModel.update({ handRaised: ui.handRaised });
    }
  }
}

function withMediaTimeout(operation, label, timeoutMs = 12_000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(`${label} no respondió. Revisa los permisos y el dispositivo antes de reintentar.`)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => clearTimeout(timeoutId));
}

async function toggleMicrophone() {
  if (!ui.room || !hasPublishPermission('MICROPHONE') || ui.microphoneBusy) return false;
  const micButton = document.getElementById('btnMic');
  ui.microphoneBusy = true; micButton.disabled = true; micButton.setAttribute('aria-busy', 'true');
  micButton.querySelector('span:last-child').textContent = ui.microphone ? 'Silenciando…' : 'Solicitando…';
  try {
    const next = !ui.microphone;
    await withMediaTimeout(ui.room.localParticipant.setMicrophoneEnabled(next), 'El micrófono');
    const publication = ui.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
    ui.microphone = publicationHasLiveTrack(publication, 'audio');
    if (next && !ui.microphone) throw new Error('LiveKit no confirmó un track de micrófono publicado. Revisa el permiso del navegador.');
    setButtonState(document.getElementById('btnMic'), ui.microphone, 'Silenciar micrófono', 'Activar micrófono'); floatingModel.update({ microphone: ui.microphone });
    ui.stage?.setParticipantState(ui.session.identity, `${ui.session.displayName} (tú)`, { microphone: ui.microphone, local: true, keepVisible: true });
    if (!ui.microphone) roomRequest('/api/room/media-state', { method: 'POST', body: { event: 'microphone-muted' } }, ui.session.csrfToken).catch(() => {});
    return ui.microphone === next;
  } catch (error) { setButtonState(micButton, ui.microphone, 'Silenciar micrófono', 'Activar micrófono'); micButton.title = 'Permiso bloqueado o dispositivo no disponible. Habilítalo desde el icono de permisos del sitio.'; showMessage(`Micrófono: ${RATCore.mediaDeviceErrorMessage(error, 'micrófono')}`, true); return false; }
  finally { ui.microphoneBusy = false; document.getElementById('btnMic').disabled = !hasPublishPermission('MICROPHONE'); document.getElementById('btnMic').setAttribute('aria-busy', 'false'); }
}

async function toggleCamera() {
  if (!ui.room || !hasPublishPermission('CAMERA') || ui.cameraBusy) return false;
  const camButton = document.getElementById('btnCam');
  ui.cameraBusy = true; camButton.disabled = true; camButton.setAttribute('aria-busy', 'true');
  camButton.querySelector('span:last-child').textContent = ui.camera ? 'Apagando…' : 'Solicitando…';
  try {
    const next = !ui.camera;
    await withMediaTimeout(ui.room.localParticipant.setCameraEnabled(next), 'La cámara');
    const publication = ui.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
    ui.camera = publicationHasLiveTrack(publication, 'video');
    if (next && !ui.camera) {
      await ui.room.localParticipant.setCameraEnabled(false).catch(() => {});
      throw new Error('No se pudo publicar la cámara: LiveKit no confirmó un track de video activo.');
    }
    setButtonState(document.getElementById('btnCam'), ui.camera, 'Apagar cámara', 'Encender cámara'); floatingModel.update({ camera: ui.camera });
    if (ui.camera && publication?.track) ui.stage.setTrack(ui.session.identity, `${ui.session.displayName} (tú)`, 'camera', publication.track, { muted: true });
    else ui.stage.removeTrack(ui.session.identity, 'camera');
    ui.stage.setParticipantState(ui.session.identity, `${ui.session.displayName} (tú)`, { microphone: ui.microphone, local: true, keepVisible: true });
    return ui.camera === next;
  } catch (error) { setButtonState(camButton, ui.camera, 'Apagar cámara', 'Encender cámara'); camButton.title = 'Permiso bloqueado o dispositivo no disponible. Habilítalo desde el icono de permisos del sitio.'; showMessage(`Cámara: ${RATCore.mediaDeviceErrorMessage(error, 'cámara')}`, true); return false; }
  finally { ui.cameraBusy = false; document.getElementById('btnCam').disabled = !hasPublishPermission('CAMERA'); document.getElementById('btnCam').setAttribute('aria-busy', 'false'); }
}

async function toggleScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) return showMessage('Compartir pantalla no está disponible en este dispositivo o navegador.', true);
  if (!hasPublishPermission('SCREENSHARE')) return showMessage('Tu función no permite compartir pantalla. Solicita autorización al anfitrión.', true);
  if (ui.screenBusy) return;
  const button = document.getElementById('btnScreen');
  ui.screenBusy = true;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.querySelector('span:last-child').textContent = ui.screen ? 'Deteniendo…' : 'Seleccionando…';
  try {
    const next = !ui.screen;
    await withMediaTimeout(ui.room.localParticipant.setScreenShareEnabled(next, { audio: true }), 'La selección de pantalla');
    const screenPublication = ui.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
    ui.screen = publicationHasLiveTrack(screenPublication, 'video');
    if (next && !ui.screen) {
      await ui.room.localParticipant.setScreenShareEnabled(false).catch(() => {});
      throw new Error('No se encontró un track de pantalla válido después de compartir.');
    }
    setButtonState(button, ui.screen, 'Detener', 'Pantalla');
    document.getElementById('btnScreenMore').textContent = ui.screen ? 'Detener pantalla' : 'Compartir pantalla';
    button.title = ui.screen ? 'Detener pantalla compartida' : 'Compartir pantalla';
    button.setAttribute('aria-label', ui.screen ? 'Detener pantalla compartida' : 'Compartir pantalla');
    floatingModel.update({ screen: ui.screen });
    document.getElementById('screenShareNotice').hidden = !ui.screen;
    if (ui.screen) {
      const audioPublication = ui.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShareAudio);
      ui.stage.setSelfSharePlaceholder(ui.session.identity, `${ui.session.displayName} (pantalla)`, { audio: Boolean(audioPublication?.track) });
      document.getElementById('screenShareAudioState').textContent = audioPublication?.track ? 'Audio de pantalla incluido.' : 'Sin audio de pantalla.';
      ui.screenEndedHandler = () => finishScreenShare(true);
      screenPublication.track.mediaStreamTrack?.addEventListener('ended', ui.screenEndedHandler, { once: true });
      notifier.notify('screen-share-started', {
        title: 'Pantalla compartida',
        message: 'Mantén los controles a mano mientras presentas.',
        actionLabel: 'Abrir controles flotantes',
        onAction: () => ui.companion?.open(),
        tone: 'success',
      });
      if (document.getElementById('autoFloatOnShare').checked) ui.companion?.open().catch((error) => showMessage(error.message, true));
      await roomRequest('/api/room/media-state', { method: 'POST', body: { event: 'screen-started' } }, ui.session.csrfToken).catch(() => {});
    } else await finishScreenShare(false);
  } catch (error) { setButtonState(button, ui.screen, 'Detener', 'Pantalla'); showMessage(`Pantalla: ${RATCore.mediaDeviceErrorMessage(error, 'selector de pantalla')}`, true); }
  finally {
    ui.screenBusy = false;
    button.disabled = !hasPublishPermission('SCREENSHARE') || !navigator.mediaDevices?.getDisplayMedia;
    document.getElementById('btnScreenMore').disabled = button.disabled;
    button.setAttribute('aria-busy', 'false');
  }
}

async function finishScreenShare(browserEnded = false) {
  const wasActive = ui.screen;
  ui.screen = false;
  ui.stage?.removeTrack(ui.session?.identity, 'screen');
  document.getElementById('screenShareNotice').hidden = true;
  setButtonState(document.getElementById('btnScreen'), false, 'Detener', 'Pantalla');
  document.getElementById('btnScreen').setAttribute('aria-label', 'Compartir pantalla');
  document.getElementById('btnScreenMore').textContent = 'Compartir pantalla';
  floatingModel.update({ screen: false });
  if (wasActive || browserEnded) await roomRequest('/api/room/media-state', { method: 'POST', body: { event: 'screen-stopped' } }, ui.session.csrfToken).catch(() => {});
}

async function loadEffects() {
  if (ui.effectsLoaded) return;
  await new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = '/vendor/track-processors.bundle.js';
    script.onload = resolve;
    script.onerror = () => reject(new Error('No se pudo cargar el módulo de efectos.'));
    document.head.appendChild(script);
  });
  ui.effectsLoaded = true;
}

async function applyCameraEffect(type, imageUrl = null) {
  if (!ui.camera) throw new Error('Activa la cámara antes de aplicar un efecto.');
  await loadEffects();
  const publication = ui.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
  const track = publication?.track;
  if (!track) throw new Error('No se encontró la pista de cámara activa.');
  if (type === 'blur') await track.setProcessor(TrackProcessors.BackgroundBlur(10));
  else if (type === 'image' && imageUrl) await track.setProcessor(TrackProcessors.VirtualBackground(imageUrl));
  else await track.stopProcessor?.();
  if (type !== 'image' && ui.backgroundObjectUrl) {
    URL.revokeObjectURL(ui.backgroundObjectUrl);
    ui.backgroundObjectUrl = null;
  }
  showMessage(type === 'none' ? 'Efecto de cámara retirado.' : 'Efecto de cámara aplicado.');
}

async function compressedBackgroundUrl(file) {
  if (!file.type.startsWith('image/') || file.size > 5 * 1024 * 1024) throw new Error('Usa una imagen JPG, PNG o WebP de hasta 5 MB.');
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / bitmap.width, 720 / bitmap.height);
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/webp', 0.78));
  if (!blob) throw new Error('No se pudo preparar la imagen de fondo.');
  return URL.createObjectURL(blob);
}

async function queryRecordingStatus() {
  if (!ui.recordingConfigured || !ui.session?.meeting.allowRecording) {
    recordingMachine.set('DISABLED');
    return recordingMachine.emit();
  }
  try {
    const result = await roomRequest('/api/recording/status');
    const snapshot = recordingMachine.set(result.state, { active: result.active === true, egressId: result.egressId, message: result.message });
    clearTimeout(recordingPollTimer);
    if (snapshot.busy) recordingPollTimer = window.setTimeout(queryRecordingStatus, 1_500);
    return snapshot;
  } catch {
    return recordingMachine.set('FAILED', { active: false, message: 'No fue posible consultar el estado real de la grabación.' });
  }
}

async function toggleRecording() {
  if (!ui.session?.capabilities?.canManageRecording) return;
  const current = recordingMachine.emit();
  if (current.busy || current.state === 'DISABLED') return;
  if (!current.active) {
    const confirmed = await askConfirmation({
      title: 'Iniciar grabación',
      message: 'Se avisará a todos los participantes. La grabación solo aparecerá activa cuando Egress lo confirme.',
      confirmLabel: 'Iniciar grabación',
    });
    if (!confirmed) return;
  }
  recordingMachine.set(current.active ? 'STOPPING' : 'STARTING');
  try {
    const result = current.active
      ? await roomRequest('/api/recording/stop', { method: 'POST', body: { egressId: current.egressId } }, ui.session.csrfToken)
      : await roomRequest('/api/recording/start', { method: 'POST', body: {} }, ui.session.csrfToken);
    recordingMachine.set(result.state, { active: result.active === true, egressId: result.egressId });
    if (result.state === 'STARTING' || result.state === 'STOPPING') {
      clearTimeout(recordingPollTimer);
      recordingPollTimer = window.setTimeout(queryRecordingStatus, 1_500);
    }
  } catch (error) {
    recordingMachine.set('FAILED', { active: false, message: error.message });
    showMessage(error.message, true);
  }
}

async function queryFacebookStatus() {
  try {
    return renderFacebookState(await roomRequest('/api/facebook-live/status'));
  } catch {
    return renderFacebookState({ state: 'ERROR', active: false, message: 'No fue posible consultar la señal externa.' });
  }
}

function clearFacebookCredentials() {
  const server = document.getElementById('facebookServerUrl');
  const key = document.getElementById('facebookStreamKey');
  if (server) server.value = '';
  if (key) key.value = '';
}

function openFacebookDialog() {
  clearFacebookCredentials();
  document.getElementById('facebookLiveError').textContent = '';
  document.getElementById('facebookLiveDialog').showModal();
  document.getElementById('facebookServerUrl').focus();
}

async function startFacebookLive(event) {
  event.preventDefault();
  if (!ui.session?.capabilities?.canManageRecording) return;
  const button = document.getElementById('facebookLiveStart');
  const error = document.getElementById('facebookLiveError');
  const payload = {
    serverUrl: document.getElementById('facebookServerUrl').value,
    streamKey: document.getElementById('facebookStreamKey').value,
  };
  document.getElementById('facebookStreamKey').value = '';
  button.disabled = true;
  button.textContent = 'Iniciando…';
  error.textContent = '';
  try {
    const result = await roomRequest('/api/facebook-live/start', { method: 'POST', body: payload }, ui.session.csrfToken);
    payload.streamKey = '';
    clearFacebookCredentials();
    document.getElementById('facebookLiveDialog').close();
    renderFacebookState(result);
  } catch (requestError) {
    payload.streamKey = '';
    renderFacebookState({ state: 'ERROR', active: false, message: requestError.message });
    error.textContent = requestError.message;
  } finally {
    button.disabled = false;
    button.textContent = 'Iniciar transmisión';
  }
}

async function stopFacebookLive() {
  if (!ui.session?.capabilities?.canManageRecording || !ui.facebookEgressId) return;
  const confirmed = await askConfirmation({
    title: 'Detener Facebook Live',
    message: 'Se detendrá únicamente la señal externa. La reunión y la grabación continuarán.',
    confirmLabel: 'Detener Facebook Live',
    danger: true,
  });
  if (!confirmed) return;
  const button = document.getElementById('btnFacebookStop');
  button.disabled = true;
  try {
    renderFacebookState(await roomRequest('/api/facebook-live/stop', { method: 'POST', body: { egressId: ui.facebookEgressId } }, ui.session.csrfToken));
  } catch (error) {
    renderFacebookState({ state: 'ERROR', active: false, message: error.message });
    showMessage(error.message, true);
  } finally {
    button.disabled = ui.facebookState === 'STOPPING' || !ui.facebookEgressId;
  }
}

async function leaveRoom() {
  const recording = await queryRecordingStatus();
  if ((recording.active || recording.busy) && !await askConfirmation({ title: 'Salir de la reunión', message: 'Hay una operación de grabación activa. Salir no la detendrá ni finalizará la reunión.', confirmLabel: 'Salir', danger: true })) return;
  try {
    if (ui.backgroundObjectUrl) {
      URL.revokeObjectURL(ui.backgroundObjectUrl);
      ui.backgroundObjectUrl = null;
    }
    await ui.room?.disconnect();
    await roomRequest('/api/room-session/leave', { method: 'POST', body: {} }, ui.session.csrfToken);
  } catch { /* Cookie expiry is an acceptable fallback. */ }
  window.location.href = isOrganizer() ? '/dashboard.html' : '/index.html';
}

async function endRoom() {
  const recording = await queryRecordingStatus();
  const detail = recording.active || recording.busy ? ' La operación de grabación se resolverá antes de cerrar.' : '';
  if (!await askConfirmation({ title: 'Finalizar para todos', message: `Esto desconectará a todos y marcará la reunión como completada.${detail}`, confirmLabel: 'Finalizar reunión', danger: true })) return;
  try {
    if (recording.active && recording.egressId) await roomRequest('/api/recording/stop', { method: 'POST', body: { egressId: recording.egressId } }, ui.session.csrfToken);
    await roomRequest('/api/room/end', { method: 'POST', body: {} }, ui.session.csrfToken);
    statusMachine.set('room_ended');
    await ui.room.disconnect(); window.location.href = '/dashboard.html';
  } catch (error) { showMessage(error.message, true); }
}

function startMeetingTimer() {
  clearInterval(ui.elapsedTimer);
  const update = () => {
    const timing = RATCore.meetingTiming(ui.session.meeting, Date.now());
    const elapsed = timing.elapsedSeconds;
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    const formatted = `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
    const timer = document.getElementById('meetingTimer');
    timer.textContent = timing.state === 'live' ? `En vivo · ${formatted}` : timing.label;
    timer.title = timing.state === 'live' && timing.remainingSeconds > 0 ? `Finaliza aproximadamente en ${Math.ceil(timing.remainingSeconds / 60)} min` : timing.overtime ? 'La duración estimada ya se cumplió' : timing.label;
    floatingModel.update({ elapsedSeconds: elapsed });
  };
  update();
  ui.elapsedTimer = setInterval(update, 1_000);
}

async function toggleRoomLock() {
  const next = !ui.locked;
  const confirmed = await askConfirmation({
    title: next ? 'Bloquear sala' : 'Desbloquear sala',
    message: next ? 'Las personas que ya están dentro continuarán conectadas, pero no se admitirán nuevos accesos.' : 'Las invitaciones activas volverán a admitir accesos.',
    confirmLabel: next ? 'Bloquear' : 'Desbloquear',
    danger: next,
  });
  if (!confirmed) return;
  try {
    const result = await roomRequest('/api/room/lock', { method: 'POST', body: { locked: next } }, ui.session.csrfToken);
    renderRoomLock(result.locked);
  } catch (error) { showMessage(error.message, true); }
}

async function copyText(value) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(value);
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed';
  input.style.opacity = '0';
  document.body.appendChild(input);
  input.select();
  const copied = document.execCommand('copy');
  input.remove();
  if (!copied) throw new Error('No se pudo copiar el enlace.');
}

async function createInRoomInvitation(role) {
  try {
    const privileged = ['HOST', 'TEACHER', 'COHOST'].includes(role);
    const result = await roomRequest('/api/room/invitations', { method: 'POST', body: { meetingRole: role, singleUse: privileged, expiresInMinutes: 240 } }, ui.session.csrfToken);
    await copyText(result.message || result.url);
    notifier.notify(`invitation-${role}`, { title: 'Invitación copiada', message: `El mensaje con enlace de ${RATCore.roleLabel(role).toLowerCase()} vence en 4 horas.`, tone: 'success', system: false });
  } catch (error) { showMessage(error.message, true); }
}

async function createInRoomAccess(kind) {
  try {
    const result = await roomRequest(`/api/room/simple-accesses/${kind}`, { method: 'POST', body: {} }, ui.session.csrfToken);
    const access = result.access || {};
    await copyText(access.message || access.url);
    notifier.notify(`simple-access-${kind}`, {
      title: 'Enlace copiado',
      message: access.kind === 'HOST'
        ? 'El enlace de anfitrión puede usarse por varios anfitriones autorizados.'
        : 'El enlace de participante puede enviarse al grupo sin pisar identidades.',
      tone: 'success',
      system: false,
    });
  } catch (error) { showMessage(error.message, true); }
}

async function sendReaction(reaction) {
  if (!ui.session.meeting.allowReactions) return;
  try {
    await ui.chat.sendSystem({ kind: 'reaction', reaction });
    renderReaction(reaction, ui.session.displayName);
  } catch (error) { showMessage(error.message, true); }
}

function setSpeakerMode(mode, identity = null) {
  ui.speakerMode = ['auto', 'pinned', 'hidden'].includes(mode) ? mode : 'auto';
  if (ui.speakerMode === 'pinned') ui.pinnedSpeakerIdentity = identity || document.getElementById('pinnedSpeaker')?.value || null;
  document.getElementById('speakerMode').value = ui.speakerMode;
  document.getElementById('pinnedSpeakerLabel').hidden = ui.speakerMode !== 'pinned';
  ui.stage?.setSpeakerMode(ui.speakerMode, ui.pinnedSpeakerIdentity);
  floatingModel.update({ speakerMode: ui.speakerMode });
}

async function testSpeaker(outputId = document.getElementById('speakerSelect')?.value || '') {
  const Context = window.AudioContext || window.webkitAudioContext;
  if (!Context) throw new Error('La prueba de altavoz no está disponible en este navegador.');
  const context = new Context();
  if (outputId && typeof context.setSinkId === 'function') await context.setSinkId(outputId);
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  oscillator.frequency.value = 660;
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.16, context.currentTime + 0.03);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + 0.45);
  oscillator.connect(gain).connect(context.destination);
  oscillator.start(); oscillator.stop(context.currentTime + 0.5);
  await new Promise((resolve) => { oscillator.onended = resolve; });
  await context.close();
}

function configureMeetingMode() {
  const meeting = ui.session.meeting;
  const handButton = document.getElementById('btnHand');
  handButton.hidden = !ui.session.capabilities?.canRaiseHand && !ui.session.capabilities?.canManageParticipants && !ui.session.capabilities?.canModerateChat;
  handButton.title = ui.session.capabilities?.canRaiseHand ? 'Levantar la mano' : 'Revisar manos y solicitudes';
  if (!ui.session.capabilities?.canRaiseHand) setButtonState(handButton, false, 'Ver manos', 'Ver manos');
  const questionOption = document.querySelector('#chatKind option[value="question"]');
  if (!meeting.allowQuestions) questionOption?.remove();
  document.querySelector('[data-room-tab="questions"]').hidden = !meeting.allowQuestions;
  document.getElementById('reactionPicker').hidden = !meeting.allowReactions;
  if (!meeting.allowChat) {
    document.getElementById('chatKind').value = meeting.allowQuestions ? 'question' : 'chat';
    document.querySelector('#chatKind option[value="chat"]')?.remove();
    if (!meeting.allowQuestions) document.querySelector('.room-chat-composer').hidden = true;
  }
  floatingModel.update({ role: ui.session.role, meetingRole: ui.session.meetingRole, mode: meeting.type, locked: meeting.roomLocked === true });
  const attendee = ui.session.meetingRole === 'ATTENDEE';
  document.getElementById('btnCam').hidden = attendee;
  document.getElementById('btnScreen').hidden = attendee;
  document.getElementById('btnScreenMore').hidden = attendee;
  document.getElementById('btnEffects').hidden = attendee;
  document.getElementById('cameraSelect').parentElement.hidden = attendee;
  document.getElementById('microphoneSelect').parentElement.hidden = attendee;
  document.getElementById('btnToggleSelfView').hidden = attendee;
  const canUsePresenterPanel = ui.session.capabilities?.canUsePresenterPanel === true;
  document.getElementById('btnFloat').hidden = !canUsePresenterPanel;
  document.getElementById('autoFloatOnShare').parentElement.hidden = !canUsePresenterPanel;
  document.getElementById('speakerModeLabel').hidden = !canUsePresenterPanel;
  document.getElementById('pinnedSpeakerLabel').hidden = !canUsePresenterPanel || ui.speakerMode !== 'pinned';
  document.getElementById('recordingHelp').hidden = !ui.session.capabilities?.canManageRecording;
  document.getElementById('btnLock').hidden = !ui.session.capabilities?.canManageRoom;
  document.getElementById('btnRecord').hidden = !ui.session.capabilities?.canManageRecording;
  document.getElementById('facebookLiveSection').hidden = !ui.session.capabilities?.canManageRecording;
  document.getElementById('btnEnd').hidden = !ui.session.capabilities?.canEndMeeting;
  document.getElementById('btnInviteViewer').hidden = true;
  document.getElementById('btnInvitePanelist').hidden = true;
  const invitationActions = document.getElementById('invitationRoleActions');
  invitationActions.replaceChildren();
  invitationActions.hidden = !ui.session.capabilities?.canManageInvitations;
  if (!invitationActions.hidden) {
    invitationActions.append(
      actionButton('Copiar enlace de participante', () => createInRoomAccess('PARTICIPANT')),
      actionButton('Copiar enlace de anfitrión', () => createInRoomAccess('HOST')),
    );
  }
  renderRoomLock(meeting.roomLocked === true);
}

function setupKeyboardShortcuts() {
  document.addEventListener('keydown', (event) => {
    const target = event.target;
    if (target?.matches?.('input, textarea, select, [contenteditable="true"]') || document.querySelector('dialog[open]')) return;
    const key = event.key.toLowerCase();
    if (key === 'escape') {
      closeSidePanel();
      document.getElementById('morePanel').hidden = true;
      return;
    }
    if (!(event.ctrlKey || event.metaKey) || !event.shiftKey) return;
    const actions = { m: toggleMicrophone, v: toggleCamera, s: toggleScreen, c: () => openTab('chat'), p: () => openTab('participants'), h: ui.session.capabilities?.canRaiseHand ? toggleHand : () => openTab('participants') };
    if (!actions[key]) return;
    event.preventDefault();
    actions[key]();
  });
}

function setupControls() {
  if (ui.controlsBound) return;
  ui.controlsBound = true;
  document.getElementById('btnMic').onclick = toggleMicrophone;
  document.getElementById('btnCam').onclick = toggleCamera;
  document.getElementById('btnHand').onclick = ui.session.capabilities?.canRaiseHand ? toggleHand : () => openTab('participants');
  document.getElementById('btnScreen').onclick = toggleScreen;
  document.getElementById('btnScreenMore').onclick = toggleScreen;
  document.getElementById('stopShareNotice').onclick = () => { if (ui.screen) toggleScreen(); };
  document.getElementById('btnEffects').onclick = () => {
    const panel = document.getElementById('effectsPanel');
    panel.hidden = !panel.hidden;
    if (!ui.camera) showMessage('Activa la cámara para usar efectos.');
  };
  document.getElementById('btnParticipants').onclick = () => {
    openTab('participants');
    document.getElementById('morePanel').hidden = true;
  };
  document.getElementById('btnParticipantsMore').onclick = () => { openTab('participants'); document.getElementById('morePanel').hidden = true; };
  document.querySelectorAll('[data-camera-effect]').forEach((button) => {
    button.onclick = () => applyCameraEffect(button.dataset.cameraEffect).catch((error) => showMessage(error.message, true));
  });
  document.getElementById('backgroundImageInput').onchange = async (event) => {
    const file = event.target.files[0];
    event.target.value = '';
    if (!file) return;
    try {
      const nextUrl = await compressedBackgroundUrl(file);
      const previousUrl = ui.backgroundObjectUrl;
      ui.backgroundObjectUrl = nextUrl;
      await applyCameraEffect('image', nextUrl);
      if (previousUrl) URL.revokeObjectURL(previousUrl);
    } catch (error) { showMessage(error.message, true); }
  };
  document.getElementById('btnRecord').onclick = toggleRecording;
  document.getElementById('btnFacebookConfig').onclick = openFacebookDialog;
  document.getElementById('btnFacebookStop').onclick = stopFacebookLive;
  document.getElementById('facebookLiveForm').onsubmit = startFacebookLive;
  document.getElementById('facebookLiveCancel').onclick = () => {
    clearFacebookCredentials();
    document.getElementById('facebookLiveDialog').close();
  };
  document.getElementById('facebookLiveDialog').addEventListener('close', clearFacebookCredentials);
  document.getElementById('btnLeave').onclick = leaveRoom;
  document.getElementById('btnEnd').onclick = endRoom;
  document.getElementById('btnLock').onclick = toggleRoomLock;
  document.getElementById('btnInviteViewer').onclick = () => createInRoomAccess('PARTICIPANT');
  document.getElementById('btnInvitePanelist').onclick = () => createInRoomAccess('HOST');
  document.querySelectorAll('.organizer-control').forEach((element) => { element.hidden = !ui.session.capabilities?.canManageInvitations && !ui.session.capabilities?.canManageRoom && !ui.session.capabilities?.canManageRecording && !ui.session.capabilities?.canEndMeeting; });
  if (!navigator.mediaDevices?.getDisplayMedia) { document.getElementById('btnScreen').disabled = true; document.getElementById('btnScreen').title = 'Compartir pantalla no está disponible en este navegador.'; }
  document.getElementById('btnMore').onclick = () => { const panel = document.getElementById('morePanel'); panel.hidden = !panel.hidden; document.getElementById('btnMore').setAttribute('aria-expanded', String(!panel.hidden)); };
  document.getElementById('closeMore').onclick = () => { document.getElementById('morePanel').hidden = true; document.getElementById('btnMore').setAttribute('aria-expanded', 'false'); };
  const notificationButton = document.getElementById('btnNotifications');
  const updateNotificationButton = () => {
    const state = notifier.permissionState();
    notificationButton.textContent = state === 'granted' ? 'Notificaciones activas' : state === 'denied' ? 'Notificaciones bloqueadas' : state === 'unsupported' ? 'Notificaciones no compatibles' : 'Activar notificaciones';
    notificationButton.disabled = ['denied', 'unsupported'].includes(state);
    notificationButton.title = state === 'denied' ? 'El navegador bloqueó este permiso. Puedes cambiarlo desde la configuración del sitio.' : '';
  };
  notificationButton.onclick = async () => {
    notificationButton.disabled = true;
    notificationButton.textContent = 'Solicitando permiso…';
    try {
      const result = await notifier.requestPermission();
      updateNotificationButton();
      showMessage(result.granted ? 'Notificaciones del sistema activadas.' : 'El navegador bloqueó las notificaciones. Puedes habilitarlas desde la configuración del sitio.', !result.granted);
    } catch (error) { updateNotificationButton(); showMessage(error.message, true); }
  };
  updateNotificationButton();
  document.querySelectorAll('[data-reaction]').forEach((button) => { button.onclick = () => sendReaction(button.dataset.reaction); });
  document.getElementById('btnShortcuts').onclick = () => { const help = document.getElementById('shortcutHelp'); help.hidden = !help.hidden; };
  const autoFloat = document.getElementById('autoFloatOnShare');
  autoFloat.checked = localStorage.getItem('rat:auto-float-share') === 'true';
  autoFloat.onchange = () => localStorage.setItem('rat:auto-float-share', String(autoFloat.checked));
  document.getElementById('btnToggleSelfView').onclick = () => {
    ui.selfView = !ui.selfView;
    ui.stage?.setParticipantVisibility(ui.session.identity, ui.selfView);
    const selfButton = document.getElementById('btnToggleSelfView');
    selfButton.textContent = ui.selfView ? 'Ocultar mi miniatura' : 'Mostrar mi miniatura';
    selfButton.setAttribute('aria-pressed', String(ui.selfView));
  };
  const volume = document.getElementById('meetingVolume');
  ui.meetingVolume = 1;
  volume.value = String(Math.round(ui.meetingVolume * 100));
  document.getElementById('meetingVolumeValue').textContent = `${volume.value}%`;
  ui.stageEvents?.setMeetingVolume(ui.meetingVolume);
  volume.oninput = () => {
    ui.meetingVolume = Number(volume.value) / 100;
    ui.stageEvents?.setMeetingVolume(ui.meetingVolume);
    document.getElementById('meetingVolumeValue').textContent = `${volume.value}%`;
  };
  document.getElementById('btnTestSpeaker').onclick = () => testSpeaker().then(() => showMessage('Prueba de altavoz completada.')).catch((error) => showMessage(error.message, true));
  document.getElementById('speakerMode').onchange = (event) => setSpeakerMode(event.target.value);
  document.getElementById('pinnedSpeaker').onchange = (event) => setSpeakerMode('pinned', event.target.value);
  setSpeakerMode('auto');
  for (const [id, kind] of [['cameraSelect', 'videoinput'], ['microphoneSelect', 'audioinput']]) document.getElementById(id).onchange = (event) => ui.room?.switchActiveDevice(kind, event.target.value).catch((error) => showMessage(error.message, true));
  document.getElementById('speakerSelect').onchange = (event) => document.querySelectorAll('audio, video').forEach((media) => media.setSinkId?.(event.target.value).catch(() => {}));
  ui.companion = ui.session.capabilities?.canUsePresenterPanel ? attachCompanionWindow(document.getElementById('btnFloat'), floatingModel, {
    microphone: toggleMicrophone, camera: toggleCamera, screen: toggleScreen,
    questions: () => openTab('questions'),
    hand: ui.session.capabilities?.canRaiseHand ? toggleHand : () => openTab('participants'),
    more: () => { document.getElementById('morePanel').hidden = false; window.focus(); },
    leave: leaveRoom, return: () => window.focus(), unsupported: (message) => showMessage(message, true),
    fallback: (message) => notifier.notify('floating-fallback', { title: 'Controles flotantes internos', message, system: false }),
    chatDraft: (value) => ui.chat?.setDraft('chat', value),
    sendChat: async (value) => {
      if (!ui.chat) return false;
      ui.chat.setDraft('chat', value);
      const sent = await ui.chat.sendText(value, 'chat');
      if (sent) ui.chat.setDraft('chat', '');
      return sent;
    },
    participantAction: async (action, identity) => {
      if (action === 'requestMicrophone') return requestParticipantMedia(identity, 'request-microphone');
      if (action === 'grantWord') return promoteParticipant({ identity });
      if (action === 'revokeWord') return demoteParticipant(identity);
      if (action === 'more') { openTab('participants'); window.focus(); }
      return undefined;
    },
    error: (message) => showMessage(message, true),
  }) : null;
  setupKeyboardShortcuts();
}

async function connectRoom({ joinCamera, joinMicrophone }) {
  statusMachine.set('connecting_signaling');
  const tokenData = await requestToken();
  ui.session.meetingRole = tokenData.meetingRole || ui.session.meetingRole;
  ui.session.capabilities = tokenData.capabilities || ui.session.capabilities;
  ui.session.publishSources = tokenData.publishSources || ui.session.publishSources;
  ui.recordingConfigured = tokenData.recordingConfigured === true && ui.session.meeting.allowRecording === true;
  recordingMachine = new RATCore.RecordingStateMachine(renderRecordingState, ui.recordingConfigured);
  const room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: false });
  ui.room = room;
  ui.stage = createStage(document.getElementById('stageGrid'), 'Esperando contenido de la reunión…', null, {
    onActiveSpeakerChange(activeSpeaker) { floatingModel.update({ activeSpeaker, speakerMode: ui.speakerMode }); },
  });
  ui.stageEvents = attachRemoteStageEvents(room, ui.stage);
  room.on(LivekitClient.RoomEvent.DataReceived, handleData);
  room.on(LivekitClient.RoomEvent.ParticipantPermissionsChanged, renderMediaPermissions);
  ui.roomUi = attachConnectionUI(room, {
    statusBadge: document.getElementById('connectionStatus'),
    countBadge: document.getElementById('participantCount'),
    qualityBadge: document.getElementById('qualityBadge'),
    floatingModel,
    onParticipantsChanged: renderParticipants,
    onReconnected: () => {
      queryRecordingStatus();
      queryFacebookStatus();
      syncSpeakerRequests().catch(() => {});
      reportRoomConnection('reconnected', ui.session.csrfToken).catch(() => {});
      notifier.notify('connection-restored', { title: 'Conexión restablecida', message: 'La reunión volvió a estar sincronizada.', tone: 'success', sound: 'reconnected' });
    },
    onQualityChanged: (quality) => {
      if (quality === 'poor') notifier.notify('connection-poor', { title: 'Conexión inestable', message: 'La calidad de audio o video puede reducirse mientras se recupera la red.', tone: 'critical', sound: 'unstable' });
    },
    onParticipantEvent: (event, participant) => notifier.notify(`participant-${event}`, {
      title: event === 'joined' ? 'Participante conectado' : 'Participante desconectado',
      message: `${participantName(participant)} ${event === 'joined' ? 'entró a la reunión.' : 'salió de la reunión.'}`,
      sound: null,
    }),
  });
  try {
    statusMachine.set('connecting_media');
    await room.connect(tokenData.wsUrl, tokenData.token);
    ui.stage.removeParticipant('');
    ui.roomUi.updateCount();
    if (ui.session.capabilities?.canStartMeeting) {
      const connected = await reportRoomConnection('connected', ui.session.csrfToken);
      ui.session.meeting.status = connected.meetingStatus;
      ui.session.meeting.startedAt = connected.startedAt || ui.session.meeting.startedAt;
    }
    const joined = await reportRoomConnection('joined', ui.session.csrfToken).catch(() => null);
    if (joined?.startedAt) ui.session.meeting.startedAt = joined.startedAt;
    ui.roomUi.machine.set('connected');
    statusMachine.set('connected');
    floatingModel.update({ title: tokenData.meeting.title, live: true });
    ui.questions = setupQuestions(room, {
      csrfToken: ui.session.csrfToken,
      role: ui.session.capabilities?.canModerateQuestions ? 'ORGANIZER' : ui.session.role,
      onError: (message) => showMessage(message, true),
      onChange: ({ pending }) => { updateCounter('questionUnread', pending); floatingModel.update({ pendingQuestions: pending }); },
      onNewQuestion: () => {
        notifier.notify('new-question', { title: 'Nueva pregunta', message: 'Se agregó una pregunta a la cola de Q&A.', sound: 'message' });
      },
      onAnswered: () => notifier.notify('question-answered', { title: 'Pregunta respondida', message: 'Tu pregunta recibió una respuesta.', tone: 'success', sound: 'message' }),
    });
    ui.chat = setupChat(room, ui.session.identity, {
      csrfToken: ui.session.csrfToken,
      role: ui.session.meetingRole,
      displayName: ui.session.displayName,
      sendQuestion: async (text) => {
        const question = await ui.questions.submit(text);
        openTab('questions');
        notifier.notify('question-sent', { title: 'Pregunta enviada', message: 'Tu pregunta quedó en la cola de Q&A.', tone: 'success', system: false });
        return question;
      },
      onDraftChange(kind, value) {
        if (kind === 'chat') floatingModel.update({ chatDraft: value });
      },
      onHistoryChange(messages) {
        floatingModel.update({ chatMessages: messages });
      },
      onMessage(_participant, message) {
        const counter = message.kind === 'question' ? unreadQuestions : unreadChat;
        if (ui.activeTab !== (message.kind === 'question' ? 'questions' : 'chat') || document.getElementById('sidePanel').classList.contains('closed')) counter.increment();
        floatingModel.update({ unreadMessages: unreadChat.value, unreadQuestions: unreadQuestions.value });
        notifier.notify(message.kind === 'question' ? 'legacy-question' : 'new-message', { title: message.kind === 'question' ? 'Nueva pregunta' : 'Nuevo mensaje', message: `${message.from || 'Participante'}: ${String(message.text || message.filename || '').slice(0, 100)}`, system: false });
      },
    });
    setupControls(); configureMeetingMode(); renderMediaPermissions(); renderParticipants([room.localParticipant, ...room.remoteParticipants.values()]);
    await syncSpeakerRequests();
    ui.stage.setParticipantState(ui.session.identity, `${ui.session.displayName} (tú)`, { microphone: false, local: true, keepVisible: true });
    startMeetingTimer();
    await queryRecordingStatus();
    await queryFacebookStatus();
    await enumerateDevices().catch(() => showMessage('La reunión está conectada, pero no fue posible actualizar la lista de dispositivos.', true));
    if (joinMicrophone) await toggleMicrophone();
    if (joinCamera) await toggleCamera();
    playConnectedSound();
  } catch (connectionError) {
    ui.roomUi?.dispose();
    ui.roomUi = null;
    ui.chat?.dispose();
    ui.chat = null;
    ui.questions?.dispose();
    ui.questions = null;
    ui.stageEvents?.dispose();
    ui.stageEvents = null;
    ui.stage?.dispose?.();
    ui.stage = null;
    room.off(LivekitClient.RoomEvent.DataReceived, handleData);
    room.off(LivekitClient.RoomEvent.ParticipantPermissionsChanged, renderMediaPermissions);
    try { await Promise.resolve(room.disconnect()); } catch { /* Best-effort cleanup before retry. */ }
    if (ui.room === room) ui.room = null;
    throw connectionError;
  }
}

async function initializeRoom() {
  setupTabs();
  const syncViewport = () => document.documentElement.style.setProperty('--room-viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
  syncViewport();
  window.visualViewport?.addEventListener('resize', syncViewport);
  window.visualViewport?.addEventListener('scroll', syncViewport);
  document.getElementById('preflightForm').addEventListener('submit', submitPreflight);
  document.getElementById('previewButton').addEventListener('click', () => startPreview().catch((error) => { document.getElementById('preflightError').textContent = error.message; }));
  document.getElementById('preflightSpeakerTest').addEventListener('click', () => {
    const button = document.getElementById('preflightSpeakerTest');
    button.disabled = true;
    testSpeaker(document.getElementById('preflightSpeaker').value)
      .then(() => { document.getElementById('preflightError').textContent = 'Prueba de altavoz completada.'; })
      .catch((error) => { document.getElementById('preflightError').textContent = error.message; })
      .finally(() => { button.disabled = false; });
  });
  window.addEventListener('pagehide', () => {
    if (ui.session?.csrfToken) roomRequest('/api/room-session/leave', { method: 'POST', body: {}, keepalive: true }, ui.session.csrfToken).catch(() => {});
    stopPreview();
    clearTimeout(recordingPollTimer);
    clearTimeout(facebookPollTimer);
    clearInterval(ui.elapsedTimer);
    clearTimeout(ui.reactionTimer);
    ui.chat?.dispose();
    ui.questions?.dispose();
    ui.stageEvents?.dispose();
    ui.stage?.dispose?.();
    ui.roomUi?.dispose();
    ui.companion?.dispose();
    notifier.dispose();
    ui.room?.off(LivekitClient.RoomEvent.DataReceived, handleData);
    ui.room?.off(LivekitClient.RoomEvent.ParticipantPermissionsChanged, renderMediaPermissions);
    ui.room?.disconnect();
    window.visualViewport?.removeEventListener('resize', syncViewport);
    window.visualViewport?.removeEventListener('scroll', syncViewport);
    if (ui.backgroundObjectUrl) URL.revokeObjectURL(ui.backgroundObjectUrl);
  }, { once: true });
  try {
    statusMachine.set('validating_invitation');
    ui.session = await getRoomSession();
    ui.session.meetingRole = RATCore.normalizeMeetingRole(ui.session.meeting.type, ui.session.meetingRole, ui.session.role);
    ui.session.capabilities = ui.session.capabilities || RATCore.meetingRoleCapabilities(ui.session.meeting.type, ui.session.meetingRole);
    ui.session.publishSources = Array.isArray(ui.session.publishSources) ? ui.session.publishSources : [];
    const shouldBeViewer = pageRole === 'viewer';
    const viewerExperience = ui.session.meetingRole === 'ATTENDEE' || (ui.session.legacyAccess && ui.session.role === 'VIEWER');
    if (shouldBeViewer !== viewerExperience) {
      window.location.replace(viewerExperience ? '/viewer.html' : '/presenter.html'); return;
    }
    document.getElementById('meetingTitle').textContent = ui.session.meeting.title;
    document.getElementById('trainerName').textContent = ui.session.meeting.trainerName;
    document.getElementById('meetingRoleBadge').textContent = RATCore.roleLabel(ui.session.meetingRole);
    floatingModel.update({ title: ui.session.meeting.title, connection: 'waiting_for_room', role: ui.session.role, meetingRole: ui.session.meetingRole, mode: ui.session.meeting.type, locked: ui.session.meeting.roomLocked === true });
    renderRoomLock(ui.session.meeting.roomLocked === true);
    statusMachine.set('waiting_for_room');
    if (ui.session.seriesPrepared === true && ui.session.seriesId && ui.session.meetingRole === 'ATTENDEE' && ui.session.consents?.privacy === true) {
      try { await connectRoom({ joinCamera: false, joinMicrophone: false }); }
      catch (directError) { throw directError; }
    } else {
      await enumerateDevices(); await setupPreflight();
    }
  } catch (error) {
    statusMachine.set(error.code === 'ROOM_ENDED' ? 'room_ended' : 'access_denied', error.message);
    document.querySelector('.room-layout').innerHTML = `<div class="access-denied branded-empty"><img src="assets/streaming-app-logo.png" alt="Logo oficial de R.A. Training Streaming"><h1>Acceso no disponible</h1><p></p><a class="button primary" href="/index.html">Volver al inicio</a></div>`;
    document.querySelector('.access-denied p').textContent = error.message;
    document.getElementById('roomControls').hidden = true;
  }
}

initializeRoom();
