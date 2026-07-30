const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ConnectionStateMachine,
  HandQueue,
  createFloatingModel,
  createUnreadCounter,
  roleLabel,
  roomConnectionErrorMessage,
  safeHttpUrl,
  calendarRange,
  meetingsForLocalDay,
  upcomingMeetings,
} = require('../public/app-core');
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

test('visible roles and room connection failures are translated safely', () => {
  assert.equal(roleLabel('ADMIN'), 'Administrador');
  assert.equal(roleLabel('VIEWER'), 'Asistente');
  assert.equal(roleLabel('unexpected'), 'Participante');
  assert.match(roomConnectionErrorMessage(new Error('websocket failed')), /No se pudo conectar al servicio de videoconferencia/);
  assert.equal(roomConnectionErrorMessage({ status: 410, code: 'ROOM_ENDED', message: 'La reunión finalizó.' }), 'La reunión finalizó.');
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
