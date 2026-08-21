const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ConnectionStateMachine,
  HandQueue,
  apiErrorMessage,
  createFloatingModel,
  createUnreadCounter,
  roleLabel,
  roomConnectionErrorMessage,
  mediaDeviceErrorMessage,
  safeHttpUrl,
  calendarRange,
  meetingsForLocalDay,
  meetingRoleCapabilities,
  meetingTiming,
  isLivePublication,
  normalizeMeetingRole,
  roleDescription,
  upcomingMeetings,
} = require('../public/app-core');
const { attachRemoteStageEvents, classifyTrackSource, effectiveRemoteVolume, selectActiveSpeaker } = require('../public/stage');
const { partitionQuestionFlow } = require('../public/questions');
const { nextPasswordType } = require('../public/password-toggle');

test('connection state machine exposes one coherent Spanish state', () => {
  const seen = [];
  const machine = new ConnectionStateMachine((state) => seen.push(state));
  machine.set('connecting_signaling');
  machine.set('connected');
  machine.set('reconnecting');
  assert.equal(seen.at(-1).label, 'Reconectando…');
  assert.equal(seen.at(-1).connected, false);
  assert.throws(() => machine.set('connecting-and-connected'));
});

test('unread counters increment and clear deterministically', () => {
  const counter = createUnreadCounter();
  counter.increment();
  counter.increment(3);
  assert.equal(counter.value, 4);
  counter.clear();
  assert.equal(counter.value, 0);
});

test('hand queue rejects duplicates and preserves order', () => {
  const queue = new HandQueue();
  queue.raise('a', 'Ana');
  queue.raise('a', 'Ana');
  queue.raise('b', 'Beto');
  assert.equal(queue.list().length, 2);
  queue.remove('a');
  assert.equal(queue.list()[0].order, 1);
  assert.equal(queue.list()[0].identity, 'b');
});

test('floating companion model synchronizes counters and media state', () => {
  const model = createFloatingModel({ title: 'Clase' });
  let latest;
  const unsubscribe = model.subscribe((state) => { latest = state; });
  model.update({ participants: 18, raisedHands: 2, unreadMessages: 4, microphone: true });
  assert.deepEqual(
    { participants: latest.participants, hands: latest.raisedHands, messages: latest.unreadMessages, mic: latest.microphone },
    { participants: 18, hands: 2, messages: 4, mic: true }
  );
  unsubscribe();
});

test('camera state requires a real live publication and screen tracks keep their source', () => {
  assert.equal(isLivePublication({ isMuted: false, track: { kind: 'video', mediaStreamTrack: { readyState: 'live' } } }, 'video'), true);
  assert.equal(isLivePublication({ isMuted: false, track: null }, 'video'), false);
  assert.equal(isLivePublication({ isMuted: true, track: { kind: 'video', mediaStreamTrack: { readyState: 'live' } } }, 'video'), false);
  assert.equal(isLivePublication({ isMuted: false, track: { kind: 'video', mediaStreamTrack: { readyState: 'ended' } } }, 'video'), false);
  assert.equal(classifyTrackSource({ source: 'screen_share', track: { kind: 'video' } }), 'screen');
  assert.equal(classifyTrackSource({ source: 'screen_share_audio', track: { kind: 'audio' } }), 'screen-audio');
  assert.equal(classifyTrackSource({ source: 'camera', track: { kind: 'video' } }), 'camera');
});

test('active speaker selection prefers a remote speaker and falls back stably to local', () => {
  const participants = [
    { identity: 'local', local: true },
    { identity: 'remote-a', local: false },
    { identity: 'remote-b', local: false, visible: false },
  ];
  assert.equal(selectActiveSpeaker(participants, ['local', 'remote-a']), 'remote-a');
  assert.equal(selectActiveSpeaker(participants, ['remote-b']), 'local');
  assert.equal(selectActiveSpeaker(participants, []), 'local');
});

test('meeting profiles expose canonical roles and least-privilege capabilities', () => {
  assert.equal(normalizeMeetingRole('WEBINAR', 'ATTENDEE'), 'ATTENDEE');
  assert.equal(normalizeMeetingRole('SESSION', '', 'VIEWER'), 'PARTICIPANT');
  assert.equal(normalizeMeetingRole('CLASS', '', 'ORGANIZER'), 'TEACHER');
  assert.equal(meetingRoleCapabilities('WEBINAR', 'ATTENDEE').canManageParticipants, false);
  assert.equal(meetingRoleCapabilities('WEBINAR', 'MODERATOR').canModerateQuestions, true);
  assert.equal(meetingRoleCapabilities('CLASS', 'TEACHER').canManageRecording, true);
  assert.match(roleDescription('CLASS', 'STUDENT'), /pantalla requiere autorizaci.n/i);
});

test('meeting timer starts from confirmed live time and handles terminal states', () => {
  const live = meetingTiming({
    status: 'LIVE', durationMinutes: 30,
    startedAt: '2035-05-01T12:00:00.000Z', livekitConfirmedAt: '2035-05-01T12:01:00.000Z',
  }, new Date('2035-05-01T12:11:30.000Z'));
  assert.deepEqual({ state: live.state, elapsed: live.elapsedSeconds, remaining: live.remainingSeconds }, { state: 'live', elapsed: 630, remaining: 1_170 });
  assert.equal(meetingTiming({ status: 'SCHEDULED', createdAt: '2020-01-01T00:00:00.000Z' }).elapsedSeconds, 0);
  assert.equal(meetingTiming({ status: 'COMPLETED' }).state, 'ended');
  assert.equal(meetingTiming({ status: 'CANCELLED' }).state, 'cancelled');
});

test('meeting and participant volume combine for current and future remote tracks without duplicate audio', () => {
  assert.equal(effectiveRemoteVolume(0.5, 0.5), 0.25);
  assert.equal(effectiveRemoteVolume(0, 1), 0);
  assert.equal(effectiveRemoteVolume(2, -1), 0);
  const previous = { document: global.document, LivekitClient: global.LivekitClient };
  const appended = [];
  const element = () => ({ classList: { add() {} }, dataset: {}, removeCalls: 0, remove() { this.removeCalls += 1; } });
  global.document = {
    documentElement: { dataset: {} }, body: { appendChild(item) { appended.push(item); } },
    addEventListener() {}, querySelectorAll() { return []; }, getElementById() { return null; },
  };
  global.LivekitClient = {
    RoomEvent: {
      TrackSubscribed: 'subscribed', TrackUnsubscribed: 'unsubscribed', TrackPublished: 'published',
      TrackUnpublished: 'unpublished', ParticipantDisconnected: 'disconnected', ActiveSpeakersChanged: 'speakers',
      TrackMuted: 'muted', TrackUnmuted: 'unmuted',
    },
    Track: { Source: { Microphone: 'microphone' } },
  };
  const handlers = new Map();
  const removed = [];
  const room = { on(event, handler) { handlers.set(event, handler); }, off(event, handler) { removed.push([event, handler]); } };
  const stage = { setScreenAudio() {}, removeTrack() {}, setParticipantState() {}, setTrack() {}, setSpeaking() {}, removeParticipant() {} };
  const makeTrack = () => {
    const media = element();
    return { kind: 'audio', media, volumes: [], detachCalls: 0, attach() { return media; }, detach() { this.detachCalls += 1; return []; }, setVolume(value) { this.volumes.push(value); } };
  };
  try {
    const audio = attachRemoteStageEvents(room, stage);
    audio.setMeetingVolume(0.5);
    audio.setParticipantVolume('ana', 0.5);
    const current = makeTrack();
    handlers.get('subscribed')(current, { source: 'microphone' }, { identity: 'ana' });
    assert.equal(current.volumes.at(-1), 0.25);
    audio.setMeetingVolume(0);
    assert.equal(current.volumes.at(-1), 0);
    const future = makeTrack();
    handlers.get('subscribed')(future, { source: 'screen_share_audio' }, { identity: 'beto' });
    assert.equal(future.volumes.at(-1), 0);
    audio.setMeetingVolume(1);
    assert.equal(future.volumes.at(-1), 1);
    const replacement = makeTrack();
    handlers.get('subscribed')(replacement, { source: 'microphone' }, { identity: 'ana' });
    assert.equal(current.detachCalls, 1);
    assert.equal(current.media.removeCalls, 1);
    audio.dispose();
    assert.equal(removed.length, Object.keys(global.LivekitClient.RoomEvent).length);
    assert.ok(replacement.detachCalls >= 1);
    assert.equal(appended.length, 3);
  } finally {
    global.document = previous.document;
    global.LivekitClient = previous.LivekitClient;
  }
});

test('discarded questions are partitioned out of the active Q&A flow', () => {
  const flow = partitionQuestionFlow([
    { id: 'pending', status: 'PENDING' },
    { id: 'answered', status: 'ANSWERED_WRITTEN' },
    { id: 'dismissed', status: 'DISMISSED', answer: 'Respuesta archivada' },
  ]);
  assert.deepEqual(flow.active.map((item) => item.id), ['pending', 'answered']);
  assert.deepEqual(flow.dismissed.map((item) => item.id), ['dismissed']);
});

test('chat URL sanitizer blocks executable schemes', () => {
  assert.equal(safeHttpUrl('javascript:alert(1)'), null);
  assert.equal(safeHttpUrl('data:text/html,boom'), null);
  assert.match(safeHttpUrl('https://example.com/file.pdf'), /^https:/);
});

test('critical responsive CSS includes dynamic viewport, safe areas and target breakpoints', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  assert.match(css, /100dvh/);
  assert.match(css, /safe-area-inset-bottom/);
  assert.match(css, /minmax\(0, 1fr\)/);
  assert.match(css, /@media \(max-width: 700px\)/);
  assert.match(css, /overflow: hidden/);
});

test('authentication UI does not persist credentials in localStorage', () => {
  const files = ['login.js', 'dashboard.js', 'recordings.js'].map((name) => fs.readFileSync(path.join(__dirname, '..', 'public', name), 'utf8')).join('\n');
  assert.doesNotMatch(files, /localStorage/);
  assert.match(files, /credentials: 'same-origin'/);
});

test('dashboard information architecture separates trainings from independent meetings', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
  assert.match(html, /data-section="trainings"[\s\S]*>Capacitaciones</);
  assert.match(html, /data-section-panel="trainings"/);
  assert.match(html, /id="trainingSeriesList"/);
  assert.match(html, /id="includeArchivedSeries"/);
  assert.match(script, /renderTrainingSeries/);
  assert.match(script, /includeArchived=true/);
  assert.doesNotMatch(html, /data-section-panel="meetings"[\s\S]*data-open-series/);
});

test('training action menu is viewport-aware and exposes archive restore actions', () => {
  const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'style.css'), 'utf8');
  const script = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
  assert.match(css, /\.training-series-card\s*\{[^}]*overflow: visible/);
  assert.match(css, /\.action-menu-items\s*\{[^}]*position: fixed/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*\.action-menu-items\s*\{[^}]*position: static/);
  assert.match(script, /function positionActionMenu/);
  assert.match(script, /function closeActionMenus/);
  assert.match(script, /openActionMenus\(\)\.length/);
  assert.match(script, /Archivar capacitación/);
  assert.match(script, /Restaurar capacitación/);
  assert.match(script, /¿Archivar esta capacitación\?/);
  assert.match(script, /¿Restaurar esta capacitación\?/);
});

test('visible roles and room connection failures are translated safely', () => {
  assert.equal(roleLabel('ADMIN'), 'Administrador');
  assert.equal(roleLabel('VIEWER'), 'Asistente');
  assert.equal(roleLabel('unexpected'), 'Participante');
  assert.match(roomConnectionErrorMessage(new Error('websocket failed')), /No se pudo conectar al servicio de videoconferencia/);
  assert.equal(roomConnectionErrorMessage({ status: 410, code: 'ROOM_ENDED', message: 'La reunión finalizó.' }), 'La reunión finalizó.');
});

test('frontend failures expose safe actionable messages without leaking internals', () => {
  assert.match(apiErrorMessage({ status: 401 }), /sesión expiró/i);
  assert.match(apiErrorMessage({ status: 403 }), /permisos/i);
  assert.match(apiErrorMessage({ status: 429 }), /demasiados intentos/i);
  assert.match(apiErrorMessage({ status: 503, message: 'stack trace connection refused' }), /servicio no respondió/i);
  assert.equal(apiErrorMessage({ message: 'Campo requerido' }), 'Campo requerido');
  assert.match(mediaDeviceErrorMessage({ name: 'NotAllowedError' }, 'cámara'), /permiso está bloqueado/i);
  assert.match(mediaDeviceErrorMessage({ name: 'NotReadableError' }, 'micrófono'), /ocupado por otra aplicación/i);
  assert.match(mediaDeviceErrorMessage({ name: 'UnknownError' }, 'selector de pantalla'), /selector de pantalla/i);
});

test('password visibility toggles between secure and readable input types', () => {
  assert.equal(nextPasswordType('password'), 'text');
  assert.equal(nextPasswordType('text'), 'password');
});

test('calendar ranges keep meetings synchronized across month, week and day views', () => {
  const meeting = { title: 'Reunión calendario', scheduledAt: '2032-07-14T15:30:00-05:00', status: 'SCHEDULED' };
  const anchor = new Date('2032-07-14T12:00:00-05:00');
  for (const view of ['month', 'week', 'day']) {
    const days = calendarRange(anchor, view);
    assert.ok(days.some((day) => meetingsForLocalDay([meeting], day).length === 1), view);
  }
  assert.equal(calendarRange(anchor, 'month').length, 42);
  assert.equal(calendarRange(anchor, 'week').length, 7);
  assert.equal(calendarRange(anchor, 'day').length, 1);
});

test('upcoming meetings are sorted, exclude past and terminal states', () => {
  const now = new Date('2035-01-10T12:00:00.000Z');
  const items = [
    { title: 'Pasada', scheduledAt: '2035-01-09T12:00:00.000Z', status: 'SCHEDULED' },
    { title: 'Futura dos', scheduledAt: '2035-01-12T12:00:00.000Z', status: 'SCHEDULED' },
    { title: 'Cancelada', scheduledAt: '2035-01-11T12:00:00.000Z', status: 'CANCELLED' },
    { title: 'Futura uno', scheduledAt: '2035-01-11T10:00:00.000Z', status: 'SCHEDULED' },
  ];
  assert.deepEqual(upcomingMeetings(items, now).map((item) => item.title), ['Futura uno', 'Futura dos']);
});
