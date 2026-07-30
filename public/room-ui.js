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
  handRaised: false,
  activeTab: 'chat',
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
};
const handQueue = new RATCore.HandQueue();
const floatingModel = RATCore.createFloatingModel();
const notifier = createMeetingNotifier(document.getElementById('toastRegion'));
const unreadChat = RATCore.createUnreadCounter((count) => { updateCounter('chatUnread', count); floatingModel.update({ unreadMessages: count }); });
const unreadQuestions = RATCore.createUnreadCounter((count) => { updateCounter('questionUnread', count); floatingModel.update({ unreadQuestions: count }); });
const statusMachine = new RATCore.ConnectionStateMachine(renderConnectionState);
let recordingMachine = new RATCore.RecordingStateMachine(renderRecordingState, false);
let recordingPollTimer = null;

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
    notifier.notify('recording-state', { title: snapshot.active ? 'Grabación iniciada' : 'Grabación detenida', message: snapshot.active ? 'La reunión se está grabando.' : 'La grabación dejó de estar activa.', tone: snapshot.active ? 'critical' : 'info' });
  }
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
  try { return RATCore.roleLabel(JSON.parse(participant?.metadata || '{}').role); } catch { return RATCore.roleLabel('VIEWER'); }
}

function participantRoleCode(participant) {
  try { return String(JSON.parse(participant?.metadata || '{}').role || 'VIEWER').toUpperCase(); } catch { return 'VIEWER'; }
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

function isOrganizer() {
  return ['ADMIN', 'ORGANIZER'].includes(ui.session?.role);
}

function hasPublishPermission() {
  if (ui.room?.localParticipant?.permissions) return ui.room.localParticipant.permissions.canPublish === true;
  return ['ADMIN', 'ORGANIZER', 'PANELIST'].includes(ui.session?.role);
}

function setButtonState(button, active, activeLabel, inactiveLabel) {
  button.setAttribute('aria-pressed', String(active));
  button.classList.toggle('active', active);
  const label = button.querySelector('span:last-child');
  if (label) label.textContent = active ? activeLabel : inactiveLabel;
  else button.textContent = active ? activeLabel : inactiveLabel;
  button.setAttribute('aria-label', active ? activeLabel : inactiveLabel);
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
  statusMachine.set('requesting_permissions');
  const videoId = document.getElementById('preflightCamera').value;
  const audioId = document.getElementById('preflightMicrophone').value;
  try {
    ui.previewStream = await navigator.mediaDevices.getUserMedia({
      video: videoId ? { deviceId: { exact: videoId } } : true,
      audio: audioId ? { deviceId: { exact: audioId } } : true,
    });
    document.getElementById('previewVideo').srcObject = ui.previewStream;
    document.getElementById('previewPlaceholder').hidden = true;
    startMeter(ui.previewStream);
    await enumerateDevices();
    statusMachine.set('waiting_for_room');
  } catch (mediaError) {
    const messages = {
      NotAllowedError: 'El permiso de cámara o micrófono está bloqueado. Revísalo en la configuración del navegador.',
      NotFoundError: 'No se encontró una cámara o micrófono disponible.',
      NotReadableError: 'La cámara o el micrófono están ocupados por otra aplicación.',
    };
    statusMachine.set('waiting_for_room');
    throw new Error(messages[mediaError.name] || 'No fue posible abrir la cámara o el micrófono.');
  }
}

async function refreshLiveKitStatus() {
  const status = document.getElementById('livekitStatus');
  const button = document.getElementById('enterRoomButton');
  status.textContent = 'Comprobando el servicio de videoconferencia…';
  status.className = 'service-notice checking';
  try {
    const livekit = await requestLiveKitStatus();
    status.textContent = livekit.available
      ? `LiveKit ${livekit.mode} — disponible.`
      : `LiveKit ${livekit.mode} — no disponible. Inicia el servidor antes de entrar.`;
    status.className = `service-notice ${livekit.available ? 'available' : 'unavailable'}`;
    button.disabled = !livekit.available;
    return livekit;
  } catch (error) {
    status.textContent = 'No fue posible comprobar el servicio de videoconferencia.';
    status.className = 'service-notice unavailable';
    button.disabled = true;
    throw error;
  }
}

async function setupPreflight() {
  const viewer = ui.session.role === 'VIEWER';
  document.querySelectorAll('.viewer-option').forEach((element) => { element.hidden = !viewer; });
  document.querySelectorAll('.presenter-option').forEach((element) => { element.hidden = viewer; });
  const privacyConsent = document.getElementById('privacyConsent');
  privacyConsent.disabled = !viewer;
  privacyConsent.required = false;
  document.getElementById('recordingConsent').disabled = !viewer;
  document.getElementById('transcriptionConsent').disabled = !viewer;
  document.getElementById('previewButton').hidden = viewer;
  document.getElementById('preflightCamera').parentElement.hidden = viewer;
  document.getElementById('preflightMicrophone').parentElement.hidden = viewer;
  document.getElementById('preflightSpeaker').parentElement.hidden = viewer;
  document.querySelector('.meter').hidden = viewer;
  document.getElementById('displayNameInput').value = ui.session.displayName || '';
  document.getElementById('preflightMeeting').textContent = `${ui.session.meeting.title} · ${ui.session.meeting.trainerName}`;
  document.getElementById('recordingConsentLabel').hidden = !viewer || !ui.session.meeting.recordingConsentRequired;
  document.getElementById('transcriptionConsentLabel').hidden = !viewer || !ui.session.meeting.transcriptionConsentRequired;
  const processingNotice = document.getElementById('processingNotice');
  const recording = ui.session.meeting.allowRecording;
  const transcription = ui.session.meeting.allowTranscription;
  processingNotice.hidden = !recording && !transcription;
  processingNotice.textContent = recording && transcription
    ? 'Esta reunión puede grabarse y transcribirse. La transcripción automática puede contener errores.'
    : recording ? 'Esta reunión puede grabarse.' : 'Esta reunión puede transcribirse. La transcripción automática puede contener errores.';
  const connection = navigator.connection;
  document.getElementById('networkStatus').textContent = connection
    ? `Red estimada: ${connection.effectiveType || 'desconocida'}${connection.downlink ? ` · ${connection.downlink} Mbps` : ''}`
    : 'El navegador no informa una estimación previa de red.';
  document.getElementById('preflightDialog').showModal();
  await refreshLiveKitStatus().catch(() => null);
}

async function submitPreflight(event) {
  event.preventDefault();
  const error = document.getElementById('preflightError'); error.textContent = '';
  const button = document.getElementById('enterRoomButton');
  if (button.dataset.busy === 'true') return;
  const viewer = ui.session.role === 'VIEWER';
  if (viewer && !document.getElementById('privacyConsent').checked) return void (error.textContent = 'Debes aceptar el aviso de privacidad para entrar.');
  if (viewer && ui.session.meeting.recordingConsentRequired && !document.getElementById('recordingConsent').checked) return void (error.textContent = 'Debes confirmar el aviso de grabación para entrar.');
  if (viewer && ui.session.meeting.transcriptionConsentRequired && !document.getElementById('transcriptionConsent').checked) return void (error.textContent = 'Debes confirmar el aviso de transcripción para entrar.');
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
    const joinCamera = !viewer && document.getElementById('joinCamera').checked;
    const joinMicrophone = !viewer && document.getElementById('joinMicrophone').checked;
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
    button.disabled = document.getElementById('livekitStatus').classList.contains('unavailable');
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
}

function closeSidePanel() {
  document.getElementById('sidePanel').classList.add('closed');
  document.querySelector('.room-layout').classList.add('panel-closed');
  document.getElementById('btnChat').setAttribute('aria-pressed', 'false');
  floatingModel.update({ panel: null });
  window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function openTab(name) {
  ui.activeTab = name;
  document.getElementById('sidePanel').classList.remove('closed');
  document.querySelector('.room-layout').classList.remove('panel-closed');
  document.getElementById('btnChat').setAttribute('aria-pressed', String(name === 'chat'));
  floatingModel.update({ panel: name });
  document.querySelectorAll('[data-room-tab]').forEach((button) => { const active = button.dataset.roomTab === name; button.setAttribute('aria-selected', String(active)); button.classList.toggle('active', active); });
  document.querySelectorAll('[data-room-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.roomPanel === name));
  if (name === 'chat') unreadChat.clear();
  if (name === 'participants') renderHandQueue();
  if (name === 'chat' || name === 'questions') window.setTimeout(() => document.getElementById('chatInput')?.focus(), 0);
  window.requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function renderParticipants(participants = []) {
  const container = document.getElementById('participantsList'); container.replaceChildren();
  for (const participant of participants) {
    const row = document.createElement('article'); row.className = 'participant-card';
    const info = document.createElement('div');
    const media = participantMediaState(participant);
    const permission = participant.permissions || participant.permission || {};
    const pendingHand = handQueue.list().find((item) => item.identity === participant.identity && item.status === 'PENDING');
    const qualityLabels = { EXCELLENT: 'excelente', GOOD: 'buena', POOR: 'inestable', LOST: 'sin conexión' };
    const qualityValue = String(participant.connectionQuality || '').toUpperCase();
    const quality = isOrganizer() && qualityValue ? ` · Red ${qualityLabels[qualityValue] || 'desconocida'}` : '';
    if (participant.isLocal) {
      ui.microphone = media.microphone;
      ui.camera = media.camera;
      setButtonState(document.getElementById('btnMic'), ui.microphone, 'Silenciar', 'Micrófono');
      setButtonState(document.getElementById('btnCam'), ui.camera, 'Apagar', 'Cámara');
      floatingModel.update({ microphone: ui.microphone, camera: ui.camera });
      if (media.camera && media.cameraPublication?.track) ui.stage?.setTrack(participant.identity, `${participantName(participant)} (tú)`, 'camera', media.cameraPublication.track, { muted: true, local: true });
      else ui.stage?.removeTrack(participant.identity, 'camera');
    }
    if (participant.identity) {
      ui.stage?.setParticipantState(participant.identity, `${participantName(participant)}${participant.isLocal ? ' (tú)' : ''}`, {
        microphone: media.microphone,
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
    row.appendChild(info);
    if (isOrganizer() && !participant.isLocal) {
      const actions = document.createElement('div'); actions.className = 'participant-actions';
      if (pendingHand && !permission.canPublish) {
        actions.append(
          actionButton('Dar palabra', () => promoteParticipant(pendingHand), 'primary compact'),
          actionButton('Rechazar', () => rejectHand(pendingHand)),
        );
      } else if (permission.canPublish) actions.appendChild(actionButton('Quitar palabra', () => demoteParticipant(participant.identity)));
      if (media.microphone) actions.appendChild(actionButton('Silenciar', () => muteParticipant(participant.identity)));
      else actions.appendChild(actionButton('Solicitar activar micrófono', () => requestParticipantMedia(participant.identity, 'request-microphone')));
      const more = document.createElement('details'); more.className = 'participant-more';
      const summary = document.createElement('summary'); summary.textContent = 'Más acciones';
      const menu = document.createElement('div'); menu.className = 'participant-more-menu';
      if (media.camera) menu.appendChild(actionButton('Solicitar apagar cámara', () => requestParticipantMedia(participant.identity, 'request-camera-off')));
      if (permission.canPublish) menu.appendChild(actionButton('Revocar palabra', () => demoteParticipant(participant.identity)));
      else if (participantRoleCode(participant) === 'VIEWER') menu.appendChild(actionButton('Promover temporalmente', () => promoteParticipant({ identity: participant.identity })));
      menu.append(
        actionButton('Expulsar', () => removeParticipant(participant.identity), 'danger compact'),
        actionButton('Bloquear acceso', () => blockParticipant(participant.identity), 'danger compact'),
      );
      more.append(summary, menu); actions.appendChild(more); row.appendChild(actions);
    }
    container.appendChild(row);
  }
  if (participants.length <= 1 && isOrganizer()) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact participants-empty';
    empty.append(
      Object.assign(document.createElement('strong'), { textContent: 'Esperando participantes…' }),
      Object.assign(document.createElement('span'), { textContent: 'Comparte un enlace seguro para invitar asistentes o panelistas.' }),
      actionButton('Copiar enlace de asistente', () => createInRoomInvitation('VIEWER'), 'primary compact'),
      actionButton('Copiar enlace de panelista', () => createInRoomInvitation('PANELIST'), 'secondary compact'),
    );
    container.appendChild(empty);
  }
}

function actionButton(label, action, className = 'secondary compact') {
  const button = document.createElement('button'); button.type = 'button'; button.className = className; button.textContent = label; button.onclick = action; return button;
}

function renderHandQueue() {
  const items = handQueue.list();
  updateCounter('handCount', items.filter((item) => item.status === 'PENDING').length);
  floatingModel.update({ raisedHands: items.filter((item) => item.status === 'PENDING').length });
  const container = document.getElementById('handQueue'); container.replaceChildren();
  if (!isOrganizer() && ui.session.role !== 'PANELIST') return;
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

async function promoteParticipant(item) {
  try {
    await roomRequest('/api/participants/promote', { method: 'POST', body: { targetIdentity: item.identity } }, ui.session.csrfToken);
    handQueue.update(item.identity, 'GRANTED'); renderHandQueue(); ui.roomUi?.updateCount();
  } catch (error) { showMessage(error.message, true); }
}

async function rejectHand(item) {
  try {
    await ui.chat.sendSystem({ kind: 'hand-rejected', targetIdentity: item.identity });
    handQueue.remove(item.identity); renderHandQueue(); ui.roomUi?.updateCount();
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
    if (hasPublishPermission()) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return hasPublishPermission();
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
    handQueue.remove(targetIdentity); renderHandQueue(); ui.roomUi?.updateCount();
    showMessage('Se retiró el permiso temporal para publicar.');
  } catch (error) { showMessage(error.message, true); }
}

async function toggleHand() {
  if (!ui.room) return;
  ui.handRaised = !ui.handRaised;
  setButtonState(document.getElementById('btnHand'), ui.handRaised, 'Cancelar', 'Mano');
  floatingModel.update({ handRaised: ui.handRaised });
  await ui.chat.sendSystem({ kind: ui.handRaised ? 'hand-raise' : 'hand-lower', identity: ui.session.identity, displayName: ui.session.displayName, raisedAt: new Date().toISOString() });
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
    if (message.kind === 'hand-raise' && ['ADMIN', 'ORGANIZER', 'PANELIST'].includes(ui.session.role)) {
      handQueue.raise(message.identity || participant?.identity, message.displayName || participantName(participant), message.raisedAt);
      renderHandQueue(); playAlert('hand'); systemNotification('Mano levantada', `${message.displayName || participantName(participant)} solicitó la palabra.`);
      notifier.notify('hand-raised', { title: 'Mano levantada', message: `${message.displayName || participantName(participant)} solicitó la palabra.`, system: false });
    }
    if (message.kind === 'hand-lower') { handQueue.remove(participant?.identity || message.identity); renderHandQueue(); }
    if (message.kind === 'hand-approved' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; floatingModel.update({ handRaised: false }); renderMediaPermissions(); showMessage('El organizador te dio la palabra.'); }
    if (message.kind === 'hand-rejected' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; floatingModel.update({ handRaised: false }); setButtonState(document.getElementById('btnHand'), false, 'Cancelar', 'Mano'); showMessage('La solicitud fue cerrada por el organizador.'); }
    if (message.kind === 'word-revoked' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; if (ui.screen) finishScreenShare(true); renderMediaPermissions(); showMessage('El organizador retiró el permiso para hablar.'); }
    if (message.kind === 'recording-status') recordingMachine.set(message.state, {
      active: message.state === 'RECORDING' && message.active === true,
      egressId: message.egressId || null,
    });
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
  const allowed = hasPublishPermission();
  document.getElementById('btnMic').disabled = !allowed;
  document.getElementById('btnCam').disabled = !allowed;
  document.getElementById('btnScreen').disabled = !allowed || !navigator.mediaDevices?.getDisplayMedia;
  document.getElementById('btnScreenMore').disabled = !allowed || !navigator.mediaDevices?.getDisplayMedia;
  document.getElementById('btnEffects').disabled = !allowed;
  if (!allowed) {
    ui.microphone = false; ui.camera = false;
    floatingModel.update({ microphone: false, camera: false, screen: false });
    setButtonState(document.getElementById('btnMic'), false, 'Silenciar', 'Micrófono');
    setButtonState(document.getElementById('btnCam'), false, 'Apagar', 'Cámara');
  }
  if (ui.session?.role === 'VIEWER') {
    const handButton = document.getElementById('btnHand');
    if (allowed) {
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
  if (!ui.room || !hasPublishPermission() || ui.microphoneBusy) return false;
  const micButton = document.getElementById('btnMic');
  ui.microphoneBusy = true; micButton.disabled = true; micButton.setAttribute('aria-busy', 'true');
  micButton.querySelector('span:last-child').textContent = ui.microphone ? 'Silenciando…' : 'Solicitando…';
  try {
    const next = !ui.microphone;
    await withMediaTimeout(ui.room.localParticipant.setMicrophoneEnabled(next), 'El micrófono');
    const publication = ui.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Microphone);
    ui.microphone = publicationHasLiveTrack(publication, 'audio');
    if (next && !ui.microphone) throw new Error('LiveKit no confirmó un track de micrófono publicado. Revisa el permiso del navegador.');
    setButtonState(document.getElementById('btnMic'), ui.microphone, 'Silenciar', 'Micrófono'); floatingModel.update({ microphone: ui.microphone });
    ui.stage?.setParticipantState(ui.session.identity, `${ui.session.displayName} (tú)`, { microphone: ui.microphone, local: true, keepVisible: true });
    if (!ui.microphone) roomRequest('/api/room/media-state', { method: 'POST', body: { event: 'microphone-muted' } }, ui.session.csrfToken).catch(() => {});
    return ui.microphone === next;
  } catch (error) { micButton.title = 'Permiso bloqueado o dispositivo no disponible. Habilítalo desde el icono de permisos del sitio.'; setButtonState(micButton, ui.microphone, 'Silenciar', 'Micrófono'); showMessage(`Micrófono: ${error.message}`, true); return false; }
  finally { ui.microphoneBusy = false; document.getElementById('btnMic').disabled = !hasPublishPermission(); document.getElementById('btnMic').setAttribute('aria-busy', 'false'); }
}

async function toggleCamera() {
  if (!ui.room || !hasPublishPermission() || ui.cameraBusy) return false;
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
    setButtonState(document.getElementById('btnCam'), ui.camera, 'Apagar', 'Cámara'); floatingModel.update({ camera: ui.camera });
    if (ui.camera && publication?.track) ui.stage.setTrack(ui.session.identity, `${ui.session.displayName} (tú)`, 'camera', publication.track, { muted: true });
    else ui.stage.removeTrack(ui.session.identity, 'camera');
    ui.stage.setParticipantState(ui.session.identity, `${ui.session.displayName} (tú)`, { microphone: ui.microphone, local: true, keepVisible: true });
    return ui.camera === next;
  } catch (error) { camButton.title = 'Permiso bloqueado o dispositivo no disponible. Habilítalo desde el icono de permisos del sitio.'; setButtonState(camButton, ui.camera, 'Apagar', 'Cámara'); showMessage(`Cámara: ${error.message}`, true); return false; }
  finally { ui.cameraBusy = false; document.getElementById('btnCam').disabled = !hasPublishPermission(); document.getElementById('btnCam').setAttribute('aria-busy', 'false'); }
}

async function toggleScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) return showMessage('Compartir pantalla no está disponible en este dispositivo o navegador.', true);
  if (!hasPublishPermission()) return showMessage('Tu rol no permite compartir pantalla.', true);
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
  } catch (error) { setButtonState(button, ui.screen, 'Detener', 'Pantalla'); showMessage(`Pantalla: ${error.message}`, true); }
  finally {
    ui.screenBusy = false;
    button.disabled = !hasPublishPermission() || !navigator.mediaDevices?.getDisplayMedia;
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
  if (!isOrganizer()) return;
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
  const source = ui.session.meeting.startedAt || new Date().toISOString();
  const startedAt = Number.isFinite(new Date(source).getTime()) ? new Date(source).getTime() : Date.now();
  const update = () => {
    const elapsed = Math.max(0, Math.floor((Date.now() - startedAt) / 1000));
    const hours = Math.floor(elapsed / 3600);
    const minutes = Math.floor((elapsed % 3600) / 60);
    const seconds = elapsed % 60;
    document.getElementById('meetingTimer').textContent = `${hours ? `${String(hours).padStart(2, '0')}:` : ''}${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
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
    const result = await roomRequest('/api/room/invitations', { method: 'POST', body: { role, expiresInMinutes: 240 } }, ui.session.csrfToken);
    await copyText(new URL(result.path, location.origin).href);
    notifier.notify(`invitation-${role}`, { title: 'Invitación copiada', message: `El enlace de ${role === 'PANELIST' ? 'panelista' : 'asistente'} vence en 4 horas.`, tone: 'success', system: false });
  } catch (error) { showMessage(error.message, true); }
}

async function sendReaction(reaction) {
  if (!ui.session.meeting.allowReactions) return;
  try {
    await ui.chat.sendSystem({ kind: 'reaction', reaction });
    renderReaction(reaction, ui.session.displayName);
  } catch (error) { showMessage(error.message, true); }
}

function configureMeetingMode() {
  const meeting = ui.session.meeting;
  const handButton = document.getElementById('btnHand');
  if (ui.session.role !== 'VIEWER') {
    handButton.title = meeting.type === 'WEBINAR' ? 'Revisar solicitudes de palabra' : 'Revisar manos levantadas';
    setButtonState(handButton, false, 'Manos', 'Manos');
    if (meeting.type === 'WEBINAR') {
      handButton.hidden = true;
      handButton.title = 'La mano levantada está disponible para asistentes; revisa las solicitudes en Participantes.';
    }
  }
  const questionOption = document.querySelector('#chatKind option[value="question"]');
  if (!meeting.allowQuestions) questionOption?.remove();
  document.querySelector('[data-room-tab="questions"]').hidden = !meeting.allowQuestions;
  document.getElementById('reactionPicker').hidden = !meeting.allowReactions;
  if (!meeting.allowChat) {
    document.getElementById('chatKind').value = meeting.allowQuestions ? 'question' : 'chat';
    document.querySelector('#chatKind option[value="chat"]')?.remove();
    if (!meeting.allowQuestions) document.querySelector('.room-chat-composer').hidden = true;
  }
  floatingModel.update({ role: ui.session.role, mode: meeting.type, locked: meeting.roomLocked === true });
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
    const actions = { m: toggleMicrophone, v: toggleCamera, s: toggleScreen, c: () => openTab('chat'), p: () => openTab('participants'), h: ui.session.role === 'VIEWER' ? toggleHand : () => openTab('participants') };
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
  document.getElementById('btnHand').onclick = ui.session.role === 'VIEWER' ? toggleHand : () => openTab('participants');
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
  document.getElementById('btnLeave').onclick = leaveRoom;
  document.getElementById('btnEnd').onclick = endRoom;
  document.getElementById('btnLock').onclick = toggleRoomLock;
  document.getElementById('btnInviteViewer').onclick = () => createInRoomInvitation('VIEWER');
  document.getElementById('btnInvitePanelist').onclick = () => createInRoomInvitation('PANELIST');
  document.querySelectorAll('.organizer-control').forEach((element) => { element.hidden = !isOrganizer(); });
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
  for (const [id, kind] of [['cameraSelect', 'videoinput'], ['microphoneSelect', 'audioinput']]) document.getElementById(id).onchange = (event) => ui.room?.switchActiveDevice(kind, event.target.value).catch((error) => showMessage(error.message, true));
  document.getElementById('speakerSelect').onchange = (event) => document.querySelectorAll('audio, video').forEach((media) => media.setSinkId?.(event.target.value).catch(() => {}));
  ui.companion = attachCompanionWindow(document.getElementById('btnFloat'), floatingModel, {
    microphone: toggleMicrophone, camera: toggleCamera, screen: toggleScreen,
    chat: () => openTab('chat'), questions: () => openTab('questions'), participants: () => openTab('participants'),
    hand: ui.session.role === 'VIEWER' ? toggleHand : () => openTab('participants'),
    more: () => { document.getElementById('morePanel').hidden = false; window.focus(); },
    leave: leaveRoom, return: () => window.focus(), unsupported: (message) => showMessage(message, true),
    fallback: (message) => notifier.notify('floating-fallback', { title: 'Controles flotantes internos', message, system: false }),
  });
  setupKeyboardShortcuts();
}

async function connectRoom({ joinCamera, joinMicrophone }) {
  statusMachine.set('connecting_signaling');
  const tokenData = await requestToken();
  ui.recordingConfigured = tokenData.recordingConfigured === true && ui.session.meeting.allowRecording === true;
  recordingMachine = new RATCore.RecordingStateMachine(renderRecordingState, ui.recordingConfigured);
  const room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: false });
  ui.room = room;
  ui.stage = createStage(document.getElementById('stageGrid'), 'Esperando contenido de la reunión…');
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
    if (ui.session.role !== 'VIEWER') await reportRoomConnection('connected', ui.session.csrfToken);
    await reportRoomConnection('joined', ui.session.csrfToken).catch(() => {});
    ui.roomUi.machine.set('connected');
    statusMachine.set('connected');
    floatingModel.update({ title: tokenData.meeting.title, live: true });
    ui.questions = setupQuestions(room, {
      csrfToken: ui.session.csrfToken,
      role: ui.session.role,
      onError: (message) => showMessage(message, true),
      onChange: ({ pending }) => { updateCounter('questionUnread', pending); floatingModel.update({ pendingQuestions: pending }); },
      onNewQuestion: () => {
        notifier.notify('new-question', { title: 'Nueva pregunta', message: 'Se agregó una pregunta a la cola de Q&A.', sound: 'message' });
      },
      onAnswered: () => notifier.notify('question-answered', { title: 'Pregunta respondida', message: 'Tu pregunta recibió una respuesta.', tone: 'success', sound: 'message' }),
    });
    ui.chat = setupChat(room, ui.session.identity, {
      csrfToken: ui.session.csrfToken,
      role: ui.session.role,
      displayName: ui.session.displayName,
      sendQuestion: async (text) => {
        const question = await ui.questions.submit(text);
        openTab('questions');
        notifier.notify('question-sent', { title: 'Pregunta enviada', message: 'Tu pregunta quedó en la cola de Q&A.', tone: 'success', system: false });
        return question;
      },
      onMessage(_participant, message) {
        const counter = message.kind === 'question' ? unreadQuestions : unreadChat;
        if (ui.activeTab !== (message.kind === 'question' ? 'questions' : 'chat') || document.getElementById('sidePanel').classList.contains('closed')) counter.increment();
        floatingModel.update({ unreadMessages: unreadChat.value, unreadQuestions: unreadQuestions.value });
        notifier.notify(message.kind === 'question' ? 'legacy-question' : 'new-message', { title: message.kind === 'question' ? 'Nueva pregunta' : 'Nuevo mensaje', message: `${message.from || 'Participante'}: ${String(message.text || message.filename || '').slice(0, 100)}`, system: false });
      },
    });
    setupControls(); configureMeetingMode(); renderMediaPermissions(); renderParticipants([room.localParticipant]);
    ui.stage.setParticipantState(ui.session.identity, `${ui.session.displayName} (tú)`, { microphone: false, local: true, keepVisible: true });
    startMeetingTimer();
    await queryRecordingStatus();
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
  window.addEventListener('pagehide', () => {
    stopPreview();
    clearTimeout(recordingPollTimer);
    clearInterval(ui.elapsedTimer);
    clearTimeout(ui.reactionTimer);
    ui.chat?.dispose();
    ui.questions?.dispose();
    ui.stageEvents?.dispose();
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
    const shouldBeViewer = pageRole === 'viewer';
    if (shouldBeViewer !== (ui.session.role === 'VIEWER')) {
      window.location.replace(ui.session.role === 'VIEWER' ? '/viewer.html' : '/presenter.html'); return;
    }
    document.getElementById('meetingTitle').textContent = ui.session.meeting.title;
    document.getElementById('trainerName').textContent = ui.session.meeting.trainerName;
    floatingModel.update({ title: ui.session.meeting.title, connection: 'waiting_for_room', role: ui.session.role, mode: ui.session.meeting.type, locked: ui.session.meeting.roomLocked === true });
    renderRoomLock(ui.session.meeting.roomLocked === true);
    statusMachine.set('waiting_for_room');
    await enumerateDevices(); await setupPreflight();
  } catch (error) {
    statusMachine.set(error.code === 'ROOM_ENDED' ? 'room_ended' : 'access_denied', error.message);
    document.querySelector('.room-layout').innerHTML = `<div class="access-denied branded-empty"><img src="assets/icon-192.png" alt="Icono de R.A. Training Streaming"><h1>Acceso no disponible</h1><p></p><a class="button primary" href="/index.html">Volver al inicio</a></div>`;
    document.querySelector('.access-denied p').textContent = error.message;
    document.getElementById('roomControls').hidden = true;
  }
}

initializeRoom();
