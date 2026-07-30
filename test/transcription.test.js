const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testDataDir = path.join(os.tmpdir(), `rat-transcription-tests-${process.pid}-${Date.now()}`);
process.env.NODE_ENV = 'test';
process.env.LOCAL_DATA_DIR = testDataDir;
process.env.SESSION_SECRET = 'transcription-test-session-secret-32-characters';
process.env.ADMIN_USERNAME = 'transcriptadmin';
process.env.ADMIN_PASSWORD = 'Transcript-password-123';
process.env.COOKIE_SECURE = 'false';
process.env.TRANSCRIPTION_ENABLED = 'true';
process.env.TRANSCRIPTION_PROVIDER = 'mock';

const auth = require('../server/auth');
const transcriptions = require('../server/transcriptions');
const audit = require('../server/audit');
const { MockTranscriptionProvider, createTranscriptionProvider } = require('../server/transcription-provider');
const { config } = require('../server/config');
const { createApp } = require('../server/app');

const completedMeeting = {
  id: 'meeting-transcript-unit', room: 'transcript-unit', title: 'Capacitación de seguridad', trainerName: 'Ana Pérez',
  scheduledAt: '2030-07-30T14:00:00.000Z', durationMinutes: 60, status: 'COMPLETED', allowTranscription: true,
  transcriptionLanguage: 'es', allowPanelistTranscriptAccess: false, createdBy: 'transcriptadmin',
};
const readyRecording = {
  id: 'recording-unit-ready', status: 'READY', available: true, url: 'https://audio.example.test/recording.mp4',
  participants: [{ identity: 'david-id', name: 'David Espinoza' }],
  tracks: [{ participantIdentity: 'david-id', participantName: 'David Espinoza', trackSid: 'TR_audio' }],
};
const successfulFixture = {
  language: 'es', durationSeconds: 150,
  segments: [
    { startMs: 22_000, endMs: 28_000, participantIdentity: null, text: 'Tengo una consulta\u0000 sobre el segundo punto.', confidence: 0.72 },
    { startMs: 2_000, endMs: 8_000, participantIdentity: 'david-id', participantName: 'Nombre incorrecto', text: 'Bienvenidos a la capacitación de hoy.', confidence: 0.98 },
  ],
};

test.before(async () => { await fs.rm(testDataDir, { recursive: true, force: true }); });
test.after(async () => { await fs.rm(testDataDir, { recursive: true, force: true }); });

test('provider configuration, recording readiness and complete transcript lifecycle are enforced', async () => {
  const disabled = new MockTranscriptionProvider({ configured: false });
  await assert.rejects(() => transcriptions.createTranscript({ meeting: completedMeeting, recording: readyRecording, requestedBy: 'admin', provider: disabled }), { code: 'TRANSCRIPTION_NOT_CONFIGURED' });

  const provider = new MockTranscriptionProvider({ configured: true, fixtures: { [readyRecording.id]: successfulFixture } });
  await assert.rejects(() => transcriptions.createTranscript({ meeting: completedMeeting, recording: null, requestedBy: 'admin', provider }), { code: 'RECORDING_NOT_READY' });
  await assert.rejects(() => transcriptions.createTranscript({ meeting: completedMeeting, recording: { id: 'processing', status: 'PROCESSING', url: 'https://audio.example.test/p.mp4' }, requestedBy: 'admin', provider }), { code: 'RECORDING_NOT_READY' });

  let record = await transcriptions.createTranscript({ meeting: completedMeeting, recording: readyRecording, requestedBy: 'admin', language: 'es', provider });
  assert.equal(record.status, 'QUEUED');
  assert.doesNotMatch(JSON.stringify(transcriptions.publicTranscript(record)), /providerJobId|apiKey|secret/i);
  for (let index = 0; index < 4; index += 1) record = await transcriptions.refreshTranscript(record, provider, readyRecording);
  assert.equal(record.status, 'COMPLETED');
  assert.equal(record.progress, 100);
  assert.deepEqual(record.segments.map((segment) => segment.startMs), [2_000, 22_000]);
  assert.equal(record.segments[0].participantName, 'David Espinoza');
  assert.equal(record.segments[1].participantName, 'Participante sin identificar 1');
  assert.doesNotMatch(record.segments[1].text, /\u0000/);
  assert.equal(record.speakers.length, 2);
  const trackLinked = transcriptions.sanitizeTranscriptResult({ segments: [{ startMs: 0, endMs: 1_000, trackSid: 'TR_audio', text: 'Voz enlazada por pista.' }] }, readyRecording);
  assert.equal(trackLinked.segments[0].participantIdentity, 'david-id');
  assert.equal(trackLinked.segments[0].participantName, 'David Espinoza');
  const diarized = transcriptions.sanitizeTranscriptResult({ segments: [
    { startMs: 0, endMs: 500, speaker: 'speaker-a', text: 'Primera intervención.' },
    { startMs: 600, endMs: 1_000, speaker: 'speaker-a', text: 'Segunda intervención.' },
  ] });
  assert.equal(diarized.segments[0].participantName, 'Participante sin identificar 1');
  assert.equal(diarized.segments[1].participantName, 'Participante sin identificar 1');

  const edited = await transcriptions.editTranscript(record, {
    revision: record.revision, editedBy: 'admin', language: 'es',
    segments: record.segments.map((segment, index) => index === 1 ? { ...segment, participantName: 'María López', text: 'Consulta corregida.' } : segment),
  });
  assert.equal(edited.revision, record.revision + 1);
  assert.equal(edited.segments[0].edited, false);
  assert.equal(edited.segments[1].participantName, 'María López');
  assert.equal(edited.segments[1].edited, true);
  await assert.rejects(() => transcriptions.editTranscript(edited, { revision: 1, editedBy: 'admin', segments: edited.segments }), { code: 'REVISION_CONFLICT' });

  const txt = transcriptions.exportTranscript(edited, 'txt');
  const json = transcriptions.exportTranscript(edited, 'json');
  const vtt = transcriptions.exportTranscript(edited, 'vtt');
  const srt = transcriptions.exportTranscript(edited, 'srt');
  assert.match(txt.body, /00:00:02\.000 — David Espinoza/);
  assert.equal(JSON.parse(json.body).segments.length, 2);
  assert.match(vtt.body, /^WEBVTT/);
  assert.match(vtt.body, /00:00:02\.000 --> 00:00:08\.000/);
  assert.match(srt.body, /^1\n00:00:02,000 --> 00:00:08,000/);
});

test('failed jobs can retry and active jobs can be cancelled without fake completion', async () => {
  const recording = { ...readyRecording, id: 'recording-unit-failure' };
  const provider = new MockTranscriptionProvider({ configured: true, fixtures: { [recording.id]: { failure: true } } });
  let record = await transcriptions.createTranscript({ meeting: { ...completedMeeting, id: 'meeting-failure' }, recording, requestedBy: 'admin', provider });
  record = await transcriptions.refreshTranscript(record, provider, recording);
  assert.equal(record.status, 'FAILED');
  assert.equal(record.progress, 0);
  assert.equal(record.segments.length, 0);
  provider.fixtures[recording.id] = successfulFixture;
  record = await transcriptions.retryTranscript(record, { meeting: completedMeeting, recording, requestedBy: 'admin', provider });
  assert.equal(record.status, 'QUEUED');
  record = await transcriptions.cancelTranscript(record, provider);
  assert.equal(record.status, 'CANCELLED');
  assert.equal(record.progress, 0);
});

test('an unknown configured provider fails closed instead of enabling the mock', () => {
  const previousProvider = config.transcriptionProvider;
  const previousEnabled = config.transcriptionEnabled;
  try {
    config.transcriptionProvider = 'unexpected-provider';
    config.transcriptionEnabled = true;
    assert.equal(createTranscriptionProvider().isConfigured(), false);
  } finally {
    config.transcriptionProvider = previousProvider;
    config.transcriptionEnabled = previousEnabled;
  }
});

test('secure transcription endpoints enforce roles, recording association, progress, edit, export and audit', async (context) => {
  const provider = new MockTranscriptionProvider({ configured: true, fixtures: { 'recording-api-ready': successfulFixture, 'recording-api-cancel': successfulFixture } });
  const recordingResolver = async (id, meeting) => {
    if (id === 'recording-missing') return null;
    if (id === 'recording-api-processing') return { id, meetingId: meeting.id, status: 'PROCESSING', available: false };
    return { id, meetingId: meeting.id, room: meeting.room, status: 'READY', available: true, url: `https://audio.example.test/${id}.mp4`, participants: readyRecording.participants, tracks: readyRecording.tracks };
  };
  const roomService = { async listParticipants() { return []; }, async deleteRoom() {}, async sendData() {} };
  const egressClient = { async listEgress() { return []; } };
  const app = createApp({ services: { roomService, egressClient, transcriptionProvider: provider }, recordingResolver });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  context.after(() => new Promise((resolve) => server.close(resolve)));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;

  async function request(route, { method = 'GET', body, cookie, csrf } = {}) {
    const headers = {}; if (body !== undefined) headers['Content-Type'] = 'application/json'; if (cookie) headers.Cookie = cookie; if (csrf) headers['X-CSRF-Token'] = csrf;
    const response = await fetch(`${baseUrl}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const type = response.headers.get('content-type') || ''; const data = type.includes('json') ? await response.json() : await response.text();
    return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function login(username, password) {
    const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
    assert.equal(result.response.status, 200, JSON.stringify(result.data)); return { cookie: result.cookie, csrf: result.data.csrfToken };
  }

  const admin = await login('transcriptadmin', 'Transcript-password-123');
  const created = await request('/api/meetings', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {
    title: 'API de transcripción', room: 'api-transcript', trainerName: 'Ana Pérez', scheduledAt: '2034-07-30T15:00:00.000Z',
    durationMinutes: 60, type: 'WEBINAR', status: 'COMPLETED', capacity: 100, allowTranscription: true, transcriptionLanguage: 'es',
    trainerId: 'transcriptpanelist', allowPanelistTranscriptAccess: true,
  } });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const meeting = created.data;

  const missing = await request(`/api/meetings/${meeting.id}/transcriptions`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { recordingId: 'recording-missing' } });
  assert.equal(missing.response.status, 409);
  const processing = await request(`/api/meetings/${meeting.id}/transcriptions`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { recordingId: 'recording-api-processing' } });
  assert.equal(processing.response.status, 409);
  provider.configured = false;
  const disabled = await request(`/api/meetings/${meeting.id}/transcriptions`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { recordingId: 'recording-api-ready' } });
  assert.equal(disabled.response.status, 503);
  provider.configured = true;

  const createUser = await request('/api/auth/users', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { username: 'transcriptviewer', password: 'Viewer-password-123', role: 'VIEWER', active: true } });
  assert.equal(createUser.response.status, 201);
  const viewer = await login('transcriptviewer', 'Viewer-password-123');
  const denied = await request(`/api/meetings/${meeting.id}/transcriptions`, { cookie: viewer.cookie });
  assert.equal(denied.response.status, 403);

  for (const username of ['transcriptpanelist', 'otherpanelist']) {
    const result = await request('/api/auth/users', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { username, password: 'Panelist-password-123', role: 'PANELIST', active: true } });
    assert.equal(result.response.status, 201);
  }
  const assignedPanelist = await login('transcriptpanelist', 'Panelist-password-123');
  const otherPanelist = await login('otherpanelist', 'Panelist-password-123');
  const assignedList = await request(`/api/meetings/${meeting.id}/transcriptions`, { cookie: assignedPanelist.cookie });
  const otherList = await request(`/api/meetings/${meeting.id}/transcriptions`, { cookie: otherPanelist.cookie });
  assert.equal(assignedList.response.status, 200);
  assert.equal(otherList.response.status, 403);

  const createdTranscript = await request(`/api/meetings/${meeting.id}/transcriptions`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { recordingId: 'recording-api-ready', language: 'es' } });
  assert.equal(createdTranscript.response.status, 201, JSON.stringify(createdTranscript.data));
  const transcriptId = createdTranscript.data.transcript.id;
  assert.doesNotMatch(JSON.stringify(createdTranscript.data), /providerJobId|TRANSCRIPTION_API_KEY|secret/i);
  const deleteActive = await request(`/api/transcriptions/${transcriptId}`, { method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf });
  assert.equal(deleteActive.response.status, 409);

  let detail;
  for (let index = 0; index < 4; index += 1) detail = await request(`/api/transcriptions/${transcriptId}`, { cookie: admin.cookie });
  assert.equal(detail.data.transcript.status, 'COMPLETED');
  assert.deepEqual(detail.data.transcript.segments.map((segment) => segment.startMs), [2_000, 22_000]);
  const panelistDetail = await request(`/api/transcriptions/${transcriptId}`, { cookie: assignedPanelist.cookie });
  assert.equal(panelistDetail.response.status, 200);
  const panelistEdit = await request(`/api/transcriptions/${transcriptId}`, { method: 'PATCH', cookie: assignedPanelist.cookie, csrf: assignedPanelist.csrf, body: { revision: detail.data.transcript.revision, segments: detail.data.transcript.segments } });
  assert.equal(panelistEdit.response.status, 403);

  const changedSegments = detail.data.transcript.segments.map((segment, index) => index === 0 ? { ...segment, text: 'Texto editado desde la API.' } : segment);
  const edited = await request(`/api/transcriptions/${transcriptId}`, { method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { revision: detail.data.transcript.revision, language: 'es', segments: changedSegments } });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.transcript.segments[0].text, 'Texto editado desde la API.');

  for (const format of ['txt', 'json', 'vtt', 'srt']) {
    const exported = await request(`/api/transcriptions/${transcriptId}/export?format=${format}`, { cookie: admin.cookie });
    assert.equal(exported.response.status, 200, `${format}: ${exported.data}`);
    assert.match(exported.response.headers.get('content-disposition'), new RegExp(`\\.${format}\\"$`));
  }
  const events = await audit.listEvents({ limit: 200 });
  assert.ok(events.some((event) => event.action === 'TRANSCRIPTION_CREATED' && event.target === transcriptId));
  assert.ok(events.some((event) => event.action === 'TRANSCRIPTION_EDITED' && event.target === transcriptId));
});
