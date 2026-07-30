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
  const assets = ['streaming-app-logo.png', 'streaming-app-logo-32.png', 'streaming-app-logo-180.png', 'streaming-app-logo-192.png', 'streaming-app-logo-512.png'];
  for (const asset of assets) assert.ok(fs.statSync(path.join(publicDir, 'assets', asset)).size > 0, asset);
  const references = {
    login: fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8'),
    dashboard: fs.readFileSync(path.join(publicDir, 'dashboard.html'), 'utf8'),
    room: fs.readFileSync(path.join(publicDir, 'presenter.html'), 'utf8'),
    floating: fs.readFileSync(path.join(publicDir, 'floating-bar.js'), 'utf8'),
    recordings: fs.readFileSync(path.join(publicDir, 'recordings.html'), 'utf8'),
  };
  for (const [surface, source] of Object.entries(references)) assert.match(source, /streaming-app-logo/, surface);
  assert.match(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'), /streaming-app-logo-512\.png/);
});

test('mobile login isolates the form and hidden controls cannot reappear through layout CSS', () => {
  const css = fs.readFileSync(path.join(publicDir, 'style.css'), 'utf8');
  assert.match(css, /\[hidden\]\s*\{\s*display:\s*none\s*!important/);
  assert.match(css, /@media \(max-width: 860px\)[\s\S]*?\.login-visual\s*\{\s*display:\s*none/);
  assert.match(css, /\.login-card\s*\{\s*width:\s*min\(520px, calc\(100% - 32px\)\)/);
  assert.match(css, /\.empty-state\s*\{[^}]*overflow-wrap:\s*anywhere/);
});

test('room reconnection re-queries real recording status and zero counters stay hidden', () => {
  const roomUi = fs.readFileSync(path.join(publicDir, 'room-ui.js'), 'utf8');
  assert.match(roomUi, /onReconnected: \(\) => queryRecordingStatus\(\)/);
  assert.match(roomUi, /element\.hidden = count < 1/);
  assert.doesNotMatch(roomUi, /setRecordingIndicator\(Boolean/);
});
