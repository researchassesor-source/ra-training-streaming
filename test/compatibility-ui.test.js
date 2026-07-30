const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { normalizeStoredMeeting } = require('../server/meetings');
const { recordingStateFromEgress } = require('../server/app');
const { EgressStatus } = require('livekit-server-sdk');
const { RecordingStateMachine, localDateKey, normalizeMeeting, shouldSubmitChat } = require('../public/app-core');

const publicDir = path.join(__dirname, '..', 'public');

test('legacy meetings are normalized non-destructively with safe compatibility defaults', () => {
  const legacy = { room: 'reunion-antigua', title: 'Reunión antigua', scheduledAt: '2030-07-30T14:00:00.000Z', customLegacyField: 'conservar' };
  const before = structuredClone(legacy);
  const normalized = normalizeStoredMeeting(legacy);
  assert.deepEqual(legacy, before);
  assert.equal(normalized.description, '');
  assert.equal(normalized.trainerName, 'Capacitador por definir');
  assert.equal(normalized.durationMinutes, 60);
  assert.equal(normalized.type, 'WEBINAR');
  assert.equal(normalized.status, 'SCHEDULED');
  assert.equal(normalized.capacity, 100);
  assert.equal(normalized.allowRecording, false);
  assert.equal(normalized.recordingConsentRequired, false);
  assert.equal(normalized.customLegacyField, 'conservar');
  assert.equal(normalized.endsAt, '2030-07-30T15:00:00.000Z');
});

test('invalid legacy dates never escape as Invalid Date and missing endsAt remains safe', () => {
  const normalized = normalizeStoredMeeting({ room: 'fecha-invalida', title: '', scheduledAt: 'not-a-date', capacity: 'NaN' });
  assert.equal(normalized.scheduledAt, null);
  assert.equal(normalized.endsAt, null);
  assert.equal(normalized.capacity, 100);
  assert.equal(normalized.title, 'Reunión sin título');
  assert.doesNotMatch(JSON.stringify(normalized), /Invalid Date|NaN|undefined|\[object Object\]/);
});

test('frontend meeting compatibility applies human fallbacks and derives end time', () => {
  const meeting = normalizeMeeting({ room: 'frontend-antigua', scheduledAt: '2035-01-03T10:00:00.000Z' });
  assert.equal(meeting.trainerName, 'Capacitador por definir');
  assert.equal(meeting.description, '');
  assert.equal(meeting.capacity, 100);
  assert.equal(meeting.type, 'WEBINAR');
  assert.equal(meeting.endsAt, '2035-01-03T11:00:00.000Z');
});

test('calendar date keys use local components and preserve July 30', () => {
  const localJuly30 = new Date(2032, 6, 30, 23, 45);
  assert.equal(localDateKey(localJuly30), '2032-07-30');
  const dashboard = fs.readFileSync(path.join(publicDir, 'dashboard.js'), 'utf8');
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(dashboard, /RATCore\.localDateKey\(meeting\.scheduledAt\)/);
  assert.match(dashboard, /aria-label/);
  assert.match(css, /calendar-day\.adjacent-month/);
  assert.match(css, /calendar-event\.status-completed/);
});

test('recording state is false when disabled, unknown, failed, stopped or processing', () => {
  let latest;
  const disabled = new RecordingStateMachine((snapshot) => { latest = snapshot; }, false);
  assert.equal(latest.state, 'DISABLED');
  assert.equal(latest.active, false);
  disabled.set('UNKNOWN', { active: true, egressId: 'unsafe' });
  assert.equal(latest.state, 'FAILED');
  assert.equal(latest.active, false);
  const machine = new RecordingStateMachine((snapshot) => { latest = snapshot; }, true);
  machine.set('FAILED', { active: true, egressId: 'unsafe' });
  assert.equal(latest.active, false);
  machine.set('RECORDING', { active: true, egressId: 'egress-confirmed' });
  assert.equal(latest.active, true);
  machine.set('STOPPING', { active: true, egressId: 'egress-confirmed' });
  assert.equal(latest.active, false);
  machine.set('PROCESSING');
  assert.equal(latest.active, false);
});

test('LiveKit Egress mapping only marks EGRESS_ACTIVE as recording', () => {
  assert.equal(recordingStateFromEgress({ status: EgressStatus.EGRESS_STARTING, egressId: 'a' }).active, false);
  assert.equal(recordingStateFromEgress({ status: EgressStatus.EGRESS_ACTIVE, egressId: 'b' }).active, true);
  assert.equal(recordingStateFromEgress({ status: EgressStatus.EGRESS_FAILED, egressId: 'c' }).active, false);
  assert.equal(recordingStateFromEgress({ status: 999, egressId: 'd' }).active, false);
});

test('chat keyboard rules support Enter, Shift+Enter and IME composition safely', () => {
  assert.equal(shouldSubmitChat({ key: 'Enter', shiftKey: false, isComposing: false }), true);
  assert.equal(shouldSubmitChat({ key: 'Enter', shiftKey: true, isComposing: false }), false);
  assert.equal(shouldSubmitChat({ key: 'Enter', shiftKey: false, isComposing: true }), false);
  assert.equal(shouldSubmitChat({ key: 'Enter', shiftKey: false, isComposing: false, keyCode: 229 }), false);
  const roomHtml = fs.readFileSync(path.join(publicDir, 'viewer.html'), 'utf8');
  const chatJs = fs.readFileSync(path.join(publicDir, 'chat.js'), 'utf8');
  assert.match(roomHtml, /<textarea id="chatInput"[^>]*rows="2"/);
  assert.match(roomHtml, /aria-describedby="chatLimit chatError"/);
  assert.match(chatJs, /let sending = false/);
  assert.match(chatJs, /const drafts =/);
  assert.match(chatJs, /AbortController/);
});

test('official logo and optimized derivatives exist and all required surfaces reference them', () => {
  const assets = ['streaming-app-logo.png', 'favicon-16.png', 'favicon-32.png', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'mascot-original.png', 'mascot-login.png', 'mascot-login.webp'];
  for (const asset of assets) assert.ok(fs.statSync(path.join(publicDir, 'assets', asset)).size > 0, asset);
  const references = {
    login: fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'),
    dashboard: fs.readFileSync(path.join(publicDir, 'dashboard.html'), 'utf8'),
    room: fs.readFileSync(path.join(publicDir, 'presenter.html'), 'utf8'),
    floating: fs.readFileSync(path.join(publicDir, 'floating-bar.js'), 'utf8'),
    recordings: fs.readFileSync(path.join(publicDir, 'recordings.html'), 'utf8'),
  };
  for (const [surface, source] of Object.entries(references)) assert.match(source, /icon-192|favicon-32|mascot-login/, surface);
  assert.match(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'), /icon-512\.png/);
  const brandSource = fs.readFileSync(path.join(publicDir, 'brand.js'), 'utf8');
  const visibleBrandSources = [brandSource, fs.readFileSync(path.join(publicDir, 'sounds.js'), 'utf8'), references.login].join('\n');
  assert.doesNotMatch(visibleBrandSources, /assets\/logo\.png|assets\/mascot\.png/);
  assert.equal((brandSource.match(/<img/g) || []).length, 1);
});

test('mobile login keeps the form first and renders a compact non-overlapping mascot', () => {
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /@media \(max-width: 1024px\)[\s\S]*?\.login-card\s*\{\s*grid-row:\s*1/);
  assert.match(css, /@media \(max-width: 1024px\)[\s\S]*?\.login-mascot\s*\{/);
  assert.match(css, /\.login-mascot img\s*\{[^}]*object-fit:\s*contain/);
  assert.match(css, /\.empty-state\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('room reconnection re-queries real recording status and zero counters stay hidden', () => {
  const roomUi = fs.readFileSync(path.join(publicDir, 'room-ui.js'), 'utf8');
  assert.match(roomUi, /onReconnected: \(\) => queryRecordingStatus\(\)/);
  assert.match(roomUi, /ui\.roomUi\.updateCount\(\)/);
  assert.match(roomUi, /element\.hidden = count < 1/);
  assert.doesNotMatch(roomUi, /setRecordingIndicator\(Boolean/);
});

test('media controls time out safely and block duplicate screen-share requests', () => {
  const roomUi = fs.readFileSync(path.join(publicDir, 'room-ui.js'), 'utf8');
  assert.match(roomUi, /function withMediaTimeout/);
  assert.match(roomUi, /setMicrophoneEnabled[\s\S]*withMediaTimeout|withMediaTimeout\(ui\.room\.localParticipant\.setMicrophoneEnabled/);
  assert.match(roomUi, /withMediaTimeout\(ui\.room\.localParticipant\.setCameraEnabled/);
  assert.match(roomUi, /if \(ui\.screenBusy\) return/);
  assert.match(roomUi, /withMediaTimeout\(ui\.room\.localParticipant\.setScreenShareEnabled/);
});

test('preflight stays visible until LiveKit connects and exposes a retry on failure', () => {
  const roomUi = fs.readFileSync(path.join(publicDir, 'room-ui.js'), 'utf8');
  assert.match(roomUi, /privacyConsent\.disabled = !viewer/);
  assert.match(roomUi, /privacyConsent\.required = false/);
  assert.match(roomUi, /await connectRoom\(\{ joinCamera, joinMicrophone \}\);[\s\S]*preflightDialog'\)\.close\(\)/);
  assert.match(roomUi, /button\.textContent = shouldRetry \? 'Reintentar conexión'/);
  assert.match(roomUi, /RATCore\.roomConnectionErrorMessage\(requestError\)/);
  assert.match(roomUi, /ui\.roomUi\?\.dispose\(\)/);
});

test('credential forms expose accessible password toggles and meeting fields use Spanish labels', () => {
  const login = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  const dashboard = fs.readFileSync(path.join(publicDir, 'dashboard.html'), 'utf8');
  assert.match(login, /data-password-toggle="password"/);
  assert.match(dashboard, /data-password-toggle="userPassword"/);
  assert.match(dashboard, /data-password-toggle="resetUserPassword"/);
  assert.match(dashboard, /id="userPasswordConfirm"/);
  assert.match(dashboard, /id="resetUserPasswordConfirm"/);
  assert.match(dashboard, /required-note[\s\S]*Campos obligatorios/);
  assert.match(dashboard, /Identificador de sala \(slug\)/);
  assert.match(dashboard, /value="WEBINAR">Webinar/);
  assert.match(dashboard, /value="INVITATION">Invitación/);
});

test('titles, visible branding and preflight structure have no legacy naming regressions', () => {
  const sources = fs.readdirSync(publicDir).filter((name) => /\.(?:html|js|webmanifest)$/.test(name)).map((name) => fs.readFileSync(path.join(publicDir, name), 'utf8')).join('\n');
  assert.doesNotMatch(sources, /Finance|Panel organizado(?!r)|Research Assessor/);
  assert.match(fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'), /<title>Iniciar sesión \| R\.A\. Training Streaming<\/title>/);
  assert.match(fs.readFileSync(path.join(publicDir, 'dashboard.html'), 'utf8'), /<title>Panel organizador \| R\.A\. Training Streaming<\/title>/);
  const room = fs.readFileSync(path.join(publicDir, 'presenter.html'), 'utf8');
  assert.match(room, /preflight-header/);
  assert.match(room, /preflight-scroll/);
  assert.match(room, /preflight-footer/);
  assert.match(room, /id="livekitStatus"/);
});
