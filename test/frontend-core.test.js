const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  ConnectionStateMachine,
  HandQueue,
  createFloatingModel,
  createUnreadCounter,
  safeHttpUrl,
} = require('../public/app-core');

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
