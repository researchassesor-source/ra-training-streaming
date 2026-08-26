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
  assert.match(source, /mode === 'compact' \? 'full' : mode === 'full' \? 'minimal' : 'compact'/);
  assert.match(source, /compact: \[420, 210\][\s\S]*full: \[420, 430\][\s\S]*minimal: \[300, 72\]/);
  assert.match(source, /requestWindow\(\{ width: sizes\[mode\]\[0\], height: sizes\[mode\]\[1\] \}\)/);
  assert.match(source, /companion-speaker/);
  assert.match(source, /renderActiveSpeaker/);
  assert.match(source, /companion-popover/);
  assert.match(source, /setPopover\(documentRef, 'chat'\)/);
  assert.match(source, /setPopover\(documentRef, 'participants'\)/);
  assert.match(source, /event\.key !== 'Escape'/);
  assert.match(source, /actions\.sendChat/);
  assert.match(source, /actions\.chatDraft/);
  assert.match(source, /handle\.removeEventListener\('pointerdown', start\)/);
});

test('stage renders one debounced active-speaker mini while screen sharing and cleans remote listeners', () => {
  const source = fs.readFileSync(path.join(publicDir, 'stage.js'), 'utf8');
  assert.match(source, /video-avatar/);
  assert.match(source, /setParticipantVisibility/);
  assert.match(source, /screenshareaudio/);
  assert.match(source, /TrackPublished/);
  assert.match(source, /TrackUnpublished/);
  assert.match(source, /classifyTrackSource/);
  assert.match(source, /document\.body\.appendChild\(element\)/);
  assert.match(source, /dispose\(\).*room\.off/s);
  assert.match(source, /selectActiveSpeaker/);
  assert.match(source, /speakerSwitchTimer/);
  assert.match(source, /450/);
  assert.match(source, /900/);
  assert.doesNotMatch(source, /local-overlay/);
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(css, /\.video-tile \.video-avatar\s*\{\s*display:\s*grid/);
  assert.match(css, /\.video-tile\.has-video \.video-avatar\s*\{\s*display:\s*none/);
  assert.match(css, /\.active-speaker-mini/);
  assert.match(css, /\.active-speaker-mini\.is-speaking/);
  assert.match(css, /\.companion-speaker/);
  assert.match(css, /data-mode="minimal"/);
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

test('new mobile, media and invitation contracts are explicit and accessible', () => {
  const room = fs.readFileSync(path.join(publicDir, 'room-ui.js'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const dashboard = fs.readFileSync(path.join(publicDir, 'dashboard.js'), 'utf8');
  const dashboardHtml = fs.readFileSync(path.join(publicDir, 'dashboard.html'), 'utf8');
  const presenter = fs.readFileSync(path.join(publicDir, 'presenter.html'), 'utf8');
  const viewer = fs.readFileSync(path.join(publicDir, 'viewer.html'), 'utf8');
  assert.match(room, /matchMedia\?\.\('\(max-width: 700px\)'\)[\s\S]*closeSidePanel\(\)/);
  assert.match(room, /sessionStorage\.setItem\('rat:room-side-panel', 'closed'\)/);
  assert.match(room, /if \(ui\.activeTab !==[\s\S]*counter\.increment\(\)/);
  assert.match(css, /button\[data-media-state="active"\][^{]*\{[^}]*var\(--brand-orange\)/);
  assert.match(css, /button\[data-media-state="locked"\][^{]*\{[^}]*#4d5668/);
  assert.match(css, /data-media-state="locked"\][^:]*::after[^}]*🔒/);
  assert.match(css, /@media \(max-width: 370px\)/);
  assert.match(css, /safe-area-inset-left/);
  assert.match(presenter, /id="preflightRole"/);
  assert.match(presenter, /id="preflightType"/);
  assert.match(presenter, /id="preflightSpeakerTest"/);
  assert.match(presenter, /id="screenCompatibilityHelp"/);
  assert.match(viewer, /id="chatControlUnread"[^>]*aria-label="Mensajes nuevos"/);
  assert.match(room, /updateCounter\('chatControlUnread', count\)/);
  assert.match(room, /speakerModeLabel'\)\.hidden = !canUsePresenterPanel/);
  assert.match(room, /recordingHelp'\)\.hidden = !ui\.session\.capabilities\?\.canManageRecording/);
  assert.match(dashboard, /openSimpleMeetingAccessDialog\(item, 'HOST'\)/);
  assert.match(dashboard, /openSimpleMeetingAccessDialog\(item, 'PARTICIPANT'\)/);
  assert.match(dashboard, /\/simple-accesses\/\$\{kind\}/);
  assert.match(dashboardHtml, /id="openInvitationLink"/);
  assert.match(dashboardHtml, /Enlace de acceso/);
  assert.match(room, /createInRoomAccess\('PARTICIPANT'\)/);
  assert.match(room, /createInRoomAccess\('HOST'\)/);
  assert.match(room, /\/api\/room\/simple-accesses\/\$\{kind\}/);
  assert.match(presenter, /Copiar enlace de participante/);
  assert.match(presenter, /Copiar enlace de anfitrión/);
  assert.match(viewer, /Copiar enlace de participante/);
  assert.match(viewer, /Copiar enlace de anfitrión/);
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
  assert.match(room, /renderParticipants\(\[room\.localParticipant, \.\.\.room\.remoteParticipants\.values\(\)\]\)/);
  const questions = fs.readFileSync(path.join(publicDir, 'questions.js'), 'utf8');
  for (const feature of ['voteCount', 'ANSWERED_LIVE', 'ANSWERED_WRITTEN', 'DISMISSED', 'pinned', 'questionSort']) assert.match(questions, new RegExp(feature));
  assert.match(questions, /partitionQuestionFlow/);
  assert.match(questions, /Ver.*descartadas/);
  assert.match(questions, /Historial de descartadas/);
  assert.match(questions, /flow\.active/);
  assert.match(questions, /archive\.tabIndex = -1/);
});

test('room requests bind the tab selector and failed chat or Q&A restores the draft', () => {
  const access = fs.readFileSync(path.join(publicDir, 'access.js'), 'utf8');
  assert.match(access, /credentials:\s*'same-origin'/);
  assert.match(access, /X-Room-Session-ID/);
  assert.match(access, /sessionStorage/);
  assert.match(access, /X-Room-CSRF/);
  const chat = fs.readFileSync(path.join(publicDir, 'chat.js'), 'utf8');
  assert.match(chat, /inputEl\.value = ''[\s\S]*?const sent = await sendText[\s\S]*?if \(!sent && !inputEl\.value\)/);
  assert.match(chat, /if \(sending \|\| event\.isComposing\) return/);
  assert.match(chat, /Reintentar/);
  assert.match(chat, /onHistoryChange/);
  assert.match(chat, /onDraftChange/);
  assert.match(chat, /const listenerController = new AbortController\(\)/);
  assert.match(chat, /listenerController\.abort\(\)/);
  assert.match(chat, /emojiPicker\.replaceChildren\(\)/);
  const room = fs.readFileSync(path.join(publicDir, 'room-ui.js'), 'utf8');
  assert.doesNotMatch(room, /__roomCompactQa|Temporary local-only browser QA harness/);
});

test('chat linkification and pinned messages stay safe, persistent and mobile compact', () => {
  const chat = fs.readFileSync(path.join(publicDir, 'chat.js'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  const app = fs.readFileSync(path.join(__dirname, '..', 'server', 'app.js'), 'utf8');
  const pins = fs.readFileSync(path.join(__dirname, '..', 'server', 'pinned-messages.js'), 'utf8');
  assert.match(chat, /function appendLinkifiedText\(container, text\)/);
  assert.match(chat, /RATCore\.safeHttpUrl\(normalized, location\.origin\)/);
  assert.match(chat, /link\.target = '_blank'/);
  assert.match(chat, /link\.rel = 'noopener noreferrer'/);
  assert.doesNotMatch(chat, /innerHTML/);
  assert.match(chat, /chat-pins-changed/);
  assert.match(chat, /roomRequest\('\/api\/chat\/pins'/);
  assert.match(chat, /roomRequest\(`\/api\/chat\/pins\/\$\{encodeURIComponent\(pin\.id\)\}`/);
  assert.match(chat, /pinnedRoot\.hidden = count === 0/);
  assert.match(chat, /pins\.expanded = !pins\.expanded/);
  assert.match(chat, /new Set\(\['HOST', 'TEACHER', 'COHOST'\]\)/);
  assert.match(css, /\.chat-pinned-summary/);
  assert.match(css, /\.chat-pinned-panel[^}]*max-height: 220px/);
  assert.match(css, /\.chat-pin-badge/);
  assert.match(css, /@media \(max-width: 700px\)[\s\S]*?\.chat-pinned-panel[^}]*max-height: 34dvh/);
  assert.match(app, /function canPinChat\(meetingRole\)[\s\S]*HOST[\s\S]*TEACHER[\s\S]*COHOST/);
  assert.match(app, /app\.get\('\/api\/chat\/pins'/);
  assert.match(app, /app\.post\('\/api\/chat\/pins'/);
  assert.match(app, /app\.delete\('\/api\/chat\/pins\/:id'/);
  assert.match(app, /relayRoomData\(req, \{ kind: 'chat-pins-changed'/);
  assert.match(pins, /storageConfigured/);
  assert.match(pins, /localStore\.writeJson\('chat-pins'/);
});
