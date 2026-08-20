const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const { migrate } = require('../server/db/migrate');
const db = require('../server/db');
const auth = require('../server/auth');
const meetings = require('../server/meetings');
const trainingSeries = require('../server/training-series');
const invitations = require('../server/invitations');
const seriesAccesses = require('../server/series-accesses');
const rooms = require('../server/rooms');
const attendance = require('../server/attendance');
const questions = require('../server/questions');
const audit = require('../server/audit');
const transcriptions = require('../server/transcriptions');
const postgresStore = require('../server/db/postgres-store');
const liveKitWebhooks = require('../server/livekit-webhooks');
const backgroundJobs = require('../server/background-jobs');

const runId = `pg-${crypto.randomUUID().slice(0, 8)}`;

if (!process.env.DATABASE_URL) {
  test('PostgreSQL integration tests require TEST_DATABASE_URL', { skip: 'no PostgreSQL test connection available' }, () => {});
} else {
test.before(async () => {
  await migrate({ quiet: true });
});

test.after(async () => {
  await db.closePool();
});

test('fresh migrations are idempotent and core constraints exist', async () => {
  await migrate({ quiet: true });
  await migrate({ quiet: true });
  const duplicate = await auth.createUser({ username: `${runId}-user`, password: 'Postgres-password-123', role: 'ADMIN' });
  assert.equal(duplicate.username, `${runId}-user`);
  await assert.rejects(
    () => auth.createUser({ username: `${runId}-user`, password: 'Postgres-password-123', role: 'ADMIN' }),
    /usuario ya existe/i
  );
});

test('users preserve role invalidation semantics', async () => {
  const username = `${runId}-organizer`;
  await auth.createUser({ username, password: 'Postgres-password-123', role: 'ORGANIZER' });
  const before = await auth.getUser(username);
  const updated = await auth.updateUser(username, { role: 'ADMIN' });
  assert.equal(updated.role, 'ADMIN');
  assert.equal((await auth.getUser(username)).sessionVersion, before.sessionVersion + 1);
  await auth.updateUser(username, { active: false });
  assert.equal((await auth.getUser(username)).active, false);
});

test('meetings lifecycle keeps PATCH status blocked and actions authoritative', async () => {
  const room = `${runId}-meeting`;
  const meeting = await meetings.createMeeting({
    title: 'Postgres Meeting', room, trainerName: 'Trainer', scheduledAt: '2035-01-01T10:00:00.000Z',
    durationMinutes: 60, status: 'SCHEDULED', createdBy: runId,
  });
  assert.equal(meeting.room, room);
  await assert.rejects(() => meetings.updateMeeting(room, { status: 'COMPLETED' }), /lifecycle|estado/i);
  assert.equal((await meetings.updateMeeting(room, { title: 'Postgres Meeting Updated' })).title, 'Postgres Meeting Updated');
  assert.equal((await meetings.transitionMeeting(room, 'complete')).status, 'COMPLETED');
  await assert.rejects(() => meetings.createMeeting({ title: 'Dup', room, trainerName: 'Trainer', scheduledAt: '2035-01-01T10:00:00.000Z', durationMinutes: 60, createdBy: runId }), /Ya existe/);
});

test('training series writes through one transaction', async () => {
  const created = await trainingSeries.createSeries({
    title: `${runId} Series`, description: 'TX', trainerName: 'Trainer', type: 'WEBINAR', timezone: 'America/Guayaquil',
    sessions: [
      { scheduledAt: '2035-02-01T10:00:00.000Z', durationMinutes: 60 },
      { scheduledAt: '2035-02-02T10:00:00.000Z', durationMinutes: 60 },
    ],
    createdBy: runId,
  });
  assert.equal(created.sessions.length, 2);
  assert.equal((await trainingSeries.seriesSessions(created.series.id)).length, 2);

  const rollbackId = `${runId}-rollback`;
  await assert.rejects(() => db.transaction(async (client) => {
    await postgresStore.writeJson('training-series', rollbackId, { id: rollbackId, title: 'Rollback', status: 'ACTIVE' }, client);
    throw new Error('forced rollback');
  }), /forced rollback/);
  assert.equal(await postgresStore.readJson('training-series', rollbackId), undefined);
});

test('invitations consume atomically and respect revoked or expired states', async () => {
  const meeting = await meetings.createMeeting({ title: `${runId} Invite`, room: `${runId}-invite`, trainerName: 'Trainer', scheduledAt: '2035-03-01T10:00:00.000Z', durationMinutes: 60, createdBy: runId });
  const { token, invitation } = await invitations.createInvitation({ meetingId: meeting.id, room: meeting.room, role: 'VIEWER', singleUse: true, createdBy: runId });
  const results = await Promise.allSettled([invitations.consumeInvitation(token), invitations.consumeInvitation(token)]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal((await postgresStore.readJson('invitations', invitation.id))?.uses, undefined);
  const stored = (await invitations.listInvitations({ room: meeting.room })).find((item) => item.id === invitation.id);
  assert.equal(stored.uses, 1);

  const revoked = await invitations.createInvitation({ meetingId: meeting.id, room: meeting.room, role: 'VIEWER', createdBy: runId });
  await invitations.revokeInvitation(revoked.invitation.id, meeting.room);
  await assert.rejects(() => invitations.consumeInvitation(revoked.token), /revocada/);
});

test('series accesses use uniqueness and usage count survives touch', async () => {
  const series = await trainingSeries.createSeries({
    title: `${runId} Access`, trainerName: 'Trainer', type: 'WEBINAR', timezone: 'America/Guayaquil',
    sessions: [{ scheduledAt: '2035-04-01T10:00:00.000Z', durationMinutes: 60 }],
    createdBy: runId,
  });
  const general = await Promise.all([
    seriesAccesses.createOrGetGeneralAccess({ series: series.series, createdBy: runId }),
    seriesAccesses.createOrGetGeneralAccess({ series: series.series, createdBy: runId }),
  ]);
  assert.equal(general[0].access.id, general[1].access.id);
  const touched = await seriesAccesses.resolveToken(general[0].token, { touch: true });
  assert.equal(touched.usageCount, 1);
});

test('audit events list by their real timestamp column', async () => {
  const room = `${runId}-audit-order`;
  await postgresStore.writeJson('audit', `${runId}-audit-old`, {
    id: `${runId}-audit-old`,
    timestamp: '2035-04-02T10:00:00.000Z',
    actor: runId,
    action: 'MEETING_CREATED',
    target: `${runId}-target-old`,
    room,
    metadata: { order: 1 },
  });
  await postgresStore.writeJson('audit', `${runId}-audit-new`, {
    id: `${runId}-audit-new`,
    timestamp: '2035-04-02T10:01:00.000Z',
    actor: runId,
    action: 'MEETING_UPDATED',
    target: `${runId}-target-new`,
    room,
    metadata: { order: 2 },
  });

  const events = await audit.listEvents({ room, limit: 10 });
  assert.equal(events.length, 2);
  assert.equal(events[0].id, `${runId}-audit-new`);
  assert.equal(events[1].id, `${runId}-audit-old`);
});

test('LiveKit webhook deduplication and attendance effects are durable in PostgreSQL', async () => {
  const created = await trainingSeries.createSeries({
    title: `${runId} Webhook`, trainerName: 'Trainer', type: 'WEBINAR', timezone: 'America/Guayaquil',
    sessions: [{ scheduledAt: '2035-04-03T10:00:00.000Z', durationMinutes: 60 }],
    createdBy: runId,
  });
  const meeting = created.sessions[0];
  const participantKey = `${runId}-webhook-participant`;
  const body = JSON.stringify({
    id: `${runId}-webhook-join`,
    event: 'participant_joined',
    createdAt: Math.floor(new Date('2035-04-03T10:00:00.000Z').getTime() / 1000),
    room: { sid: `${runId}-room-sid`, name: meeting.room },
    participant: {
      sid: `${runId}-participant-sid`,
      identity: `${runId}-identity`,
      name: 'Webhook Participant',
      metadata: JSON.stringify({ participantKey }),
    },
  });
  const first = await liveKitWebhooks.receiveLiveKitWebhook(body, null, { skipAuth: true });
  const second = await liveKitWebhooks.receiveLiveKitWebhook(body, null, { skipAuth: true });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  const stored = await db.query('SELECT status FROM livekit_webhook_events WHERE event_id = $1', [`${runId}-webhook-join`]);
  assert.equal(stored.rows[0].status, 'PROCESSED');
  const record = await attendance.getRecord({ seriesId: created.series.id, meetingId: meeting.id, participantKey });
  assert.equal(record.joinCount, 1);
  assert.equal(record.activeSince, '2035-04-03T10:00:00.000Z');
});

test('background jobs use PostgreSQL dedupe, SKIP LOCKED claims, heartbeat and lease recovery', async () => {
  const first = await backgroundJobs.enqueue({ type: 'PG_TEST_JOB', dedupeKey: `${runId}:job`, payload: { safeId: runId }, maxAttempts: 3 });
  const second = await backgroundJobs.enqueue({ type: 'PG_TEST_JOB', dedupeKey: `${runId}:job`, payload: { safeId: runId }, maxAttempts: 3 });
  assert.equal(first.job.id, second.job.id);

  const claimed = await backgroundJobs.claimNext({ worker: `${runId}-worker-a`, leaseMs: 5_000 });
  assert.equal(claimed.id, first.job.id);
  assert.equal(await backgroundJobs.claimNext({ worker: `${runId}-worker-b`, leaseMs: 5_000 }), null);

  assert.equal(await backgroundJobs.heartbeat(claimed.id, `${runId}-worker-a`, { leaseMs: 5_000 }), true);
  await db.query("UPDATE background_jobs SET lease_expires_at = now() - interval '1 second' WHERE id = $1", [claimed.id]);
  const recovered = await backgroundJobs.claimNext({ worker: `${runId}-worker-b`, leaseMs: 5_000 });
  assert.equal(recovered.id, claimed.id);
  assert.equal(recovered.attempts, 2);
  assert.equal(await backgroundJobs.complete(recovered.id, `${runId}-worker-b`), true);
  assert.equal((await backgroundJobs.getJob(recovered.id)).status, 'SUCCEEDED');
});

test('rooms, attendance, questions, audit and transcriptions round-trip structured state', async () => {
  const meeting = await meetings.createMeeting({ title: `${runId} State`, room: `${runId}-state`, trainerName: 'Trainer', scheduledAt: '2035-05-01T10:00:00.000Z', durationMinutes: 60, status: 'COMPLETED', allowTranscription: true, createdBy: runId });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  await rooms.setMediaGrant(meeting.room, `${runId}-a`, 'camera', true, runId);
  await rooms.setMediaGrant(meeting.room, `${runId}-b`, 'microphone', true, runId);
  assert.equal((await rooms.participantAccess(meeting.room, `${runId}-a`)).grants.camera, true);
  assert.equal((await rooms.participantAccess(meeting.room, `${runId}-b`)).grants.microphone, true);
  await rooms.setParticipantRole(meeting.room, `${runId}-a`, 'ATTENDEE', runId);
  assert.deepEqual((await rooms.participantAccess(meeting.room, `${runId}-a`)).grants, {});

  const attendanceSeriesId = `${runId}-series-id`;
  await postgresStore.writeJson('training-series', attendanceSeriesId, { id: attendanceSeriesId, title: 'Attendance Series', status: 'ACTIVE', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  await attendance.joined({ seriesId: attendanceSeriesId, meetingId: meeting.id, sessionNumber: 1, participantKey: `${runId}-p`, participantIdentity: 'p1', participantName: 'P One' });
  await attendance.left({ seriesId: attendanceSeriesId, meetingId: meeting.id, participantKey: `${runId}-p` });
  assert.equal((await attendance.listSeriesAttendance(attendanceSeriesId)).length, 1);

  const question = await questions.create({ room: meeting.room, meetingId: meeting.id, text: '¿Pregunta segura?', authorIdentity: 'p1', authorName: 'P One', authorRole: 'VIEWER' });
  await questions.toggleVote(meeting.room, question.id, 'p2');
  await questions.toggleVote(meeting.room, question.id, 'p2');
  assert.equal((await questions.get(meeting.room, question.id)).voters.length, 0);

  await audit.logEvent({ actor: runId, action: 'MEETING_CREATED', target: meeting.id, room: meeting.room, metadata: { ok: true } });
  assert.equal((await audit.listEvents({ room: meeting.room })).length >= 1, true);

  const provider = {
    providerName: 'test',
    isConfigured: () => true,
    createJob: async () => ({ status: 'PROCESSING', providerJobId: `${runId}-job`, progress: 10 }),
    getJobStatus: async () => ({ status: 'COMPLETED', progress: 100 }),
    getTranscript: async () => ({
      segments: [{ startMs: 0, endMs: 1000, text: 'Hola', speakerId: 's1' }],
      speakers: [{ speakerId: 's1', speakerLabel: 'Hablante 1' }],
      words: [],
      warnings: [],
      text: 'Hola',
    }),
    transcribe: async () => ({
      providerJobId: `${runId}-job`,
      status: 'COMPLETED',
      segments: [{ startMs: 0, endMs: 1000, text: 'Hola', speakerId: 's1' }],
      speakers: [{ speakerId: 's1', speakerLabel: 'Hablante 1' }],
      words: [],
      warnings: [],
      text: 'Hola',
    }),
  };
  const recording = { id: `${runId}-recording`, status: 'READY', available: true, durationSeconds: 60, size: 1024 };
  const transcript = await transcriptions.createTranscript({ meeting, recording, requestedBy: runId, language: 'es', provider });
  await transcriptions.processTranscriptionJob({
    transcriptionId: transcript.id,
    provider,
    meetings,
    recordingResolver: async () => recording,
  });
  assert.equal((await transcriptions.getTranscript(transcript.id)).segments[0].text, 'Hola');
});
}
