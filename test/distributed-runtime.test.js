const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { AccessToken } = require('livekit-server-sdk');

const { config, validateRuntimeConfig } = require('../server/config');
const { createApp } = require('../server/app');
const liveKitWebhooks = require('../server/livekit-webhooks');
const trainingSeries = require('../server/training-series');
const attendance = require('../server/attendance');
const idempotency = require('../server/idempotency');

async function signWebhook(body) {
  const token = new AccessToken(config.livekitApiKey, config.livekitApiSecret);
  token.sha256 = crypto.createHash('sha256').update(body).digest('base64');
  return token.toJwt();
}

function webhookBody({ id, event, room, identity = 'viewer-1', participantKey = 'participant-1', at }) {
  const createdAt = Math.floor(new Date(at).getTime() / 1000);
  return JSON.stringify({
    id,
    event,
    createdAt,
    room: { sid: `RM_${room}`, name: room },
    participant: {
      sid: `PA_${identity}`,
      identity,
      name: 'Persona Uno',
      metadata: JSON.stringify({ participantKey, seriesId: 'series-test', meetingId: 'meeting-test' }),
    },
  });
}

async function receive(body) {
  return liveKitWebhooks.receiveLiveKitWebhook(body, await signWebhook(body));
}

test.beforeEach(() => {
  liveKitWebhooks.resetMemoryForTest();
  idempotency.resetMemory();
});

test('LiveKit webhook signatures are required and valid signed payloads are accepted', async () => {
  const body = JSON.stringify({ id: `wh-${crypto.randomUUID()}`, event: 'room_started', room: { sid: 'RM_unknown', name: 'unknown-room' }, createdAt: 2051268000 });
  await assert.rejects(() => liveKitWebhooks.receiveLiveKitWebhook(body, 'invalid'), /Firma LiveKit inválida/);
  assert.deepEqual(await receive(body), { duplicate: false, effects: { ignored: true } });
  assert.equal((await receive(body)).duplicate, true);
});

test('LiveKit webhook endpoint uses raw body validation and bypasses CSRF', async () => {
  const app = createApp({
    services: {
      roomService: { listParticipants: async () => [], sendData: async () => {} },
      egressClient: { listEgress: async () => [] },
      transcriptionProvider: { isConfigured: () => false },
    },
    livekitProbe: async () => ({ configured: true, available: true, mode: 'mock' }),
    storageProbe: async () => ({ configured: false, available: false, mode: 'disabled' }),
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const body = JSON.stringify({ id: `endpoint-${crypto.randomUUID()}`, event: 'room_started', room: { sid: 'RM_endpoint', name: 'endpoint-unknown' }, createdAt: 2051268000 });
    const accepted = await fetch(`${baseUrl}/api/webhooks/livekit`, {
      method: 'POST',
      headers: { Authorization: await signWebhook(body), 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(accepted.status, 200);
    const rejected = await fetch(`${baseUrl}/api/webhooks/livekit`, {
      method: 'POST',
      headers: { Authorization: 'invalid', 'Content-Type': 'application/json' },
      body,
    });
    assert.equal(rejected.status, 401);
  } finally {
    server.close();
  }
});

test('LiveKit participant events drive attendance idempotently and ignore stale ordering', async () => {
  const run = `lk-${crypto.randomUUID().slice(0, 8)}`;
  const created = await trainingSeries.createSeries({
    title: `${run} series`,
    trainerName: 'Trainer',
    type: 'WEBINAR',
    timezone: 'America/Guayaquil',
    sessions: [{ scheduledAt: '2035-06-01T10:00:00.000Z', durationMinutes: 60 }],
    createdBy: run,
  });
  const meeting = created.sessions[0];
  const participantKey = `${run}-participant`;
  await attendance.resetForTest({ seriesId: created.series.id, meetingId: meeting.id, participantKey });

  const join = webhookBody({ id: `${run}-join-1`, event: 'participant_joined', room: meeting.room, participantKey, at: '2035-06-01T10:00:00.000Z' });
  await receive(join);
  await receive(join);
  let record = await attendance.getRecord({ seriesId: created.series.id, meetingId: meeting.id, participantKey });
  assert.equal(record.joinCount, 1);
  assert.equal(record.activeSince, '2035-06-01T10:00:00.000Z');

  await attendance.left({ seriesId: created.series.id, meetingId: meeting.id, participantKey, eventAt: '2035-06-01T10:01:00.000Z' });
  const webhookLeave = webhookBody({ id: `${run}-leave-1`, event: 'participant_left', room: meeting.room, participantKey, at: '2035-06-01T10:01:00.000Z' });
  await receive(webhookLeave);
  await receive(webhookLeave);
  record = await attendance.getRecord({ seriesId: created.series.id, meetingId: meeting.id, participantKey });
  assert.equal(record.activeSince, null);
  assert.equal(record.accumulatedMs, 60_000);

  const oldJoin = webhookBody({ id: `${run}-join-old`, event: 'participant_joined', room: meeting.room, participantKey, at: '2035-06-01T10:00:30.000Z' });
  await receive(oldJoin);
  record = await attendance.getRecord({ seriesId: created.series.id, meetingId: meeting.id, participantKey });
  assert.equal(record.activeSince, null);
  assert.equal(record.joinCount, 1);

  await receive(webhookBody({ id: `${run}-join-2`, event: 'participant_joined', room: meeting.room, participantKey, at: '2035-06-01T10:03:00.000Z' }));
  await receive(webhookBody({ id: `${run}-leave-2`, event: 'participant_left', room: meeting.room, participantKey, at: '2035-06-01T10:05:00.000Z' }));
  record = await attendance.getRecord({ seriesId: created.series.id, meetingId: meeting.id, participantKey });
  assert.equal(record.joinCount, 2);
  assert.equal(record.activeSince, null);
  assert.equal(record.accumulatedMs, 180_000);
});

test('idempotency memory fallback replays same response and rejects changed payloads', async () => {
  const req = { method: 'POST', path: '/test', route: { path: '/test' }, body: { a: 1 }, headers: { 'idempotency-key': 'idem-key-123' }, ip: '127.0.0.1', auth: { u: 'actor' } };
  let executions = 0;
  const first = await idempotency.runHttp(req, 'test-action', async () => {
    executions += 1;
    return { status: 201, body: { ok: true } };
  });
  const second = await idempotency.runHttp(req, 'test-action', async () => {
    executions += 1;
    return { status: 201, body: { ok: false } };
  });
  assert.equal(executions, 1);
  assert.deepEqual(second, first);
  await assert.rejects(
    () => idempotency.runHttp({ ...req, body: { a: 2 } }, 'test-action', async () => ({ status: 201, body: {} })),
    /payload diferente/
  );
});

test('distributed production runtime requires Redis configuration', () => {
  const errors = validateRuntimeConfig({
    ...config,
    appEnv: 'preview',
    isProductionLike: true,
    redisUrlConfigured: false,
    dataBackend: 'postgres',
    databaseUrlConfigured: true,
    nodeEnv: 'production',
    appPublicUrl: 'https://preview.example',
    cookieSecure: true,
    sessionSecret: 's'.repeat(40),
    invitationHashSecret: 'i'.repeat(40),
    livekitWsUrl: 'wss://livekit.example',
    livekitApiKey: 'key',
    livekitApiSecret: 'secret',
    previewIsolationAcknowledged: true,
    storageConfigured: true,
    transcriptionEnabled: true,
    transcriptionProvider: 'deepgram',
    transcriptionApiKeyConfigured: true,
    transcriptionApiUrl: 'https://api.deepgram.com/v1/listen',
    transcriptionAllowedHosts: new Set(['api.deepgram.com']),
  });
  assert.ok(errors.some((message) => message.includes('REDIS_URL is required for distributed runtime')));
});
