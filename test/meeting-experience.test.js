const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicDir = path.join(__dirname, '..', 'public');

test('professional room surfaces expose direct, accessible and role-aware controls', () => {
  for (const file of ['presenter.html', 'viewer.html']) {
    const html = fs.readFileSync(path.join(publicDir, file), 'utf8');
    for (const id of ['btnMic', 'btnCam', 'btnScreen', 'btnChat', 'btnHand', 'btnParticipants', 'btnMore', 'btnLeave']) {
      assert.match(html, new RegExp(`id="${id}"`), `${file}: ${id}`);
    }
    for (const id of ['meetingTimer', 'qualityBadge', 'roomLockBadge', 'toastRegion', 'questionSort', 'autoFloatOnShare']) {
      assert.match(html, new RegExp(`id="${id}"`), `${file}: ${id}`);
    }
    assert.match(html, /aria-label="Compartir pantalla"/);
    assert.match(html, /Ctrl\/⌘ Shift M/);
  }
});

test('floating controls synchronize every critical state and fall back inside the room', () => {
  const source = fs.readFileSync(path.join(publicDir, 'floating-bar.js'), 'utf8');
  for (const state of ['microphone', 'camera', 'screen', 'handRaised', 'elapsedSeconds', 'participants', 'raisedHands', 'unreadMessages', 'pendingQuestions', 'recentReaction', 'recording', 'connection', 'quality', 'locked']) {
    assert.match(source, new RegExp(state), state);
  }
  assert.match(source, /documentPictureInPicture\.requestWindow/);
  assert.match(source, /companion-fallback/);
  assert.match(source, /function close\(\)[\s\S]*?button\.setAttribute\('aria-pressed', 'false'\)/);
  assert.doesNotMatch(source, /disconnect\(/);
  assert.match(source, /fallback\.hidden = false/);
  assert.match(source, /if \(fallback\)[\s\S]*?model\.subscribe/);
  assert.match(source, /let mode = 'compact'/);
  assert.match(source, /data-mode="\$\{mode\}"/);
  assert.match(source, /applyMode\(documentRef, mode === 'compact' \? 'expanded' : 'compact'\)/);
  assert.match(source, /requestWindow\(\{ width: mode === 'compact' \? 760 : 460/);
});

test('stage keeps a draggable local avatar while screen sharing and cleans remote listeners', () => {
  const source = fs.readFileSync(path.join(publicDir, 'stage.js'), 'utf8');
  assert.match(source, /local-overlay/);
  assert.match(source, /makeContainedDraggable/);
  assert.match(source, /video-avatar/);
  assert.match(source, /setParticipantVisibility/);
  assert.match(source, /screenshareaudio/);
  assert.match(source, /TrackPublished/);
  assert.match(source, /TrackUnpublished/);
  assert.match(source, /classifyTrackSource/);
  assert.match(source, /document\.body\.appendChild\(element\)/);
  assert.match(source, /dispose\(\).*room\.off/s);
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(css, /\.video-tile\.local-overlay/);
  assert.match(css, /\.video-tile \.video-avatar\s*\{\s*display:\s*grid/);
  assert.match(css, /\.video-tile\.has-video \.video-avatar\s*\{\s*display:\s*none/);
});

test('side panel collapse, mobile controls and reduced motion are explicit', () => {
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(css, /\.room-side-panel\.closed\s*\{\s*display:\s*none/);
  assert.match(css, /\.room-layout\.panel-closed\s*\{\s*grid-template-columns:\s*100%/);
  assert.match(css, /\.room-layout\.panel-closed > \.room-side-panel\s*\{\s*display:\s*none/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?#btnScreen[\s\S]*?display:\s*none/);
  assert.match(css, /\.mobile-only\s*\{\s*display:\s*none/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /outline:\s*3px solid/);
});

test('meeting notifier groups repeated toasts and reports permission states', async () => {
  class FakeClassList { toggle() {} }
  class FakeElement {
    constructor(tag) { this.tag = tag; this.children = []; this.classList = new FakeClassList(); this.parent = null; this.textContent = ''; }
    append(...children) { children.forEach((child) => this.appendChild(child)); }
    appendChild(child) { child.parent = this; this.children.push(child); return child; }
    setAttribute() {}
    remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  }
  const previous = { document: global.document, window: global.window, Notification: global.Notification, playAlert: global.playAlert, systemNotification: global.systemNotification, requestNotificationPermission: global.requestNotificationPermission };
  const container = new FakeElement('div');
  const NotificationStub = { permission: 'granted' };
  global.document = { createElement: (tag) => new FakeElement(tag), hidden: false };
  global.window = { Notification: NotificationStub };
  global.Notification = NotificationStub;
  global.playAlert = () => {};
  global.systemNotification = () => {};
  global.requestNotificationPermission = async () => true;
  try {
    delete require.cache[require.resolve('../public/meeting-notifications')];
    const { createMeetingNotifier } = require('../public/meeting-notifications');
    const notifier = createMeetingNotifier(container);
    assert.equal(notifier.permissionState(), 'granted');
    notifier.notify('chat', { title: 'Mensaje', message: 'Uno', system: false });
    notifier.notify('chat', { title: 'Mensaje', message: 'Dos', system: false });
    assert.equal(container.children.length, 1);
    assert.equal(container.children[0].children[1].textContent, 'Dos (2)');
    assert.deepEqual(await notifier.requestPermission(), { granted: true, state: 'granted' });
    notifier.dispose();
    assert.equal(container.children.length, 0);
  } finally {
    Object.assign(global, previous);
  }
});

test('room implementation includes Q&A, notifications, locks, shortcuts and bounded cleanup', () => {
  const room = fs.readFileSync(path.join(publicDir, 'room-ui.js'), 'utf8');
  for (const contract of ['setupQuestions', 'toggleRoomLock', 'createInRoomInvitation', 'setupKeyboardShortcuts', 'finishScreenShare', 'createMeetingNotifier']) {
    assert.match(room, new RegExp(contract), contract);
  }
  assert.match(room, /ui\.chat\?\.dispose\(\)/);
  assert.match(room, /ui\.stageEvents\?\.dispose\(\)/);
  assert.match(room, /clearInterval\(ui\.elapsedTimer\)/);
  assert.match(room, /event\.ctrlKey \|\| event\.metaKey/);
  assert.match(room, /Solicitar activar micrófono/);
  assert.match(room, /Bloquear acceso/);
  assert.match(room, /participant-more/);
  assert.match(room, /askConfirmation\(\{[\s\S]*?Expulsar participante/);
  assert.match(room, /handleMicrophoneRequest/);
  assert.match(room, /media-response/);
  const questions = fs.readFileSync(path.join(publicDir, 'questions.js'), 'utf8');
  for (const feature of ['voteCount', 'ANSWERED_LIVE', 'ANSWERED_WRITTEN', 'DISMISSED', 'pinned', 'questionSort']) assert.match(questions, new RegExp(feature));
});

test('room requests bind the tab selector and failed chat or Q&A restores the draft', () => {
  const access = fs.readFileSync(path.join(publicDir, 'access.js'), 'utf8');
  assert.match(access, /credentials:\s*'same-origin'/);
  assert.match(access, /X-Room-Session-ID/);
  assert.match(access, /sessionStorage/);
  assert.match(access, /X-Room-CSRF/);
  const chat = fs.readFileSync(path.join(publicDir, 'chat.js'), 'utf8');
  assert.match(chat, /inputEl\.value = ''[\s\S]*?const sent = await sendText[\s\S]*?if \(!sent && !inputEl\.value\) inputEl\.value = text/);
  assert.match(chat, /if \(sending \|\| event\.isComposing\) return/);
  assert.match(chat, /Reintentar/);
});
