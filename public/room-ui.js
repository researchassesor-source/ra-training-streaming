renderBrand(document.getElementById('brand'), { tagline: false });
attachSoundToggle(document.getElementById('btnSoundToggle'));
renderSoundSettings(document.getElementById('soundSettings'));

const pageRole = document.body.dataset.pageRole;
const ui = {
  session: null,
  room: null,
  roomUi: null,
  chat: null,
  previewStream: null,
  meterFrame: null,
  microphone: false,
  camera: false,
  screen: false,
  recording: false,
  egressId: null,
  handRaised: false,
  activeTab: 'chat',
  effectsLoaded: false,
  backgroundObjectUrl: null,
};
const handQueue = new RATCore.HandQueue();
const unreadChat = RATCore.createUnreadCounter((count) => updateCounter('chatUnread', count));
const unreadQuestions = RATCore.createUnreadCounter((count) => updateCounter('questionUnread', count));
const floatingModel = RATCore.createFloatingModel();
const statusMachine = new RATCore.ConnectionStateMachine(renderConnectionState);

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
}

function participantName(participant) {
  return participant?.name || participant?.identity || 'Participante';
}

function participantRole(participant) {
  try { return JSON.parse(participant?.metadata || '{}').role || 'VIEWER'; } catch { return 'VIEWER'; }
}

function isOrganizer() {
  return ['ADMIN', 'ORGANIZER'].includes(ui.session?.role);
}

function hasPublishPermission() {
  return ['ADMIN', 'ORGANIZER', 'PANELIST'].includes(ui.session?.role) || Boolean(ui.room?.localParticipant.permissions?.canPublish);
}

function setButtonState(button, active, activeLabel, inactiveLabel) {
  button.setAttribute('aria-pressed', String(active));
  button.classList.toggle('active', active);
  const label = button.querySelector('span:last-child');
  if (label) label.textContent = active ? activeLabel : inactiveLabel;
  else button.textContent = active ? activeLabel : inactiveLabel;
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
  }
}

function stopPreview() {
  cancelAnimationFrame(ui.meterFrame);
  ui.previewStream?.getTracks().forEach((track) => track.stop());
  ui.previewStream = null;
  document.getElementById('previewVideo').srcObject = null;
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

function setupPreflight() {
  const viewer = ui.session.role === 'VIEWER';
  document.querySelectorAll('.viewer-option').forEach((element) => { element.hidden = !viewer; });
  document.querySelectorAll('.presenter-option').forEach((element) => { element.hidden = viewer; });
  document.getElementById('previewButton').hidden = viewer;
  document.getElementById('preflightCamera').parentElement.hidden = viewer;
  document.getElementById('preflightMicrophone').parentElement.hidden = viewer;
  document.getElementById('preflightSpeaker').parentElement.hidden = viewer;
  document.querySelector('.meter').hidden = viewer;
  document.getElementById('displayNameInput').value = ui.session.displayName || '';
  document.getElementById('preflightMeeting').textContent = `${ui.session.meeting.title} · ${ui.session.meeting.trainerName}`;
  document.getElementById('recordingConsentLabel').hidden = !viewer || !ui.session.meeting.recordingConsentRequired;
  const connection = navigator.connection;
  document.getElementById('networkStatus').textContent = connection
    ? `Red estimada: ${connection.effectiveType || 'desconocida'}${connection.downlink ? ` · ${connection.downlink} Mbps` : ''}`
    : 'El navegador no informa una estimación previa de red.';
  document.getElementById('preflightDialog').showModal();
}

async function submitPreflight(event) {
  event.preventDefault();
  const error = document.getElementById('preflightError'); error.textContent = '';
  const viewer = ui.session.role === 'VIEWER';
  if (viewer && !document.getElementById('privacyConsent').checked) return void (error.textContent = 'Debes aceptar el aviso de privacidad para entrar.');
  if (viewer && ui.session.meeting.recordingConsentRequired && !document.getElementById('recordingConsent').checked) return void (error.textContent = 'Debes confirmar el aviso de grabación para entrar.');
  try {
    const displayName = document.getElementById('displayNameInput').value.trim();
    if (displayName !== ui.session.displayName) {
      const updated = await updateRoomProfile(displayName, ui.session.csrfToken);
      ui.session.displayName = updated.displayName; ui.session.csrfToken = updated.csrfToken;
    }
    const joinCamera = !viewer && document.getElementById('joinCamera').checked;
    const joinMicrophone = !viewer && document.getElementById('joinMicrophone').checked;
    stopPreview();
    document.getElementById('preflightDialog').close();
    await connectRoom({ joinCamera, joinMicrophone });
  } catch (requestError) { error.textContent = requestError.message; }
}

function setupTabs() {
  document.querySelectorAll('[data-room-tab]').forEach((button) => button.addEventListener('click', () => openTab(button.dataset.roomTab)));
  document.getElementById('btnChat').addEventListener('click', () => {
    const panel = document.getElementById('sidePanel');
    const visible = !panel.classList.toggle('closed');
    document.getElementById('btnChat').setAttribute('aria-pressed', String(visible));
    if (visible) openTab('chat');
  });
}

function openTab(name) {
  ui.activeTab = name;
  document.getElementById('sidePanel').classList.remove('closed');
  document.querySelectorAll('[data-room-tab]').forEach((button) => { const active = button.dataset.roomTab === name; button.setAttribute('aria-selected', String(active)); button.classList.toggle('active', active); });
  document.querySelectorAll('[data-room-panel]').forEach((panel) => panel.classList.toggle('active', panel.dataset.roomPanel === name));
  if (name === 'chat') unreadChat.clear();
  if (name === 'questions') unreadQuestions.clear();
  if (name === 'participants') renderHandQueue();
}

function renderParticipants(participants = []) {
  const container = document.getElementById('participantsList'); container.replaceChildren();
  for (const participant of participants) {
    const row = document.createElement('article'); row.className = 'participant-card';
    const info = document.createElement('div');
    const camera = participant.getTrackPublication?.(LivekitClient.Track.Source.Camera);
    const microphone = participant.getTrackPublication?.(LivekitClient.Track.Source.Microphone);
    const permission = participant.permissions || participant.permission || {};
    const quality = isOrganizer() && participant.connectionQuality ? ` · Red ${String(participant.connectionQuality).toLowerCase()}` : '';
    info.append(
      Object.assign(document.createElement('strong'), { textContent: participantName(participant) }),
      Object.assign(document.createElement('span'), { textContent: `${participantRole(participant)} · Mic ${microphone && !microphone.isMuted ? 'activo' : 'apagado'} · Cámara ${camera && !camera.isMuted ? 'activa' : 'apagada'}${quality}` })
    );
    row.appendChild(info);
    if (isOrganizer() && !participant.isLocal) {
      const actions = document.createElement('div'); actions.className = 'participant-actions';
      if (microphone && !microphone.isMuted) actions.appendChild(actionButton('Silenciar', () => muteParticipant(participant.identity)));
      if (permission.canPublish) actions.appendChild(actionButton('Quitar palabra', () => demoteParticipant(participant.identity)));
      const remove = actionButton('Expulsar', () => removeParticipant(participant.identity), 'danger compact');
      actions.appendChild(remove); row.appendChild(actions);
    }
    container.appendChild(row);
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
    const info = document.createElement('div'); info.append(Object.assign(document.createElement('strong'), { textContent: `${item.order}. ${item.displayName}` }), Object.assign(document.createElement('span'), { textContent: `${new Date(item.raisedAt).toLocaleTimeString('es-EC')} · ${item.status}` })); row.appendChild(info);
    const actions = document.createElement('div');
    for (const [label, action] of [['Dar palabra', () => promoteParticipant(item)], ['Rechazar', () => rejectHand(item)]]) {
      const button = document.createElement('button'); button.type = 'button'; button.className = label === 'Dar palabra' ? 'primary compact' : 'secondary compact'; button.textContent = label; button.onclick = action; actions.appendChild(button);
    }
    row.appendChild(actions); container.appendChild(row);
  }
}

async function promoteParticipant(item) {
  try {
    await roomRequest('/api/participants/promote', { method: 'POST', body: { targetIdentity: item.identity } }, ui.session.csrfToken);
    handQueue.update(item.identity, 'GRANTED'); renderHandQueue();
    await ui.chat.sendSystem({ kind: 'hand-approved', targetIdentity: item.identity });
  } catch (error) { showMessage(error.message, true); }
}

async function rejectHand(item) {
  handQueue.remove(item.identity); renderHandQueue();
  await ui.chat.sendSystem({ kind: 'hand-rejected', targetIdentity: item.identity });
}

async function removeParticipant(identity) {
  if (!confirm('¿Expulsar a este participante de la reunión?')) return;
  try { await roomRequest('/api/participants/remove', { method: 'POST', body: { targetIdentity: identity } }, ui.session.csrfToken); } catch (error) { showMessage(error.message, true); }
}

async function muteParticipant(targetIdentity) {
  try { await roomRequest('/api/participants/mute', { method: 'POST', body: { targetIdentity } }, ui.session.csrfToken); } catch (error) { showMessage(error.message, true); }
}

async function demoteParticipant(targetIdentity) {
  try { await roomRequest('/api/participants/demote', { method: 'POST', body: { targetIdentity } }, ui.session.csrfToken); } catch (error) { showMessage(error.message, true); }
}

async function toggleHand() {
  if (!ui.room) return;
  ui.handRaised = !ui.handRaised;
  setButtonState(document.getElementById('btnHand'), ui.handRaised, 'Cancelar', 'Mano');
  await ui.chat.sendSystem({ kind: ui.handRaised ? 'hand-raise' : 'hand-lower', identity: ui.session.identity, displayName: ui.session.displayName, raisedAt: new Date().toISOString() });
}

async function selfDemote() {
  await roomRequest('/api/participants/self-demote', { method: 'POST', body: {} }, ui.session.csrfToken);
}

function handleData(payload, participant) {
  try {
    const message = JSON.parse(new TextDecoder().decode(payload));
    if (message.kind === 'hand-raise' && ['ADMIN', 'ORGANIZER', 'PANELIST'].includes(ui.session.role)) {
      handQueue.raise(message.identity || participant?.identity, message.displayName || participantName(participant), message.raisedAt);
      renderHandQueue(); playAlert('hand'); systemNotification('Mano levantada', `${message.displayName || participantName(participant)} solicitó la palabra.`);
    }
    if (message.kind === 'hand-lower') { handQueue.remove(participant?.identity || message.identity); renderHandQueue(); }
    if (message.kind === 'hand-approved' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; renderMediaPermissions(); showMessage('El organizador te dio la palabra.'); }
    if (message.kind === 'hand-rejected' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; setButtonState(document.getElementById('btnHand'), false, 'Cancelar', 'Mano'); showMessage('La solicitud fue cerrada por el organizador.'); }
    if (message.kind === 'word-revoked' && message.targetIdentity === ui.session.identity) { ui.handRaised = false; renderMediaPermissions(); showMessage('El organizador retiró el permiso para hablar.'); }
    if (message.kind === 'recording-status') setRecordingIndicator(Boolean(message.active));
    if (message.kind === 'reaction') playAlert('reaction');
  } catch { /* Other binary data is ignored. */ }
}

function renderMediaPermissions() {
  const allowed = hasPublishPermission();
  document.getElementById('btnMic').disabled = !allowed;
  document.getElementById('btnCam').disabled = !allowed;
  if (!allowed) {
    ui.microphone = false; ui.camera = false;
    setButtonState(document.getElementById('btnMic'), false, 'Silenciar', 'Micrófono');
    setButtonState(document.getElementById('btnCam'), false, 'Apagar', 'Cámara');
  }
  if (ui.session?.role === 'VIEWER') {
    const handButton = document.getElementById('btnHand');
    if (allowed) {
      handButton.onclick = async () => { try { await selfDemote(); } catch (error) { showMessage(error.message, true); } };
      setButtonState(handButton, true, 'Bajar mano', 'Mano');
    } else {
      handButton.onclick = toggleHand;
      setButtonState(handButton, ui.handRaised, 'Cancelar', 'Mano');
    }
  }
}

async function toggleMicrophone() {
  if (!ui.room || !hasPublishPermission()) return;
  try {
    ui.microphone = !ui.microphone; await ui.room.localParticipant.setMicrophoneEnabled(ui.microphone);
    setButtonState(document.getElementById('btnMic'), ui.microphone, 'Silenciar', 'Micrófono'); floatingModel.update({ microphone: ui.microphone });
  } catch (error) { ui.microphone = false; showMessage(`Micrófono: ${error.message}`, true); }
}

async function toggleCamera() {
  if (!ui.room || !hasPublishPermission()) return;
  try {
    ui.camera = !ui.camera; await ui.room.localParticipant.setCameraEnabled(ui.camera);
    setButtonState(document.getElementById('btnCam'), ui.camera, 'Apagar', 'Cámara'); floatingModel.update({ camera: ui.camera });
    const publication = ui.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.Camera);
    if (ui.camera && publication?.track) ui.stage.setTrack(ui.session.identity, `${ui.session.displayName} (tú)`, 'camera', publication.track, { muted: true });
    else ui.stage.removeTrack(ui.session.identity, 'camera');
  } catch (error) { ui.camera = false; showMessage(`Cámara: ${error.message}`, true); }
}

async function toggleScreen() {
  if (!navigator.mediaDevices?.getDisplayMedia) return showMessage('Compartir pantalla no está disponible en este dispositivo o navegador.', true);
  if (!hasPublishPermission()) return showMessage('Tu rol no permite compartir pantalla.', true);
  try {
    ui.screen = !ui.screen;
    await ui.room.localParticipant.setScreenShareEnabled(ui.screen, { audio: true });
    document.getElementById('btnScreen').textContent = ui.screen ? 'Detener pantalla' : 'Compartir pantalla';
    if (ui.screen) {
      ui.stage.setSelfSharePlaceholder(ui.session.identity, `${ui.session.displayName} (pantalla)`);
      const publication = ui.room.localParticipant.getTrackPublication(LivekitClient.Track.Source.ScreenShare);
      publication?.track?.mediaStreamTrack?.addEventListener('ended', () => { ui.screen = false; ui.stage.removeTrack(ui.session.identity, 'screen'); document.getElementById('btnScreen').textContent = 'Compartir pantalla'; }, { once: true });
    } else ui.stage.removeTrack(ui.session.identity, 'screen');
  } catch (error) { ui.screen = false; showMessage(`Pantalla: ${error.message}`, true); }
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

function setRecordingIndicator(active) {
  ui.recording = active;
  document.getElementById('recordingBadge').hidden = !active;
  document.getElementById('btnRecord').textContent = active ? 'Detener grabación' : 'Iniciar grabación';
  floatingModel.update({ recording: active });
  playAlert(active ? 'recordingStart' : 'recordingStop');
}

async function toggleRecording() {
  if (!isOrganizer()) return;
  if (!ui.recording && !confirm('¿Iniciar la grabación? Se mostrará un aviso a todos los participantes.')) return;
  try {
    if (!ui.recording) {
      const result = await roomRequest('/api/recording/start', { method: 'POST', body: {} }, ui.session.csrfToken);
      ui.egressId = result.egressId; setRecordingIndicator(true);
    } else {
      await roomRequest('/api/recording/stop', { method: 'POST', body: { egressId: ui.egressId } }, ui.session.csrfToken);
      ui.egressId = null; setRecordingIndicator(false);
    }
    await broadcastRecordingStatus(ui.room, ui.recording);
  } catch (error) { showMessage(error.message, true); }
}

async function leaveRoom() {
  if (ui.recording && !confirm('La grabación sigue activa. Salir no finalizará la reunión ni detendrá automáticamente la grabación. ¿Salir?')) return;
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
  if (!confirm('Esto desconectará a todos y marcará la reunión como completada. ¿Finalizar para todos?')) return;
  try {
    if (ui.recording && ui.egressId) await roomRequest('/api/recording/stop', { method: 'POST', body: { egressId: ui.egressId } }, ui.session.csrfToken);
    await roomRequest('/api/room/end', { method: 'POST', body: {} }, ui.session.csrfToken);
    statusMachine.set('room_ended');
    await ui.room.disconnect(); window.location.href = '/dashboard.html';
  } catch (error) { showMessage(error.message, true); }
}

function setupControls() {
  document.getElementById('btnMic').onclick = toggleMicrophone;
  document.getElementById('btnCam').onclick = toggleCamera;
  document.getElementById('btnHand').onclick = ui.session.role === 'VIEWER' ? toggleHand : () => openTab('participants');
  document.getElementById('btnScreen').onclick = toggleScreen;
  document.getElementById('btnEffects').onclick = () => {
    const panel = document.getElementById('effectsPanel');
    panel.hidden = !panel.hidden;
    if (!ui.camera) showMessage('Activa la cámara para usar efectos.');
  };
  document.getElementById('btnParticipants').onclick = () => {
    openTab('participants');
    document.getElementById('morePanel').hidden = true;
  };
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
  document.querySelectorAll('.organizer-control').forEach((element) => { element.hidden = !isOrganizer(); });
  if (!navigator.mediaDevices?.getDisplayMedia) { document.getElementById('btnScreen').disabled = true; document.getElementById('btnScreen').title = 'Compartir pantalla no está disponible en este navegador.'; }
  document.getElementById('btnMore').onclick = () => { const panel = document.getElementById('morePanel'); panel.hidden = !panel.hidden; document.getElementById('btnMore').setAttribute('aria-expanded', String(!panel.hidden)); };
  document.getElementById('closeMore').onclick = () => { document.getElementById('morePanel').hidden = true; document.getElementById('btnMore').setAttribute('aria-expanded', 'false'); };
  document.getElementById('btnNotifications').onclick = async () => { try { const allowed = await requestNotificationPermission(); showMessage(allowed ? 'Notificaciones del sistema activadas.' : 'El permiso de notificaciones no fue concedido.'); } catch (error) { showMessage(error.message, true); } };
  for (const [id, kind] of [['cameraSelect', 'videoinput'], ['microphoneSelect', 'audioinput']]) document.getElementById(id).onchange = (event) => ui.room?.switchActiveDevice(kind, event.target.value).catch((error) => showMessage(error.message, true));
  document.getElementById('speakerSelect').onchange = (event) => document.querySelectorAll('audio, video').forEach((media) => media.setSinkId?.(event.target.value).catch(() => {}));
  attachCompanionWindow(document.getElementById('btnFloat'), floatingModel, {
    microphone: toggleMicrophone, camera: toggleCamera, chat: () => openTab('chat'), return: () => window.focus(), unsupported: (message) => showMessage(message, true),
  });
}

async function connectRoom({ joinCamera, joinMicrophone }) {
  statusMachine.set('connecting_signaling');
  const tokenData = await requestToken();
  if (isOrganizer() && !tokenData.recordingConfigured) {
    document.getElementById('btnRecord').disabled = true;
    document.getElementById('btnRecord').title = 'La grabación no está configurada en este entorno.';
  }
  const room = new LivekitClient.Room({ adaptiveStream: true, dynacast: true, disconnectOnPageLeave: false });
  ui.room = room;
  ui.stage = createStage(document.getElementById('stageGrid'), 'Esperando contenido de la reunión…');
  attachRemoteStageEvents(room, ui.stage);
  room.on(LivekitClient.RoomEvent.DataReceived, handleData);
  room.on(LivekitClient.RoomEvent.ParticipantPermissionsChanged, renderMediaPermissions);
  ui.roomUi = attachConnectionUI(room, {
    statusBadge: document.getElementById('connectionStatus'),
    countBadge: document.getElementById('participantCount'),
    floatingModel,
    onParticipantsChanged: renderParticipants,
  });
  statusMachine.set('connecting_media');
  await room.connect(tokenData.wsUrl, tokenData.token);
  ui.roomUi.machine.set('connected');
  statusMachine.set('connected');
  floatingModel.update({ title: tokenData.meeting.title, live: true });
  ui.chat = setupChat(room, ui.session.identity, {
    csrfToken: ui.session.csrfToken,
    role: ui.session.role,
    displayName: ui.session.displayName,
    onMessage(_participant, message) {
      const counter = message.kind === 'question' ? unreadQuestions : unreadChat;
      if (ui.activeTab !== (message.kind === 'question' ? 'questions' : 'chat') || document.getElementById('sidePanel').classList.contains('closed')) counter.increment();
      floatingModel.update({ unreadMessages: unreadChat.value + unreadQuestions.value });
    },
  });
  setupControls(); renderMediaPermissions(); renderParticipants([room.localParticipant]);
  await enumerateDevices();
  if (joinMicrophone) await toggleMicrophone();
  if (joinCamera) await toggleCamera();
  playConnectedSound();
}

async function initializeRoom() {
  setupTabs();
  document.getElementById('preflightForm').addEventListener('submit', submitPreflight);
  document.getElementById('previewButton').addEventListener('click', () => startPreview().catch((error) => { document.getElementById('preflightError').textContent = error.message; }));
  window.addEventListener('pagehide', () => {
    stopPreview();
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
    floatingModel.update({ title: ui.session.meeting.title, connection: 'waiting_for_room' });
    statusMachine.set('waiting_for_room');
    await enumerateDevices(); setupPreflight();
  } catch (error) {
    statusMachine.set(error.code === 'ROOM_ENDED' ? 'room_ended' : 'access_denied', error.message);
    document.querySelector('.room-layout').innerHTML = `<div class="access-denied"><h1>Acceso no disponible</h1><p></p><a class="button primary" href="/index.html">Volver al inicio</a></div>`;
    document.querySelector('.access-denied p').textContent = error.message;
    document.getElementById('roomControls').hidden = true;
  }
}

initializeRoom();
