const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testDataDir = path.join(os.tmpdir(), `rat-streaming-tests-${process.pid}-${Date.now()}`);
process.env.NODE_ENV = 'test';
process.env.LOCAL_DATA_DIR = testDataDir;
process.env.SESSION_SECRET = 'test-session-secret-with-more-than-32-characters';
process.env.ADMIN_USERNAME = 'rootadmin';
process.env.ADMIN_PASSWORD = 'Bootstrap-password-123';
process.env.COOKIE_SECURE = 'false';
process.env.ALLOW_OPEN_DEV_ROOMS = 'false';
process.env.LOGIN_RATE_LIMIT_MAX = '8';
process.env.LOGIN_RATE_LIMIT_WINDOW = '60';
process.env.CHAT_RATE_LIMIT_MAX = '2';

const auth = require('../server/auth');
const meetings = require('../server/meetings');
const invitations = require('../server/invitations');
const rooms = require('../server/rooms');
const localStore = require('../server/local-store');
const audit = require('../server/audit');
const questions = require('../server/questions');
const { assertValidFileContent, hasValidMagicBytes } = require('../server/file-validation');
const { createRoomSession, roomCookie } = require('../server/room-session');
const { createApp } = require('../server/app');
const externalSessions = require('../server/external-sessions');

const mockRoomService = {
  participants: [],
  sentData: [],
  updates: [],
  deletedRooms: [],
  async listParticipants() { return this.participants; },
  async updateParticipant(room, identity, update) {
    this.updates.push({ room, identity, update });
    const participant = this.participants.find((item) => item.identity === identity);
    if (participant && update.permission) {
      participant.permission = { ...(participant.permission || {}), ...update.permission };
      participant.permissions = participant.permission;
    }
  },
  async removeParticipant() {},
  async mutePublishedTrack() {},
  async deleteRoom(room) { this.deletedRooms.push(room); },
  async sendData(room, data, kind, options) { this.sentData.push({ room, data: JSON.parse(Buffer.from(data).toString('utf8')), kind, options }); },
};
const mockEgressClient = {
  items: [],
  starts: [],
  stops: [],
  failStart: null,
  failStop: null,
  reset() { this.items = []; this.starts = []; this.stops = []; this.failStart = null; this.failStop = null; },
  async listEgress({ roomName, active } = {}) {
    const activeStatuses = new Set(['EGRESS_STARTING', 'EGRESS_ACTIVE', 'EGRESS_ENDING']);
    return this.items.filter((item) => (!roomName || item.roomName === roomName) && (active !== true || activeStatuses.has(item.status)));
  },
  async stopEgress(egressId) {
    this.stops.push(egressId);
    if (this.failStop) throw this.failStop;
    const item = this.items.find((candidate) => candidate.egressId === egressId);
    if (!item) throw new Error('egress not found');
    item.status = 'EGRESS_COMPLETE';
    return { ...item };
  },
  async startRoomCompositeEgress(roomName, output, options) {
    this.starts.push({ roomName, output: structuredClone(output), options: structuredClone(options) });
    if (this.failStart) throw this.failStart;
    const info = {
      egressId: `egress-test-${this.starts.length}`,
      roomName,
      status: 'EGRESS_ACTIVE',
      streamResults: [{}],
      request: { value: { streamOutputs: structuredClone([output]) } },
    };
    this.items.push(info);
    return { ...info };
  },
};
let mockLivekitAvailable = true;

let server;
let baseUrl;
let app;

async function request(route, { method = 'GET', body, cookie, csrf, roomCsrf, seriesCsrf, roomSessionId, redirect = 'follow' } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (roomCsrf) headers['X-Room-CSRF'] = roomCsrf;
  if (seriesCsrf) headers['X-Series-CSRF'] = seriesCsrf;
  if (roomSessionId) headers['X-Room-Session-ID'] = roomSessionId;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect,
  });
  let data = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) data = await response.json();
  const setCookieHeaders = typeof response.headers.getSetCookie === 'function'
    ? response.headers.getSetCookie()
    : [response.headers.get('set-cookie')].filter(Boolean);
  const cookies = setCookieHeaders.map((value) => value.split(';')[0]);
  return { response, data, cookies, cookie: cookies[0] || null };
}

async function login(username = 'rootadmin', password = 'Bootstrap-password-123') {
  const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return { cookie: result.cookie, csrf: result.data.csrfToken, user: result.data.user };
}

test.before(async () => {
  await fs.rm(testDataDir, { recursive: true, force: true });
  app = createApp({
    services: { roomService: mockRoomService, egressClient: mockEgressClient },
    livekitProbe: async () => ({ configured: true, available: mockLivekitAvailable, state: mockLivekitAvailable ? 'AVAILABLE' : 'UNAVAILABLE', mode: 'local', checkedAt: new Date().toISOString(), errorCode: mockLivekitAvailable ? undefined : 'LIVEKIT_UNREACHABLE' }),
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(testDataDir, { recursive: true, force: true });
});

test.afterEach(() => {
  app?.locals?.rateLimiters?.loginLimiter?.reset?.();
});

test('scrypt hashes passwords with unique salts and verifies safely', () => {
  const first = auth.hashPassword('A-secure-password-123');
  const second = auth.hashPassword('A-secure-password-123');
  assert.notEqual(first, second);
  assert.equal(auth.verifyPassword('A-secure-password-123', first), true);
  assert.equal(auth.verifyPassword('wrong-password', first), false);
});

test('signed sessions expire logically and are invalidated by session version', async () => {
  const user = await auth.createUser({ username: 'session-user', password: 'Session-password-123', role: 'ORGANIZER' });
  const token = auth.signSession(user);
  assert.equal((await auth.verifySession(token)).u, 'session-user');
  await auth.revokeSessions('session-user');
  assert.equal(await auth.verifySession(token), null);
});

test('inactive users cannot authenticate', async () => {
  await auth.createUser({ username: 'inactive-user', password: 'Inactive-password-123', role: 'VIEWER', active: false });
  assert.equal(await auth.authenticate('inactive-user', 'Inactive-password-123'), null);
});

test('login rate limiting returns 429 without leaking credential details', async () => {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const result = await request('/api/auth/login', { method: 'POST', body: { username: 'rate-user', password: 'wrong' } });
    assert.equal(result.response.status, 401);
  }
  const limited = await request('/api/auth/login', { method: 'POST', body: { username: 'rate-user', password: 'wrong' } });
  assert.equal(limited.response.status, 429);
  assert.equal(limited.data.code, 'RATE_LIMITED');
});

test('login sets an HttpOnly SameSite cookie instead of returning a bearer token', async () => {
  const result = await request('/api/auth/login', { method: 'POST', body: { username: 'rootadmin', password: 'Bootstrap-password-123' } });
  assert.equal(result.response.status, 200);
  const cookieHeader = result.response.headers.get('set-cookie');
  assert.match(cookieHeader, /HttpOnly/i);
  assert.match(cookieHeader, /SameSite=Lax/i);
  assert.equal(result.data.token, undefined);
});

test('/docs remains intentionally available in local test environment', async () => {
  const docs = await request('/docs/LOCAL_DEVELOPMENT.md');
  assert.equal(docs.response.status, 200);
  assert.match(docs.response.headers.get('content-type') || '', /text\/markdown|text\/plain|application\/octet-stream/i);
});

test('ADMIN can manage users, roles and password resets without exposing hashes', async () => {
  const admin = await login();
  const created = await request('/api/auth/users', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { username: 'organizer-one', password: 'Organizer-password-123', role: 'ORGANIZER' },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.user.role, 'ORGANIZER');
  assert.equal('passwordHash' in created.data.user, false);

  const updated = await request('/api/auth/users/organizer-one', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { active: false, role: 'VIEWER' },
  });
  assert.equal(updated.response.status, 200);
  assert.equal(updated.data.user.active, false);

  const reset = await request('/api/auth/users/organizer-one/password', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { password: 'A-new-password-456' },
  });
  assert.equal(reset.response.status, 200);
});

test('role and active changes invalidate existing auth sessions safely', async () => {
  const admin = await login();
  await request('/api/auth/users', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { username: 'role-admin-old', password: 'Role-admin-password-123', role: 'ADMIN' },
  });
  const oldAdmin = await login('role-admin-old', 'Role-admin-password-123');
  assert.equal((await request('/api/auth/users', { cookie: oldAdmin.cookie })).response.status, 200);
  const demoted = await request('/api/auth/users/role-admin-old', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { role: 'ORGANIZER' },
  });
  assert.equal(demoted.response.status, 200, JSON.stringify(demoted.data));
  assert.equal(demoted.data.user.role, 'ORGANIZER');
  assert.equal((await request('/api/auth/users', { cookie: oldAdmin.cookie })).response.status, 401);

  await request('/api/auth/users', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { username: 'role-organizer-old', password: 'Role-organizer-password-123', role: 'ORGANIZER' },
  });
  const oldOrganizer = await login('role-organizer-old', 'Role-organizer-password-123');
  const promoted = await request('/api/auth/users/role-organizer-old', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { role: 'ADMIN' },
  });
  assert.equal(promoted.response.status, 200, JSON.stringify(promoted.data));
  assert.equal((await request('/api/auth/users', { cookie: oldOrganizer.cookie })).response.status, 401);
  const newAdmin = await login('role-organizer-old', 'Role-organizer-password-123');
  assert.equal((await request('/api/auth/users', { cookie: newAdmin.cookie })).response.status, 200);

  await request('/api/auth/users', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { username: 'same-role-user', password: 'Same-role-password-123', role: 'ORGANIZER' },
  });
  const sameRole = await login('same-role-user', 'Same-role-password-123');
  const unchanged = await request('/api/auth/users/same-role-user', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { role: 'ORGANIZER' },
  });
  assert.equal(unchanged.response.status, 200, JSON.stringify(unchanged.data));
  assert.equal((await request('/api/auth/me', { cookie: sameRole.cookie })).response.status, 200);

  const deactivated = await request('/api/auth/users/same-role-user', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { active: false },
  });
  assert.equal(deactivated.response.status, 200, JSON.stringify(deactivated.data));
  assert.equal((await request('/api/auth/me', { cookie: sameRole.cookie })).response.status, 401);
});

test('the bootstrap ADMIN cannot be deleted', async () => {
  await auth.createUser({ username: 'second-admin', password: 'Second-admin-password-123', role: 'ADMIN' });
  const admin = await login('second-admin', 'Second-admin-password-123');
  const result = await request('/api/auth/users/rootadmin', { method: 'DELETE', cookie: admin.cookie, csrf: admin.csrf });
  assert.equal(result.response.status, 400);
  assert.equal(result.data.code, 'BOOTSTRAP_USER');
});

test('meeting model validates fields, persists lifecycle and rejects duplicate room slugs', async () => {
  const record = await meetings.createMeeting({
    title: 'Capacitación segura',
    description: 'Descripción',
    room: 'capacitacion-segura',
    trainerName: 'Ana Pérez',
    scheduledAt: '2030-01-02T15:00:00.000Z',
    durationMinutes: 90,
    type: 'WEBINAR',
    capacity: 100,
    createdBy: 'rootadmin',
  });
  assert.equal(record.endsAt, '2030-01-02T16:30:00.000Z');
  assert.equal(record.status, 'SCHEDULED');
  await assert.rejects(() => meetings.createMeeting({ ...record }), /Ya existe/);
  const cancelled = await meetings.transitionMeeting(record.room, 'cancel');
  assert.equal(cancelled.status, 'CANCELLED');
  const restored = await meetings.transitionMeeting(record.room, 'restore');
  assert.equal(restored.status, 'SCHEDULED');
  const deleted = await meetings.deleteMeeting(record.room);
  assert.ok(deleted.deletedAt);
  assert.equal((await meetings.listMeetings()).some((item) => item.room === record.room), false);
});

test('reading a legacy meeting normalizes it without persisting a migration', async () => {
  const legacy = { room: 'legacy-read-only', title: 'Modelo anterior', scheduledAt: '2030-07-30T09:00:00.000Z' };
  await localStore.writeJson('meetings', legacy.room, legacy);
  const normalized = await meetings.getMeeting(legacy.room);
  const storedAgain = await localStore.readJson('meetings', legacy.room);
  assert.equal(normalized.trainerName, 'Capacitador por definir');
  assert.equal(normalized.capacity, 100);
  assert.equal(normalized.endsAt, '2030-07-30T10:00:00.000Z');
  assert.deepEqual(storedAgain, legacy);
});

test('invitations are long, stored only as hashes, expire, revoke and enforce use limits', async () => {
  const created = await invitations.createInvitation({
    meetingId: 'meeting-test', room: 'room-test', role: 'VIEWER', singleUse: true, createdBy: 'rootadmin',
  });
  assert.ok(created.token.length >= 40);
  const stored = await localStore.readJson('invitations', invitations.tokenHash(created.token));
  assert.equal(stored.token, undefined);
  assert.equal(stored.tokenHash, invitations.tokenHash(created.token));
  const consumed = await invitations.consumeInvitation(created.token);
  assert.equal(consumed.status, 'USED');
  await assert.rejects(() => invitations.consumeInvitation(created.token), /utilizada/);

  const concurrent = await invitations.createInvitation({ meetingId: 'm-concurrent', room: 'r-concurrent', role: 'VIEWER', singleUse: true, createdBy: 'rootadmin' });
  const results = await Promise.allSettled([
    invitations.consumeInvitation(concurrent.token),
    invitations.consumeInvitation(concurrent.token),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);

  const revocable = await invitations.createInvitation({ meetingId: 'm2', room: 'r2', role: 'PANELIST', createdBy: 'rootadmin' });
  await invitations.revokeInvitation(revocable.invitation.id, 'r2');
  await assert.rejects(() => invitations.consumeInvitation(revocable.token), /revocada/);

  const expiring = await invitations.createInvitation({ meetingId: 'm3', room: 'r3', role: 'VIEWER', createdBy: 'rootadmin' });
  const hash = invitations.tokenHash(expiring.token);
  const expiringRecord = await localStore.readJson('invitations', hash);
  expiringRecord.expiresAt = new Date(Date.now() - 1_000).toISOString();
  await localStore.writeJson('invitations', hash, expiringRecord);
  await assert.rejects(() => invitations.consumeInvitation(expiring.token), /expiró/);

  const legacyToken = 'legacy-'.padEnd(48, 'x');
  const legacyRecord = {
    id: 'legacy-invitation', tokenHash: invitations.legacyTokenHash(legacyToken), meetingId: 'legacy-meeting',
    room: 'legacy-room', role: 'VIEWER', expiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: 'ACTIVE', maxUses: null, uses: 0, createdAt: new Date().toISOString(), createdBy: 'legacy', revokedAt: null, lastUsedAt: null,
  };
  await localStore.writeJson('invitations', legacyRecord.tokenHash, legacyRecord);
  assert.equal((await invitations.peekInvitation(legacyToken)).id, legacyRecord.id);
});

test('room access fails closed unless explicitly configured', async () => {
  const missing = await rooms.checkAccess('missing-room');
  assert.equal(missing.allowed, false);
  await rooms.createRoom('registered-room', { meetingId: 'meeting-id' });
  assert.equal((await rooms.checkAccess('registered-room')).allowed, true);
  await rooms.revokeRoom('registered-room');
  assert.equal((await rooms.checkAccess('registered-room')).allowed, false);
});

test('room locking rejects new redemptions without consuming invitations and preserves existing sessions', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Sala bloqueable', room: 'sala-bloqueable', trainerName: 'Trainer', scheduledAt: '2031-04-01T10:00:00.000Z',
    durationMinutes: 60, status: 'LIVE', createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const organizer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', displayName: 'Organizador' });
  const organizerCookie = roomCookie(organizer.token).split(';')[0];
  mockRoomService.participants = [{ identity: organizer.session.identity }];
  const invitation = await invitations.createInvitation({ meetingId: meeting.id, room: meeting.room, role: 'VIEWER', createdBy: 'rootadmin' });

  const locked = await request('/api/room/lock', { method: 'POST', cookie: organizerCookie, roomCsrf: organizer.session.csrf, body: { locked: true } });
  assert.equal(locked.response.status, 200, JSON.stringify(locked.data));
  assert.equal(locked.data.locked, true);
  const rejected = await request(`/i/${invitation.token}`, { redirect: 'manual' });
  assert.equal(rejected.response.status, 423);
  assert.equal((await invitations.peekInvitation(invitation.token)).uses, 0);

  const tokenWhileLocked = await request('/api/token', { cookie: organizerCookie });
  assert.equal(tokenWhileLocked.response.status, 200, JSON.stringify(tokenWhileLocked.data));
  const unlocked = await request('/api/room/lock', { method: 'POST', cookie: organizerCookie, roomCsrf: organizer.session.csrf, body: { locked: false } });
  assert.equal(unlocked.data.locked, false);
  const redeemed = await request(`/i/${invitation.token}`, { redirect: 'manual' });
  assert.equal(redeemed.response.status, 303);
  mockRoomService.participants = [];
});

test('independent room cookies keep organizer and viewer actions valid in simultaneous tabs', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Sala en dos pestañas', room: 'sala-dos-pestanas', trainerName: 'Trainer', scheduledAt: '2031-04-05T10:00:00.000Z',
    durationMinutes: 60, status: 'LIVE', allowQuestions: true, createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const organizer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', displayName: 'Organizador' });
  const viewer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'VIEWER', displayName: 'Asistente' });
  const cookieJar = [
    roomCookie(organizer.token, organizer.session.sid).split(';')[0],
    roomCookie(viewer.token, viewer.session.sid).split(';')[0],
  ].join('; ');
  mockRoomService.participants = [
    { identity: organizer.session.identity, permission: { canPublish: true }, tracks: [] },
    { identity: viewer.session.identity, permission: { canPublish: false }, tracks: [] },
  ];
  mockRoomService.sentData = [];
  mockRoomService.updates = [];

  for (const session of [organizer, viewer]) {
    const current = await request('/api/room-session', { cookie: cookieJar, roomSessionId: session.session.sid });
    assert.equal(current.response.status, 200, JSON.stringify(current.data));
    assert.equal(current.data.identity, session.session.identity);
  }
  const invalidCsrf = await request('/api/participants/promote', {
    method: 'POST', cookie: cookieJar, roomSessionId: organizer.session.sid, roomCsrf: 'csrf-de-otra-pestana',
    body: { targetIdentity: viewer.session.identity },
  });
  assert.equal(invalidCsrf.response.status, 403);
  assert.equal(invalidCsrf.data.code, 'CSRF_INVALID');
  assert.match(invalidCsrf.data.error, /sesión de sala cambió/i);
  assert.deepEqual(invalidCsrf.data.diagnostic, { selectorPresent: true, selectedCookiePresent: true, csrfHeaderPresent: true });

  const mediaRequest = await request('/api/participants/request-media', {
    method: 'POST', cookie: cookieJar, roomSessionId: organizer.session.sid, roomCsrf: organizer.session.csrf,
    body: { targetIdentity: viewer.session.identity, action: 'request-microphone' },
  });
  assert.equal(mediaRequest.response.status, 200, JSON.stringify(mediaRequest.data));
  const accepted = await request('/api/participants/media-response', {
    method: 'POST', cookie: cookieJar, roomSessionId: viewer.session.sid, roomCsrf: viewer.session.csrf,
    body: { requestId: mediaRequest.data.requestId, status: 'accepted' },
  });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.data));
  assert.equal(accepted.data.permissionGranted, true);
  assert.equal(mockRoomService.participants[1].permission.canPublish, true);
  assert.equal(await rooms.hasSpeakerGrant(meeting.room, viewer.session.identity), true);
  const activated = await request('/api/participants/media-response', {
    method: 'POST', cookie: cookieJar, roomSessionId: viewer.session.sid, roomCsrf: viewer.session.csrf,
    body: { requestId: mediaRequest.data.requestId, status: 'activated' },
  });
  assert.equal(activated.data.status, 'activated');
  const secondRequest = await request('/api/participants/request-media', {
    method: 'POST', cookie: cookieJar, roomSessionId: organizer.session.sid, roomCsrf: organizer.session.csrf,
    body: { targetIdentity: viewer.session.identity, action: 'request-microphone' },
  });
  const rejected = await request('/api/participants/media-response', {
    method: 'POST', cookie: cookieJar, roomSessionId: viewer.session.sid, roomCsrf: viewer.session.csrf,
    body: { requestId: secondRequest.data.requestId, status: 'rejected' },
  });
  assert.equal(rejected.data.status, 'rejected');

  const demoted = await request('/api/participants/demote', {
    method: 'POST', cookie: cookieJar, roomSessionId: organizer.session.sid, roomCsrf: organizer.session.csrf,
    body: { targetIdentity: viewer.session.identity },
  });
  assert.equal(demoted.response.status, 200, JSON.stringify(demoted.data));
  assert.equal(mockRoomService.participants[1].permission.canPublish, false);
  assert.equal(await rooms.hasSpeakerGrant(meeting.room, viewer.session.identity), false);
  const promoted = await request('/api/participants/promote', {
    method: 'POST', cookie: cookieJar, roomSessionId: organizer.session.sid, roomCsrf: organizer.session.csrf,
    body: { targetIdentity: viewer.session.identity },
  });
  assert.equal(promoted.response.status, 200, JSON.stringify(promoted.data));
  assert.equal(mockRoomService.participants[1].permission.canPublish, true);
  assert.equal(await rooms.hasSpeakerGrant(meeting.room, viewer.session.identity), true);
  const forbidden = await request('/api/participants/promote', {
    method: 'POST', cookie: cookieJar, roomSessionId: viewer.session.sid, roomCsrf: viewer.session.csrf,
    body: { targetIdentity: viewer.session.identity },
  });
  assert.equal(forbidden.response.status, 403);

  const chat = await request('/api/chat/message', {
    method: 'POST', cookie: cookieJar, roomSessionId: viewer.session.sid, roomCsrf: viewer.session.csrf,
    body: { text: 'Mensaje desde la sesión canjeada', kind: 'chat' },
  });
  assert.equal(chat.response.status, 200, JSON.stringify(chat.data));
  const question = await request('/api/questions', {
    method: 'POST', cookie: cookieJar, roomSessionId: organizer.session.sid, roomCsrf: organizer.session.csrf,
    body: { text: '¿La sesión sigue vinculada a esta pestaña?' },
  });
  assert.equal(question.response.status, 201, JSON.stringify(question.data));
  mockRoomService.participants = [];
});

test('persistent Q&A enforces ownership, supports voting and moderator answers', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Preguntas profesionales', room: 'preguntas-profesionales', trainerName: 'Trainer', scheduledAt: '2031-05-01T10:00:00.000Z',
    durationMinutes: 60, status: 'LIVE', allowQuestions: true, createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const viewer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'VIEWER', displayName: 'María' });
  const organizer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', displayName: 'Ana' });
  const viewerCookie = roomCookie(viewer.token).split(';')[0];
  const organizerCookie = roomCookie(organizer.token).split(';')[0];
  mockRoomService.participants = [{ identity: viewer.session.identity }, { identity: organizer.session.identity }];

  const created = await request('/api/questions', { method: 'POST', cookie: viewerCookie, roomCsrf: viewer.session.csrf, body: { text: '¿La certificación llegará por correo?' } });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.question.status, 'PENDING');
  assert.equal(created.data.question.isOwn, true);

  const forbidden = await request(`/api/questions/${created.data.question.id}`, { method: 'PATCH', cookie: viewerCookie, roomCsrf: viewer.session.csrf, body: { status: 'DISMISSED' } });
  assert.equal(forbidden.response.status, 403);
  const voted = await request(`/api/questions/${created.data.question.id}/vote`, { method: 'POST', cookie: organizerCookie, roomCsrf: organizer.session.csrf, body: {} });
  assert.equal(voted.data.question.voteCount, 1);
  const rewrite = await request(`/api/questions/${created.data.question.id}`, { method: 'PATCH', cookie: organizerCookie, roomCsrf: organizer.session.csrf, body: { text: 'Texto alterado por moderador' } });
  assert.equal(rewrite.response.status, 403);
  const answered = await request(`/api/questions/${created.data.question.id}`, { method: 'PATCH', cookie: organizerCookie, roomCsrf: organizer.session.csrf, body: { answer: 'Sí, llegará al correo registrado.' } });
  assert.equal(answered.response.status, 200, JSON.stringify(answered.data));
  assert.equal(answered.data.question.status, 'ANSWERED_WRITTEN');

  const listing = await request('/api/questions', { cookie: viewerCookie });
  assert.equal(listing.data.questions.length, 1);
  assert.equal(listing.data.questions[0].answer, 'Sí, llegará al correo registrado.');
  const dismissed = await request(`/api/questions/${created.data.question.id}`, { method: 'PATCH', cookie: organizerCookie, roomCsrf: organizer.session.csrf, body: { status: 'DISMISSED' } });
  assert.equal(dismissed.response.status, 200, JSON.stringify(dismissed.data));
  const viewerAfterDismiss = await request('/api/questions', { cookie: viewerCookie });
  assert.deepEqual(viewerAfterDismiss.data.questions, []);
  const organizerArchive = await request('/api/questions', { cookie: organizerCookie });
  assert.equal(organizerArchive.data.questions.length, 1);
  assert.equal(organizerArchive.data.questions[0].status, 'DISMISSED');
  assert.equal(organizerArchive.data.questions[0].answer, 'Sí, llegará al correo registrado.');
  const voteAfterDismiss = await request(`/api/questions/${created.data.question.id}/vote`, { method: 'POST', cookie: viewerCookie, roomCsrf: viewer.session.csrf, body: {} });
  assert.equal(voteAfterDismiss.response.status, 404);
  assert.equal((await questions.list(meeting.room)).length, 1);
  mockRoomService.participants = [];
});

test('chat pins are persistent, room-scoped and restricted to host teacher or cohost', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Chat fijado', room: 'chat-fijado', trainerName: 'Trainer', scheduledAt: '2031-05-01T10:00:00.000Z',
    durationMinutes: 60, status: 'LIVE', allowChat: true, createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const host = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', meetingType: 'WEBINAR', meetingRole: 'HOST', displayName: 'Host' });
  const cohost = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'PANELIST', meetingType: 'WEBINAR', meetingRole: 'COHOST', displayName: 'Cohost' });
  const panelist = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'PANELIST', meetingType: 'WEBINAR', meetingRole: 'PANELIST', displayName: 'Panelista' });
  const attendee = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'VIEWER', meetingType: 'WEBINAR', meetingRole: 'ATTENDEE', displayName: 'Asistente' });
  const hostCookie = roomCookie(host.token).split(';')[0];
  const cohostCookie = roomCookie(cohost.token).split(';')[0];
  const panelistCookie = roomCookie(panelist.token).split(';')[0];
  const attendeeCookie = roomCookie(attendee.token).split(';')[0];
  mockRoomService.participants = [host, cohost, panelist, attendee].map(({ session }) => ({ identity: session.identity }));

  const hostPin = await request('/api/chat/pins', {
    method: 'POST', cookie: hostCookie, roomCsrf: host.session.csrf,
    body: { text: 'Registra tu asistencia en https://forms.example.com/a.', authorName: 'Host', authorRole: 'HOST', sentAt: '2031-05-01T10:05:00.000Z' },
  });
  assert.equal(hostPin.response.status, 201, JSON.stringify(hostPin.data));
  assert.equal(hostPin.data.pin.authorName, 'Host');
  assert.match(hostPin.data.pin.text, /https:\/\/forms\.example\.com\/a/);

  const cohostPin = await request('/api/chat/pins', {
    method: 'POST', cookie: cohostCookie, roomCsrf: cohost.session.csrf,
    body: { text: 'Material: www.example.com/guia', authorName: 'Cohost', authorRole: 'COHOST' },
  });
  assert.equal(cohostPin.response.status, 201, JSON.stringify(cohostPin.data));

  const attendeeForbidden = await request('/api/chat/pins', {
    method: 'POST', cookie: attendeeCookie, roomCsrf: attendee.session.csrf,
    body: { text: 'No autorizado' },
  });
  assert.equal(attendeeForbidden.response.status, 403);
  const panelistForbidden = await request('/api/chat/pins', {
    method: 'POST', cookie: panelistCookie, roomCsrf: panelist.session.csrf,
    body: { text: 'Panelista normal' },
  });
  assert.equal(panelistForbidden.response.status, 403);

  const attendeeList = await request('/api/chat/pins', { cookie: attendeeCookie });
  assert.equal(attendeeList.response.status, 200, JSON.stringify(attendeeList.data));
  assert.equal(attendeeList.data.pins.length, 2);

  const otherMeeting = await meetings.createMeeting({
    title: 'Otra sala', room: 'chat-fijado-otra', trainerName: 'Trainer', scheduledAt: '2031-05-01T11:00:00.000Z',
    durationMinutes: 60, status: 'LIVE', allowChat: true, createdBy: 'rootadmin',
  });
  await rooms.createRoom(otherMeeting.room, { meetingId: otherMeeting.id });
  const otherViewer = createRoomSession({ room: otherMeeting.room, meetingId: otherMeeting.id, role: 'VIEWER', meetingType: 'WEBINAR', meetingRole: 'ATTENDEE', displayName: 'Otro' });
  const otherList = await request('/api/chat/pins', { cookie: roomCookie(otherViewer.token).split(';')[0] });
  assert.deepEqual(otherList.data.pins, []);

  const removed = await request(`/api/chat/pins/${hostPin.data.pin.id}`, { method: 'DELETE', cookie: cohostCookie, roomCsrf: cohost.session.csrf });
  assert.equal(removed.response.status, 200, JSON.stringify(removed.data));
  const lateJoin = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'VIEWER', meetingType: 'WEBINAR', meetingRole: 'ATTENDEE', displayName: 'Tarde' });
  const lateList = await request('/api/chat/pins', { cookie: roomCookie(lateJoin.token).split(';')[0] });
  assert.deepEqual(lateList.data.pins.map((pin) => pin.id), [cohostPin.data.pin.id]);

  const classMeeting = await meetings.createMeeting({
    title: 'Clase con pin', room: 'clase-pin', trainerName: 'Teacher', scheduledAt: '2031-05-01T12:00:00.000Z',
    durationMinutes: 60, status: 'LIVE', type: 'CLASS', allowChat: true, createdBy: 'rootadmin',
  });
  await rooms.createRoom(classMeeting.room, { meetingId: classMeeting.id });
  const teacher = createRoomSession({ room: classMeeting.room, meetingId: classMeeting.id, role: 'ORGANIZER', meetingType: 'CLASS', meetingRole: 'TEACHER', displayName: 'Docente' });
  mockRoomService.participants = [{ identity: teacher.session.identity }];
  const teacherPin = await request('/api/chat/pins', { method: 'POST', cookie: roomCookie(teacher.token).split(';')[0], roomCsrf: teacher.session.csrf, body: { text: 'Pin de clase' } });
  assert.equal(teacherPin.response.status, 201, JSON.stringify(teacherPin.data));
  mockRoomService.participants = [];
});

test('viewer room sessions cannot promote participants or control recording', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Sala viewer', room: 'sala-viewer', trainerName: 'Trainer', scheduledAt: '2031-01-01T10:00:00.000Z',
    durationMinutes: 60, status: 'LIVE', createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const viewer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'VIEWER' });
  const cookie = roomCookie(viewer.token).split(';')[0];
  const promote = await request('/api/participants/promote', {
    method: 'POST', cookie, roomCsrf: viewer.session.csrf, body: { targetIdentity: 'viewer-target-123' },
  });
  assert.equal(promote.response.status, 403);
  const recording = await request('/api/recording/start', { method: 'POST', cookie, roomCsrf: viewer.session.csrf, body: {} });
  assert.equal(recording.response.status, 403);
});

test('manual Facebook Live uses a host-only, secret-free and recording-independent Egress flow', async () => {
  mockEgressClient.reset();
  mockRoomService.sentData = [];
  const meeting = await meetings.createMeeting({
    title: 'Facebook Live manual', room: 'facebook-live-manual', trainerName: 'Trainer', scheduledAt: null,
    durationMinutes: 60, status: 'LIVE', allowRecording: true, type: 'WEBINAR', createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const host = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', meetingRole: 'HOST', displayName: 'Host' });
  const cohost = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', meetingRole: 'COHOST', displayName: 'Cohost' });
  const hostCookie = roomCookie(host.token, host.session.sid).split(';')[0];
  const cohostCookie = roomCookie(cohost.token, cohost.session.sid).split(';')[0];
  mockRoomService.participants = [{ identity: host.session.identity }, { identity: cohost.session.identity }];

  const forbidden = await request('/api/facebook-live/start', {
    method: 'POST', cookie: cohostCookie, roomSessionId: cohost.session.sid, roomCsrf: cohost.session.csrf,
    body: { serverUrl: 'rtmps://live-api-s.facebook.com:443/rtmp/', streamKey: 'cohost-key-123' },
  });
  assert.equal(forbidden.response.status, 403);
  assert.equal(mockEgressClient.starts.length, 0);

  for (const serverUrl of ['https://live-api-s.facebook.com/rtmp/', 'ftp://live-api-s.facebook.com/rtmp/']) {
    const invalid = await request('/api/facebook-live/start', {
      method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
      body: { serverUrl, streamKey: 'invalid-protocol-key' },
    });
    assert.equal(invalid.response.status, 400);
  }

  const secret = 'facebook-secret-key-123?s_bl=1&s_ps=1&s_sw=0&s_vt=api-s&a=abc_DEF-123.%25';
  const serverUrl = 'rtmps://live-api-s.facebook.com:443/rtmp/';
  const started = await request('/api/facebook-live/start', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { serverUrl, streamKey: secret },
  });
  assert.equal(started.response.status, 201, JSON.stringify(started.data));
  assert.equal(started.data.state, 'ACTIVE');
  assert.equal(started.data.active, true);
  assert.equal(mockEgressClient.starts.length, 1);
  assert.equal(mockEgressClient.starts[0].output.urls[0], `${serverUrl}${secret}`);
  assert.doesNotMatch(JSON.stringify(started.data), new RegExp(secret));
  assert.doesNotMatch(JSON.stringify(started.data), /live-api-s\.facebook\.com/);
  assert.doesNotMatch(JSON.stringify(mockRoomService.sentData), new RegExp(secret));
  assert.equal(mockRoomService.sentData.at(-1).data.kind, 'external-stream-status');
  assert.equal(mockRoomService.sentData.some((packet) => packet.data.kind === 'recording-status'), false);
  assert.doesNotMatch(JSON.stringify(await audit.listEvents({ room: meeting.room })), new RegExp(secret));

  const status = await request('/api/facebook-live/status', { cookie: hostCookie, roomSessionId: host.session.sid });
  assert.equal(status.data.state, 'ACTIVE');
  assert.doesNotMatch(JSON.stringify(status.data), new RegExp(secret));
  const firstExternalId = started.data.egressId;
  const stopped = await request('/api/facebook-live/stop', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf, body: { egressId: firstExternalId },
  });
  assert.equal(stopped.response.status, 200, JSON.stringify(stopped.data));
  assert.equal(mockEgressClient.stops.at(-1), firstExternalId);

  const recording = {
    egressId: 'recording-independent-1', roomName: meeting.room, status: 'EGRESS_ACTIVE', fileResults: [{}],
    request: { value: { fileOutputs: [{ filepath: 'recordings/facebook-live-manual/test.mp4' }] } },
  };
  mockEgressClient.items.push(recording);
  const second = await request('/api/facebook-live/start', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { serverUrl, streamKey: 'second-facebook-key-456' },
  });
  assert.equal(second.response.status, 201, JSON.stringify(second.data));
  await request('/api/facebook-live/stop', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf, body: { egressId: second.data.egressId },
  });
  assert.equal(recording.status, 'EGRESS_ACTIVE');
  assert.equal(mockEgressClient.stops.includes(recording.egressId), false);

  const failedSecret = 'never-echo-this-facebook-key';
  mockEgressClient.failStart = new Error(`upstream included ${failedSecret}`);
  const failed = await request('/api/facebook-live/start', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { serverUrl, streamKey: failedSecret },
  });
  assert.equal(failed.response.status, 502);
  assert.equal(failed.data.code, 'FACEBOOK_EGRESS_FAILED');
  assert.match(failed.data.error, /LiveKit Egress|Server URL|Stream Key/);
  assert.doesNotMatch(JSON.stringify(failed.data), new RegExp(failedSecret));
  assert.equal((await meetings.getMeeting(meeting.room)).status, 'LIVE');
  mockEgressClient.failStart = null;

  const cleanup = await request('/api/facebook-live/start', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { serverUrl, streamKey: 'cleanup-facebook-key-789' },
  });
  assert.equal(cleanup.response.status, 201, JSON.stringify(cleanup.data));
  mockEgressClient.failStop = new Error('Facebook destination unavailable');
  const stopCount = mockEgressClient.stops.length;
  const ended = await request('/api/room/end', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf, body: {},
  });
  assert.equal(ended.response.status, 200, JSON.stringify(ended.data));
  assert.equal(ended.data.ended, true);
  assert.ok(mockEgressClient.stops.slice(stopCount).includes(cleanup.data.egressId));
  assert.equal(mockEgressClient.stops.slice(stopCount).includes(recording.egressId), false);
  mockEgressClient.reset();
  mockRoomService.participants = [];
});

test('stale external Facebook sessions do not block a clean retry', async () => {
  mockEgressClient.reset();
  mockRoomService.sentData = [];
  const meeting = await meetings.createMeeting({
    title: 'Facebook Live retry', room: 'facebook-live-retry', trainerName: 'Trainer', scheduledAt: null,
    durationMinutes: 60, status: 'LIVE', allowRecording: true, type: 'WEBINAR', createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const host = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', meetingRole: 'HOST', displayName: 'Host' });
  const hostCookie = roomCookie(host.token, host.session.sid).split(';')[0];
  mockRoomService.participants = [{ identity: host.session.identity }];
  const serverUrl = 'rtmps://live-api-s.facebook.com:443/rtmp/';

  const first = await request('/api/facebook-live/start', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { serverUrl, streamKey: 'first-facebook-key-123' },
  });
  assert.equal(first.response.status, 201, JSON.stringify(first.data));
  assert.equal(mockEgressClient.starts.length, 1);
  mockEgressClient.items[0].status = 'EGRESS_ABORTED';
  mockEgressClient.items[0].error = 'Start signal not received';

  const retry = await request('/api/facebook-live/start', {
    method: 'POST', cookie: hostCookie, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { serverUrl, streamKey: 'second-facebook-key-456' },
  });
  assert.equal(retry.response.status, 201, JSON.stringify(retry.data));
  assert.equal(retry.data.state, 'ACTIVE');
  assert.equal(mockEgressClient.starts.length, 2);
  mockEgressClient.reset();
  mockRoomService.participants = [];
});

test('stale recording sessions are failed before a clean retry', async () => {
  await externalSessions.resetForTest();
  const first = await externalSessions.beginRecording({ meetingId: 'recording-retry-meeting', room: 'recording-retry-room' });
  assert.equal(first.created, true);

  const failed = await externalSessions.failOpenRecordingSessions('recording-retry-room', { message: 'Start signal not received' });
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'FAILED');
  assert.equal(failed[0].lastErrorMessage, 'Start signal not received');

  const retry = await externalSessions.beginRecording({ meetingId: 'recording-retry-meeting', room: 'recording-retry-room' });
  assert.equal(retry.created, true);
  assert.notEqual(retry.session.id, first.session.id);
  await externalSessions.resetForTest();
});

test('chat is server-relayed, session-bound and rate limited', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Chat seguro', room: 'chat-seguro', trainerName: 'Trainer', scheduledAt: '2031-03-01T10:00:00.000Z',
    durationMinutes: 60, status: 'LIVE', createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const viewer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'VIEWER', displayName: 'Asistente Test' });
  const cookie = roomCookie(viewer.token).split(';')[0];
  mockRoomService.participants = [
    { identity: viewer.session.identity },
    { identity: 'organizer-target-123' },
  ];
  mockRoomService.sentData = [];
  for (const text of ['Primer mensaje', 'Segundo mensaje']) {
    const result = await request('/api/chat/message', { method: 'POST', cookie, roomCsrf: viewer.session.csrf, body: { text, kind: 'chat' } });
    assert.equal(result.response.status, 200, JSON.stringify(result.data));
  }
  const limited = await request('/api/chat/message', { method: 'POST', cookie, roomCsrf: viewer.session.csrf, body: { text: 'Tercer mensaje', kind: 'chat' } });
  assert.equal(limited.response.status, 429);
  assert.equal(mockRoomService.sentData.length, 2);
  assert.equal(mockRoomService.sentData[0].data.fromIdentity, viewer.session.identity);
  assert.deepEqual(mockRoomService.sentData[0].options.destinationIdentities, ['organizer-target-123']);
  mockRoomService.participants = [];
});

test('chat upload content validation accepts real signatures and rejects spoofed MIME', () => {
  const validPng = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.doesNotThrow(() => assertValidFileContent('image/png', validPng));
  assert.equal(hasValidMagicBytes('image/png', validPng), true);
  assert.equal(hasValidMagicBytes('image/jpeg', Buffer.from([0xff, 0xd8, 0xff, 0xdb])), true);
  assert.equal(hasValidMagicBytes('image/webp', Buffer.from('RIFFxxxxWEBPVP8 ', 'ascii')), true);
  assert.equal(hasValidMagicBytes('application/pdf', Buffer.from('%PDF-1.7\n', 'ascii')), true);
  assert.equal(hasValidMagicBytes('text/plain', Buffer.from('Enlace seguro https://example.com\n', 'utf8')), true);
  assert.equal(hasValidMagicBytes('image/png', Buffer.from('not really a png', 'utf8')), false);
  assert.equal(hasValidMagicBytes('application/pdf', Buffer.from([0x00, 0x01, 0x02, 0x03])), false);
  assert.equal(hasValidMagicBytes('text/plain', Buffer.from([0x48, 0x00, 0x49])), false);
  assert.throws(() => assertValidFileContent('image/png', Buffer.from('not really a png', 'utf8')), /tipo declarado/);
});

test('meeting endpoints require both session and CSRF and preserve unique rooms', async () => {
  const admin = await login();
  const payload = {
    title: 'API meeting', description: 'Test', room: 'api-meeting', trainerName: 'Trainer API',
    scheduledAt: '2032-02-02T12:00:00.000Z', durationMinutes: 45, type: 'CLASS', capacity: 25,
  };
  const noCsrf = await request('/api/meetings', { method: 'POST', cookie: admin.cookie, body: payload });
  assert.equal(noCsrf.response.status, 403);
  const created = await request('/api/meetings', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: payload });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const duplicate = await request('/api/meetings', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: payload });
  assert.equal(duplicate.response.status, 409);
  const untrustedRoom = await request('/api/rooms', { method: 'POST', body: { room: 'api-meeting' } });
  assert.equal(untrustedRoom.response.status, 401);
  const securedRoom = await request('/api/rooms', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { room: 'api-meeting' } });
  assert.equal(securedRoom.response.status, 200);
});

test('meeting PATCH cannot change lifecycle while official actions keep side effects', async () => {
  const admin = await login();
  const payload = {
    title: 'Lifecycle seguro', description: 'Test', room: 'lifecycle-seguro', trainerName: 'Trainer API',
    scheduledAt: '2032-03-02T12:00:00.000Z', durationMinutes: 45, type: 'WEBINAR', capacity: 25,
  };
  const created = await request('/api/meetings', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: payload });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const completePatch = await request('/api/meetings/lifecycle-seguro', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { status: 'COMPLETED' },
  });
  assert.equal(completePatch.response.status, 400);
  assert.equal(completePatch.data.code, 'MEETING_STATUS_IMMUTABLE');
  const cancelPatch = await request('/api/meetings/lifecycle-seguro', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { status: 'CANCELLED' },
  });
  assert.equal(cancelPatch.response.status, 400);
  assert.equal((await meetings.getMeeting('lifecycle-seguro')).status, 'SCHEDULED');

  const edited = await request('/api/meetings/lifecycle-seguro', {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { title: 'Lifecycle seguro editado', capacity: 80 },
  });
  assert.equal(edited.response.status, 200, JSON.stringify(edited.data));
  assert.equal(edited.data.title, 'Lifecycle seguro editado');
  assert.equal(edited.data.capacity, 80);
  assert.equal(edited.data.status, 'SCHEDULED');

  const cancel = await request('/api/meetings/lifecycle-seguro/actions/cancel', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(cancel.response.status, 200, JSON.stringify(cancel.data));
  assert.equal(cancel.data.status, 'CANCELLED');
  assert.equal((await rooms.checkAccess('lifecycle-seguro')).allowed, false);

  const restored = await request('/api/meetings/lifecycle-seguro/actions/restore', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.status, 'SCHEDULED');
  assert.equal((await rooms.checkAccess('lifecycle-seguro')).allowed, true);

  const complete = await request('/api/meetings/lifecycle-seguro/actions/complete', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(complete.response.status, 200, JSON.stringify(complete.data));
  assert.equal(complete.data.status, 'COMPLETED');
  assert.equal((await rooms.checkAccess('lifecycle-seguro')).allowed, false);

  const archivePayload = { ...payload, title: 'Lifecycle archivo', room: 'lifecycle-archivo' };
  const archiveMeeting = await request('/api/meetings', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: archivePayload });
  assert.equal(archiveMeeting.response.status, 201, JSON.stringify(archiveMeeting.data));
  const archive = await request('/api/meetings/lifecycle-archivo/actions/archive', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(archive.response.status, 200, JSON.stringify(archive.data));
  assert.equal(archive.data.status, 'ARCHIVED');
  assert.equal((await rooms.checkAccess('lifecycle-archivo')).allowed, false);
});

test('LiveKit unavailable never marks a scheduled meeting live or writes a real start event', async () => {
  const admin = await login();
  const before = await request('/api/dashboard/summary', { cookie: admin.cookie });
  mockLivekitAvailable = false;
  const launch = await request('/api/meetings/api-meeting/launch', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(launch.response.status, 503);
  assert.equal(launch.data.code, 'LIVEKIT_UNAVAILABLE');
  assert.equal((await meetings.getMeeting('api-meeting')).status, 'SCHEDULED');
  const after = await request('/api/dashboard/summary', { cookie: admin.cookie });
  assert.equal(after.data.activeMeetings, before.data.activeMeetings);
  const events = await audit.listEvents({ room: 'api-meeting', limit: 100 });
  assert.equal(events.filter((item) => ['ROOM_CONNECTED', 'MEETING_STARTED'].includes(item.action)).length, 0);
  assert.equal(events.filter((item) => item.action === 'ROOM_CONNECTION_FAILED').length, 1);
  mockLivekitAvailable = true;
});

test('a confirmed LiveKit participant marks the meeting live once and does not duplicate audit', async () => {
  const admin = await login();
  const launch = await request('/api/meetings/api-meeting/launch', { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(launch.response.status, 200, JSON.stringify(launch.data));
  assert.equal((await meetings.getMeeting('api-meeting')).status, 'SCHEDULED');
  const roomSession = await request('/api/room-session', { cookie: launch.cookie });
  assert.equal(roomSession.response.status, 200);
  mockRoomService.participants = [{ identity: roomSession.data.identity }];
  const connected = await request('/api/room/connection', { method: 'POST', cookie: launch.cookie, roomCsrf: roomSession.data.csrfToken, body: { event: 'connected' } });
  assert.equal(connected.response.status, 200, JSON.stringify(connected.data));
  assert.equal(connected.data.meetingStatus, 'LIVE');
  assert.equal((await meetings.getMeeting('api-meeting')).status, 'LIVE');
  const duplicate = await request('/api/room/connection', { method: 'POST', cookie: launch.cookie, roomCsrf: roomSession.data.csrfToken, body: { event: 'connected' } });
  assert.equal(duplicate.response.status, 200);
  const events = await audit.listEvents({ room: 'api-meeting', limit: 100 });
  assert.equal(events.filter((item) => item.action === 'ROOM_CONNECTED').length, 1);
  mockRoomService.participants = [];
});

test('a pre-marked LIVE meeting receives a stable startedAt on first confirmed connection', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Live sin inicio', room: 'live-sin-inicio', trainerName: 'Trainer', scheduledAt: null,
    durationMinutes: 60, status: 'LIVE', createdBy: 'rootadmin',
  });
  assert.equal(meeting.startedAt, null);
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const organizer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', displayName: 'Trainer' });
  const cookie = roomCookie(organizer.token).split(';')[0];
  mockRoomService.participants = [{ identity: organizer.session.identity }];
  const connected = await request('/api/room/connection', { method: 'POST', cookie, roomCsrf: organizer.session.csrf, body: { event: 'connected' } });
  assert.equal(connected.response.status, 200, JSON.stringify(connected.data));
  assert.equal(connected.data.started, true);
  const startedAt = (await meetings.getMeeting(meeting.room)).startedAt;
  assert.ok(startedAt);
  const repeated = await request('/api/room/connection', { method: 'POST', cookie, roomCsrf: organizer.session.csrf, body: { event: 'connected' } });
  assert.equal(repeated.data.started, false);
  assert.equal((await meetings.getMeeting(meeting.room)).startedAt, startedAt);
  mockRoomService.participants = [];
});

test('invitation redemption removes the token from the URL and creates a room cookie', async () => {
  const admin = await login();
  const invitation = await request('/api/meetings/api-meeting/invitations', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { role: 'VIEWER', singleUse: true, expiresInMinutes: 60 },
  });
  assert.equal(invitation.response.status, 201, JSON.stringify(invitation.data));
  assert.match(invitation.data.path, /^\/i\/[A-Za-z0-9_-]{40,}$/);
  assert.match(invitation.data.url, /^http:\/\/localhost:3000\/i\/[A-Za-z0-9_-]{40,}$/);
  assert.match(invitation.data.message, /Te invitamos a participar/);
  assert.equal(new URL(invitation.data.whatsappUrl).searchParams.get('text'), invitation.data.message);
  const redemption = await request(invitation.data.path, { redirect: 'manual' });
  assert.equal(redemption.response.status, 303);
  assert.match(redemption.response.headers.get('location'), /^\/viewer\.html\?roomSession=[a-f0-9-]{36}$/i);
  assert.match(redemption.response.headers.get('set-cookie'), /rat_room_session=.*HttpOnly/i);
  const roomSessionId = new URL(redemption.response.headers.get('location'), baseUrl).searchParams.get('roomSession');
  const cookieJar = redemption.cookies.join('; ');
  const session = await request('/api/room-session', { cookie: cookieJar, roomSessionId });
  assert.equal(session.response.status, 200, JSON.stringify(session.data));
  assert.equal(session.data.role, 'VIEWER');
  mockRoomService.participants = [{ identity: session.data.identity }];
  const question = await request('/api/questions', {
    method: 'POST', cookie: cookieJar, roomSessionId, roomCsrf: session.data.csrfToken,
    body: { text: '¿Puedo seguir usando la sesión después de canjear el enlace?' },
  });
  assert.equal(question.response.status, 201, JSON.stringify(question.data));
  const reused = await request(invitation.data.path, { redirect: 'manual' });
  assert.equal(reused.response.status, 410);
  mockRoomService.participants = [];
});

test('canonical invitations bind modality and role, force privileged single use and ignore URL tampering', async () => {
  const admin = await login();
  const meeting = await meetings.createMeeting({
    title: 'Clase con accesos canÃ³nicos', room: 'clase-accesos-canonicos', trainerName: 'Docente',
    scheduledAt: null, durationMinutes: 45, status: 'LIVE', type: 'CLASS', createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const teacher = await request(`/api/meetings/${meeting.room}/invitations`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { meetingRole: 'TEACHER', singleUse: false, expiresInMinutes: 60 },
  });
  assert.equal(teacher.response.status, 201, JSON.stringify(teacher.data));
  assert.equal(teacher.data.invitation.meetingRole, 'TEACHER');
  assert.equal(teacher.data.invitation.role, 'ORGANIZER');
  assert.equal(teacher.data.invitation.maxUses, 1);
  assert.match(teacher.data.message, /Docente/i);
  const invalid = await request(`/api/meetings/${meeting.room}/invitations`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { meetingRole: 'HOST', expiresInMinutes: 60 },
  });
  assert.equal(invalid.response.status, 400);

  const student = await request(`/api/meetings/${meeting.room}/invitations`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { meetingRole: 'STUDENT', expiresInMinutes: 60 },
  });
  assert.equal(student.response.status, 201, JSON.stringify(student.data));
  assert.equal(student.data.invitation.meetingRole, 'STUDENT');
  const redemption = await request(`${student.data.path}?meetingRole=TEACHER&role=ORGANIZER`, { redirect: 'manual' });
  assert.equal(redemption.response.status, 303);
  assert.match(redemption.response.headers.get('location'), /^\/presenter\.html\?roomSession=/);
  const roomSessionId = new URL(redemption.response.headers.get('location'), baseUrl).searchParams.get('roomSession');
  const session = await request('/api/room-session', { cookie: redemption.cookies.join('; '), roomSessionId });
  assert.equal(session.response.status, 200, JSON.stringify(session.data));
  assert.equal(session.data.meetingRole, 'STUDENT');
  assert.equal(session.data.role, 'PANELIST');
  assert.equal(session.data.consentRequired, true);
  assert.deepEqual(session.data.publishSources.sort(), ['CAMERA', 'MICROPHONE'].sort());
});

test('simple meeting links expose only reusable host and participant access with separate identities', async () => {
  const admin = await login();
  const meeting = await meetings.createMeeting({
    title: 'Reunión enlaces simples', room: 'reunion-enlaces-simples', trainerName: 'Trainer',
    scheduledAt: null, durationMinutes: 60, status: 'LIVE', type: 'WEBINAR', createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });

  const hostAccess = await request(`/api/meetings/${meeting.room}/simple-accesses/HOST`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  const hostAgain = await request(`/api/meetings/${meeting.room}/simple-accesses/HOST`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  const participantAccess = await request(`/api/meetings/${meeting.room}/simple-accesses/PARTICIPANT`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(hostAccess.response.status, 200, JSON.stringify(hostAccess.data));
  assert.equal(hostAgain.response.status, 200, JSON.stringify(hostAgain.data));
  assert.equal(participantAccess.response.status, 200, JSON.stringify(participantAccess.data));
  assert.equal(hostAccess.data.access.url, hostAgain.data.access.url);
  assert.match(hostAccess.data.access.path, /^\/a\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.equal(hostAccess.data.access.meetingRole, 'HOST');
  assert.equal(participantAccess.data.access.meetingRole, 'ATTENDEE');
  assert.match(hostAccess.data.access.message, /varios anfitriones autorizados|permisos de anfitrión/i);
  assert.match(participantAccess.data.access.message, /Cada persona tendrá su propia identidad/i);

  async function redeem(path) {
    const redemption = await request(path, { redirect: 'manual' });
    assert.equal(redemption.response.status, 303, JSON.stringify(redemption.data));
    const roomSessionId = new URL(redemption.response.headers.get('location'), baseUrl).searchParams.get('roomSession');
    const session = await request('/api/room-session', { cookie: redemption.cookies.join('; '), roomSessionId });
    assert.equal(session.response.status, 200, JSON.stringify(session.data));
    return { location: redemption.response.headers.get('location'), session: session.data };
  }

  const hostA = await redeem(hostAccess.data.access.path);
  const hostB = await redeem(hostAccess.data.access.path);
  assert.match(hostA.location, /^\/presenter\.html\?roomSession=/);
  assert.match(hostB.location, /^\/presenter\.html\?roomSession=/);
  assert.notEqual(hostA.session.identity, hostB.session.identity);
  assert.equal(hostA.session.meetingRole, 'HOST');
  assert.equal(hostB.session.role, 'ORGANIZER');
  assert.equal(hostA.session.capabilities.canManageRoom, true);

  const participantA = await redeem(participantAccess.data.access.path);
  const participantB = await redeem(participantAccess.data.access.path);
  assert.match(participantA.location, /^\/viewer\.html\?roomSession=/);
  assert.notEqual(participantA.session.identity, participantB.session.identity);
  assert.equal(participantA.session.meetingRole, 'ATTENDEE');
  assert.equal(participantB.session.role, 'VIEWER');
  assert.equal(participantA.session.capabilities.canManageRoom, false);
  assert.equal(participantA.session.capabilities.canUsePresenterPanel, false);
});

test('viewer consent is persisted and required before issuing a LiveKit token', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Consentimiento verificable', room: 'consentimiento-verificable', trainerName: 'Trainer', scheduledAt: null,
    durationMinutes: 60, status: 'LIVE', allowRecording: true, recordingConsentRequired: true,
    allowTranscription: true, transcriptionConsentRequired: true, createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const viewer = createRoomSession({ room: meeting.room, meetingId: meeting.id, role: 'VIEWER', displayName: 'Asistente' });
  const cookie = roomCookie(viewer.token, viewer.session.sid).split(';')[0];
  const denied = await request('/api/token', { cookie, roomSessionId: viewer.session.sid });
  assert.equal(denied.response.status, 403);
  assert.equal(denied.data.code, 'PRIVACY_CONSENT_REQUIRED');
  const incomplete = await request('/api/room-session/consent', {
    method: 'POST', cookie, roomSessionId: viewer.session.sid, roomCsrf: viewer.session.csrf,
    body: { privacy: true, recording: false, transcription: true },
  });
  assert.equal(incomplete.response.status, 400);
  assert.equal(incomplete.data.code, 'RECORDING_CONSENT_REQUIRED');
  const accepted = await request('/api/room-session/consent', {
    method: 'POST', cookie, roomSessionId: viewer.session.sid, roomCsrf: viewer.session.csrf,
    body: { privacy: true, recording: true, transcription: true },
  });
  assert.equal(accepted.response.status, 200, JSON.stringify(accepted.data));
  assert.ok(accepted.data.consents.acceptedAt);
  const token = await request('/api/token', { cookie: accepted.cookie, roomSessionId: viewer.session.sid });
  assert.equal(token.response.status, 200, JSON.stringify(token.data));
  const events = await audit.listEvents({ room: meeting.room, action: 'PARTICIPANT_CONSENT_RECORDED' });
  assert.equal(events.length, 1);
  assert.deepEqual({ privacy: events[0].metadata.privacy, recording: events[0].metadata.recording, transcription: events[0].metadata.transcription }, { privacy: true, recording: true, transcription: true });
});

test('canonical roles block escalation and update LiveKit publication sources in real time', async () => {
  const meeting = await meetings.createMeeting({
    title: 'Webinar con funciones', room: 'webinar-funciones', trainerName: 'Trainer', scheduledAt: null,
    durationMinutes: 60, status: 'LIVE', type: 'WEBINAR', createdBy: 'rootadmin',
  });
  await rooms.createRoom(meeting.room, { meetingId: meeting.id });
  const host = createRoomSession({
    room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', meetingType: 'WEBINAR',
    meetingRole: 'HOST', legacyAccess: false, displayName: 'AnfitriÃ³n',
  });
  const attendee = createRoomSession({
    room: meeting.room, meetingId: meeting.id, role: 'VIEWER', meetingType: 'WEBINAR',
    meetingRole: 'ATTENDEE', legacyAccess: false, displayName: 'Asistente',
  });
  const cohost = createRoomSession({
    room: meeting.room, meetingId: meeting.id, role: 'ORGANIZER', meetingType: 'WEBINAR',
    meetingRole: 'COHOST', legacyAccess: false, displayName: 'Coanfitrión',
  });
  const cookieJar = [
    roomCookie(host.token, host.session.sid).split(';')[0],
    roomCookie(attendee.token, attendee.session.sid).split(';')[0],
    roomCookie(cohost.token, cohost.session.sid).split(';')[0],
  ].join('; ');
  mockRoomService.participants = [
    { identity: host.session.identity, metadata: JSON.stringify({ meetingRole: 'HOST', meetingType: 'WEBINAR' }), permission: { canPublish: true }, tracks: [] },
    { identity: attendee.session.identity, metadata: JSON.stringify({ meetingRole: 'ATTENDEE', meetingType: 'WEBINAR' }), permission: { canPublish: false }, tracks: [] },
    { identity: cohost.session.identity, metadata: JSON.stringify({ meetingRole: 'COHOST', meetingType: 'WEBINAR' }), permission: { canPublish: true }, tracks: [] },
  ];
  mockRoomService.updates = [];
  const consent = await request('/api/room-session/consent', {
    method: 'POST', cookie: cookieJar, roomSessionId: attendee.session.sid, roomCsrf: attendee.session.csrf,
    body: { privacy: true, recording: false, transcription: false },
  });
  assert.equal(consent.response.status, 200, JSON.stringify(consent.data));
  const attendeeToken = await request('/api/token', { cookie: consent.cookie, roomSessionId: attendee.session.sid });
  assert.equal(attendeeToken.response.status, 200, JSON.stringify(attendeeToken.data));
  assert.deepEqual(attendeeToken.data.publishSources, []);
  const jwtPayload = JSON.parse(Buffer.from(attendeeToken.data.token.split('.')[1], 'base64url').toString('utf8'));
  assert.equal(jwtPayload.video.canPublish, false);
  assert.deepEqual(jwtPayload.video.canPublishSources || [], []);

  const escalated = await request('/api/participants/role', {
    method: 'POST', cookie: cookieJar, roomSessionId: attendee.session.sid, roomCsrf: attendee.session.csrf,
    body: { targetIdentity: host.session.identity, meetingRole: 'COHOST' },
  });
  assert.equal(escalated.response.status, 403);
  const primaryProtected = await request('/api/participants/role', {
    method: 'POST', cookie: cookieJar, roomSessionId: cohost.session.sid, roomCsrf: cohost.session.csrf,
    body: { targetIdentity: host.session.identity, meetingRole: 'ATTENDEE' },
  });
  assert.equal(primaryProtected.response.status, 409);
  assert.equal(primaryProtected.data.code, 'PRIMARY_ROLE_PROTECTED');
  const changed = await request('/api/participants/role', {
    method: 'POST', cookie: cookieJar, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { targetIdentity: attendee.session.identity, meetingRole: 'PANELIST' },
  });
  assert.equal(changed.response.status, 200, JSON.stringify(changed.data));
  assert.deepEqual(changed.data.publishSources.sort(), ['CAMERA', 'MICROPHONE', 'SCREEN_SHARE', 'SCREEN_SHARE_AUDIO'].sort());
  assert.ok(mockRoomService.updates.at(-1).update.permission.canPublishSources.length >= 4);
  assert.match(mockRoomService.updates.at(-1).update.metadata, /"meetingRole":"PANELIST"/);
  assert.equal((await rooms.participantAccess(meeting.room, attendee.session.identity)).meetingRole, 'PANELIST');

  const revoked = await request('/api/participants/permissions', {
    method: 'POST', cookie: cookieJar, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { targetIdentity: attendee.session.identity, source: 'screen', granted: false },
  });
  assert.equal(revoked.response.status, 200, JSON.stringify(revoked.data));
  assert.ok(revoked.data.publishSources.includes('MICROPHONE'));
  assert.ok(revoked.data.publishSources.includes('CAMERA'));
  assert.equal(revoked.data.publishSources.includes('SCREEN_SHARE'), false);
  assert.equal((await rooms.participantAccess(meeting.room, attendee.session.identity)).grants.screen, false);
  const degraded = await request('/api/participants/role', {
    method: 'POST', cookie: cookieJar, roomSessionId: host.session.sid, roomCsrf: host.session.csrf,
    body: { targetIdentity: attendee.session.identity, meetingRole: 'ATTENDEE' },
  });
  assert.equal(degraded.response.status, 200, JSON.stringify(degraded.data));
  assert.deepEqual(degraded.data.publishSources, []);
  assert.deepEqual((await rooms.participantAccess(meeting.room, attendee.session.identity)).grants, {});
  const events = await audit.listEvents({ room: meeting.room, limit: 100 });
  assert.ok(events.some((event) => event.action === 'PARTICIPANT_ROLE_CHANGED' && event.target === attendee.session.identity));
  assert.ok(events.some((event) => event.action === 'MEDIA_PERMISSION_REVOKED' && event.target === attendee.session.identity));
  mockRoomService.participants = [];
});

test('health diagnostics expose identity and availability without credentials', async () => {
  const health = await request('/health');
  assert.equal(health.response.status, 200);
  assert.equal(health.data.environment, 'test');
  assert.equal(health.data.status, 'healthy');
  assert.equal(typeof health.data.services.livekit.available, 'boolean');
  assert.ok(health.response.headers.get('x-request-id'));
  assert.doesNotMatch(JSON.stringify(health.data), /devkey|secret|apiKey|ws:\/\//i);
});

test('audit records actions without secret-like metadata', async () => {
  await audit.logEvent({
    actor: 'tester', action: 'USER_UPDATED', target: 'target', metadata: { role: 'VIEWER', password: 'must-not-persist', tokenValue: 'hidden' },
  });
  const events = await audit.listEvents({ actor: 'tester' });
  assert.equal(events.length, 1);
  assert.equal(events[0].metadata.role, 'VIEWER');
  assert.equal(events[0].metadata.password, undefined);
  assert.equal(events[0].metadata.tokenValue, undefined);
});

test('stable series access waits without LiveKit, enters only when live and advances to the next session', async () => {
  const admin = await login();
  const firstDate = new Date(Date.now() + 3 * 60 * 60_000).toISOString();
  const secondDate = new Date(Date.now() + 27 * 60 * 60_000).toISOString();
  const created = await request('/api/series', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: {
      title: `Ciclo estable ${Date.now()}`, trainerName: 'Ana Entrenadora', type: 'WEBINAR', timezone: 'America/Guayaquil', earlyAccessMinutes: 120,
      sessions: [{ scheduledAt: firstDate, durationMinutes: 45 }, { scheduledAt: secondDate, durationMinutes: 60 }],
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.sessions.length, 2);
  assert.notEqual(created.data.sessions[0].room, created.data.sessions[1].room);

  const accessResult = await request(`/api/series/${created.data.id}/accesses`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { participantName: 'María Participante', participantKey: 'maria-001' },
  });
  assert.equal(accessResult.response.status, 201, JSON.stringify(accessResult.data));
  const stableUrl = accessResult.data.access.url;
  const redeem = await request(new URL(stableUrl).pathname, { redirect: 'manual' });
  assert.equal(redeem.response.status, 303);
  assert.equal(redeem.response.headers.get('location'), '/series-access.html');
  assert.ok(redeem.cookie?.startsWith('rat_series_access='));

  const waiting = await request('/api/series-access', { cookie: redeem.cookie });
  assert.equal(waiting.response.status, 200, JSON.stringify(waiting.data));
  assert.equal(waiting.data.resolution.phase, 'UPCOMING');
  assert.equal(waiting.data.resolution.canEnter, false);
  const blocked = await request('/api/series-access/enter', { method: 'POST', cookie: redeem.cookie, seriesCsrf: waiting.data.csrfToken, body: {} });
  assert.equal(blocked.response.status, 409);
  assert.equal(blocked.data.code, 'MEETING_NOT_LIVE');

  await meetings.transitionMeeting(created.data.sessions[0].room, 'start', { livekitConfirmedAt: new Date().toISOString() });
  const live = await request('/api/series-access', { cookie: redeem.cookie });
  assert.equal(live.data.resolution.phase, 'LIVE');
  assert.equal(live.data.resolution.meeting.id, created.data.sessions[0].id);
  const consent = await request('/api/series-access/consent', {
    method: 'POST', cookie: redeem.cookie, seriesCsrf: live.data.csrfToken,
    body: { privacy: true, recording: true, transcription: true },
  });
  assert.equal(consent.response.status, 200, JSON.stringify(consent.data));
  const entered = await request('/api/series-access/enter', { method: 'POST', cookie: consent.cookie, seriesCsrf: consent.data.csrfToken, body: {} });
  assert.equal(entered.response.status, 200, JSON.stringify(entered.data));
  assert.match(entered.data.redirect, /^\/viewer\.html\?roomSession=/);

  const roomSessionId = new URL(entered.data.redirect, baseUrl).searchParams.get('roomSession');
  const roomCookies = entered.cookies.join('; ');
  const roomSession = await request('/api/room-session', { cookie: roomCookies, roomSessionId });
  assert.equal(roomSession.response.status, 200, JSON.stringify(roomSession.data));
  assert.equal(roomSession.data.seriesPrepared, true);
  const cancelledSeries = await request(`/api/series/${created.data.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { status: 'CANCELLED' },
  });
  assert.equal(cancelledSeries.response.status, 200, JSON.stringify(cancelledSeries.data));
  assert.equal(cancelledSeries.data.resolution.phase, 'UNAVAILABLE');
  const cancelledPublicAccess = await request('/api/series-access', { cookie: consent.cookie });
  assert.equal(cancelledPublicAccess.response.status, 410);
  assert.equal(cancelledPublicAccess.data.code, 'SERIES_NOT_JOINABLE');
  const cancelledRoomToken = await request('/api/token', { cookie: roomCookies, roomSessionId });
  assert.equal(cancelledRoomToken.response.status, 410);
  assert.equal(cancelledRoomToken.data.code, 'SERIES_NOT_JOINABLE');
  const restoredSeries = await request(`/api/series/${created.data.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { status: 'ACTIVE' },
  });
  assert.equal(restoredSeries.response.status, 200, JSON.stringify(restoredSeries.data));

  await meetings.transitionMeeting(created.data.sessions[0].room, 'complete');
  const advanced = await request('/api/series-access', { cookie: consent.cookie });
  assert.equal(advanced.data.resolution.meeting.id, created.data.sessions[1].id);
  const accesses = await request(`/api/series/${created.data.id}/accesses`, { cookie: admin.cookie });
  assert.equal(accesses.data.items[0].url, stableUrl);

  const forgedMeeting = await request('/api/meetings', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: {
      title: `ReuniÃ³n independiente ${Date.now()}`, room: `independent-${Date.now()}`, trainerName: 'Organizador',
      type: 'SESSION', status: 'SCHEDULED', scheduledAt: secondDate, seriesId: created.data.id, sessionNumber: 99,
    },
  });
  assert.equal(forgedMeeting.response.status, 201, JSON.stringify(forgedMeeting.data));
  assert.equal(forgedMeeting.data.seriesId, null);
  assert.equal(forgedMeeting.data.sessionNumber, null);
  const relinkAttempt = await request(`/api/meetings/${created.data.sessions[1].room}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { seriesId: forgedMeeting.data.id, sessionNumber: 99 },
  });
  assert.equal(relinkAttempt.response.status, 200, JSON.stringify(relinkAttempt.data));
  assert.equal(relinkAttempt.data.seriesId, created.data.id);
  assert.equal(relinkAttempt.data.sessionNumber, 2);
});

test('archiving a training series fully deactivates sessions and stable access without deleting history', async () => {
  mockEgressClient.reset();
  mockRoomService.deletedRooms = [];
  const admin = await login();
  const base = Date.now() + 6 * 60 * 60_000;
  const created = await request('/api/series', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: {
      title: `Ciclo desactivación ${Date.now()}`,
      trainerName: 'Operaciones RA',
      type: 'WEBINAR',
      timezone: 'America/Guayaquil',
      earlyAccessMinutes: 120,
      allowRecording: true,
      sessions: [0, 1, 2].map((offset) => ({ scheduledAt: new Date(base + offset * 60 * 60_000).toISOString(), durationMinutes: 45 })),
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));
  const [liveSession, futureSession, completedSession] = created.data.sessions;
  const draftSession = await meetings.createMeeting({
    title: `${created.data.title} · Borrador`,
    trainerName: 'Operaciones RA',
    type: 'WEBINAR',
    room: `serie-draft-archive-${Date.now()}`,
    scheduledAt: null,
    status: 'DRAFT',
    durationMinutes: 45,
    seriesId: created.data.id,
    sessionNumber: 4,
    createdBy: admin.user.username,
  });
  await rooms.createRoom(draftSession.room, { meetingId: draftSession.id });
  await meetings.transitionMeeting(liveSession.room, 'start', { livekitConfirmedAt: new Date().toISOString() });
  await meetings.transitionMeeting(completedSession.room, 'complete');
  const individual = await request(`/api/series/${created.data.id}/accesses`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { participantName: 'Acceso activo', participantKey: `archive-person-${Date.now()}` },
  });
  const general = await request(`/api/series/${created.data.id}/general-access`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(individual.response.status, 201, JSON.stringify(individual.data));
  assert.equal(general.response.status, 201, JSON.stringify(general.data));
  const invitation = await invitations.createInvitation({
    meetingId: futureSession.id,
    room: futureSession.room,
    role: 'VIEWER',
    meetingType: futureSession.type,
    createdBy: admin.user.username,
  });
  await audit.logEvent({ actor: 'system', action: 'RECORDING_STARTED', target: 'recording-history-kept', room: liveSession.room, metadata: { seriesId: created.data.id } });
  mockEgressClient.items.push(
    { egressId: 'archive-recording-egress', roomName: liveSession.room, status: 'EGRESS_ACTIVE', fileResults: [{}], request: { value: { file: {} } } },
    { egressId: 'archive-stream-egress', roomName: liveSession.room, status: 'EGRESS_STARTING', streamResults: [{}], request: { value: { streamOutputs: [{}] } } },
  );

  const archived = await request(`/api/series/${created.data.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { status: 'ARCHIVED' },
  });
  assert.equal(archived.response.status, 200, JSON.stringify(archived.data));
  assert.equal(archived.data.status, 'ARCHIVED');
  const archivedStatuses = Object.fromEntries(archived.data.sessions.map((session) => [session.room, session.status]));
  assert.equal(archivedStatuses[liveSession.room], 'ARCHIVED');
  assert.equal(archivedStatuses[futureSession.room], 'ARCHIVED');
  assert.equal(archivedStatuses[draftSession.room], 'ARCHIVED');
  assert.equal(archivedStatuses[completedSession.room], 'COMPLETED');
  assert.deepEqual(new Set(mockEgressClient.stops), new Set(['archive-recording-egress', 'archive-stream-egress']));
  assert.deepEqual(mockRoomService.deletedRooms, [liveSession.room]);
  assert.equal((await rooms.checkAccess(liveSession.room)).allowed, false);
  assert.equal((await rooms.checkAccess(futureSession.room)).allowed, false);
  await assert.rejects(() => meetings.transitionMeeting(futureSession.room, 'start'), (error) => error.code === 'MEETING_NOT_JOINABLE');
  const revokedIndividual = await request(new URL(individual.data.access.url).pathname, { redirect: 'manual' });
  const revokedGeneral = await request(new URL(general.data.access.url).pathname, { redirect: 'manual' });
  assert.equal(revokedIndividual.response.status, 410);
  assert.equal(revokedGeneral.response.status, 410);
  await assert.rejects(() => invitations.consumeInvitation(invitation.token), (error) => error.code === 'INVITATION_REVOKED');

  const stopCount = mockEgressClient.stops.length;
  const closeCount = mockRoomService.deletedRooms.length;
  const secondArchive = await request(`/api/series/${created.data.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { status: 'ARCHIVED' },
  });
  assert.equal(secondArchive.response.status, 200, JSON.stringify(secondArchive.data));
  assert.equal(mockEgressClient.stops.length, stopCount);
  assert.equal(mockRoomService.deletedRooms.length, closeCount);
  assert.equal((await audit.listEvents({ action: 'SERIES_ARCHIVED' })).filter((event) => event.target === created.data.id).length, 1);

  const restored = await request(`/api/series/${created.data.id}`, {
    method: 'PATCH', cookie: admin.cookie, csrf: admin.csrf, body: { status: 'ACTIVE' },
  });
  assert.equal(restored.response.status, 200, JSON.stringify(restored.data));
  assert.equal(restored.data.status, 'ACTIVE');
  const restoredStatuses = Object.fromEntries(restored.data.sessions.map((session) => [session.room, session.status]));
  assert.equal(restoredStatuses[liveSession.room], 'ARCHIVED');
  assert.equal(restoredStatuses[futureSession.room], 'SCHEDULED');
  assert.equal(restoredStatuses[draftSession.room], 'DRAFT');
  assert.equal(restoredStatuses[completedSession.room], 'COMPLETED');
  assert.equal((await request(new URL(individual.data.access.url).pathname, { redirect: 'manual' })).response.status, 410);
  await assert.rejects(() => invitations.consumeInvitation(invitation.token), (error) => error.code === 'INVITATION_REVOKED');
  assert.ok((await audit.listEvents({ room: liveSession.room, limit: 100 })).some((event) => event.target === 'recording-history-kept'));
  assert.equal((await audit.listEvents({ action: 'SERIES_RESTORED' })).filter((event) => event.target === created.data.id).length, 1);
});

test('one general series URL resolves three sessions and creates separate attendee identities', async () => {
  await auth.createUser({ username: 'general-admin', password: 'General-password-123', role: 'ADMIN' });
  const admin = await login('general-admin', 'General-password-123');
  const base = Date.now() + 60 * 60_000;
  const created = await request('/api/series', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: {
      title: `Ciclo general ${Date.now()}`, trainerName: 'Laura General', type: 'WEBINAR', timezone: 'America/Guayaquil', earlyAccessMinutes: 120,
      sessions: [0, 1, 2].map((offset) => ({ scheduledAt: new Date(base + offset * 86_400_000).toISOString(), durationMinutes: 45 })),
    },
  });
  assert.equal(created.response.status, 201, JSON.stringify(created.data));

  const general = await request(`/api/series/${created.data.id}/general-access`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  const recovered = await request(`/api/series/${created.data.id}/general-access`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(general.response.status, 201, JSON.stringify(general.data));
  assert.equal(recovered.response.status, 200, JSON.stringify(recovered.data));
  assert.equal(general.data.access.mode, 'GENERAL');
  assert.equal(general.data.access.meetingRole, 'ATTENDEE');
  assert.equal(recovered.data.access.url, general.data.access.url);
  assert.match(general.data.access.invitationMessage, /cada asistente debe ingresar su propio nombre visible/i);
  const generalAudit = (await audit.listEvents({ action: 'SERIES_ACCESS_CREATED' })).find((event) => event.target === general.data.access.id);
  assert.equal(generalAudit.metadata.mode, 'GENERAL');
  assert.doesNotMatch(JSON.stringify(generalAudit), /\/s\/[A-Za-z0-9._-]+/);

  const individual = await request(`/api/series/${created.data.id}/accesses`, {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: { participantName: 'Acceso Individual', participantKey: `individual-${Date.now()}` },
  });
  assert.equal(individual.response.status, 201, JSON.stringify(individual.data));
  assert.notEqual(individual.data.access.url, general.data.access.url);
  const listed = await request(`/api/series/${created.data.id}/accesses`, { cookie: admin.cookie });
  assert.equal(listed.data.items.filter((access) => access.mode === 'GENERAL' && access.status === 'ACTIVE').length, 1);
  assert.equal(listed.data.items.filter((access) => access.mode === 'INDIVIDUAL' && access.status === 'ACTIVE').length >= 1, true);

  const linkPath = new URL(general.data.access.url).pathname;
  async function prepareGeneralParticipant(displayName) {
    const redeemed = await request(linkPath, { redirect: 'manual' });
    assert.equal(redeemed.response.status, 303);
    assert.equal(redeemed.response.headers.get('location'), '/series-access.html');
    const access = await request('/api/series-access', { cookie: redeemed.cookie });
    assert.equal(access.data.access.mode, 'GENERAL');
    assert.equal(access.data.access.participantName, '');
    assert.equal(access.data.resolution.phase, 'WAITING');
    const profile = await request('/api/series-access/profile', {
      method: 'PATCH', cookie: redeemed.cookie, seriesCsrf: access.data.csrfToken, body: { displayName },
    });
    const consent = await request('/api/series-access/consent', {
      method: 'POST', cookie: profile.cookie, seriesCsrf: profile.data.csrfToken,
      body: { privacy: true, recording: false, transcription: false },
    });
    return consent.cookie;
  }

  const personASeriesCookie = await prepareGeneralParticipant('Persona A');
  const personBSeriesCookie = await prepareGeneralParticipant('Persona B');
  await meetings.transitionMeeting(created.data.sessions[0].room, 'start', { livekitConfirmedAt: new Date().toISOString() });

  const lateRedeem = await request(linkPath, { redirect: 'manual' });
  assert.equal(lateRedeem.response.status, 303);
  assert.match(lateRedeem.response.headers.get('location'), /^\/viewer\.html\?roomSession=/);
  const lateRoomSessionId = new URL(lateRedeem.response.headers.get('location'), baseUrl).searchParams.get('roomSession');
  const lateRoomCookies = lateRedeem.cookies.join('; ');
  const lateRoomSession = await request('/api/room-session', { cookie: lateRoomCookies, roomSessionId: lateRoomSessionId });
  assert.equal(lateRoomSession.response.status, 200, JSON.stringify(lateRoomSession.data));
  assert.equal(lateRoomSession.data.seriesPrepared, false);
  assert.equal(lateRoomSession.data.seriesId, created.data.id);
  assert.equal(lateRoomSession.data.consents, null);
  assert.equal(lateRoomSession.data.displayName, '');
  assert.equal(lateRoomSession.data.meetingRole, 'ATTENDEE');

  async function enterPreparedGeneralParticipant(displayName, seriesCookie) {
    const access = await request('/api/series-access', { cookie: seriesCookie });
    assert.equal(access.data.resolution.phase, 'LIVE');
    assert.equal(access.data.consents.privacy, true);
    const entered = await request('/api/series-access/enter', {
      method: 'POST', cookie: seriesCookie, seriesCsrf: access.data.csrfToken, body: {},
    });
    assert.equal(entered.response.status, 200, JSON.stringify(entered.data));
    const roomSessionId = new URL(entered.data.redirect, baseUrl).searchParams.get('roomSession');
    const roomCookies = entered.cookies.join('; ');
    const roomSession = await request('/api/room-session', { cookie: roomCookies, roomSessionId });
    assert.equal(roomSession.response.status, 200, JSON.stringify(roomSession.data));
    assert.equal(roomSession.data.seriesPrepared, true);
    assert.equal(roomSession.data.seriesId, created.data.id);
    const token = await request('/api/token', { cookie: roomCookies, roomSessionId });
    assert.equal(token.response.status, 200, JSON.stringify(token.data));
    mockRoomService.participants.push({ identity: roomSession.data.identity, name: displayName, metadata: '{}' });
    const joined = await request('/api/room/connection', {
      method: 'POST', cookie: roomCookies, roomSessionId, roomCsrf: roomSession.data.csrfToken, body: { event: 'joined' },
    });
    assert.equal(joined.response.status, 200, JSON.stringify(joined.data));
    return { seriesCookie, roomSession: roomSession.data };
  }

  const personA = await enterPreparedGeneralParticipant('Persona A', personASeriesCookie);
  const personB = await enterPreparedGeneralParticipant('Persona B', personBSeriesCookie);
  assert.notEqual(personA.roomSession.identity, personB.roomSession.identity);
  assert.equal(personA.roomSession.displayName, 'Persona A');
  assert.equal(personB.roomSession.displayName, 'Persona B');
  assert.equal(personA.roomSession.role, 'VIEWER');
  assert.equal(personB.roomSession.meetingRole, 'ATTENDEE');
  assert.equal(personB.roomSession.capabilities.canUsePresenterPanel, false);
  assert.equal(personB.roomSession.capabilities.canManageRoom, false);
  const attendanceResult = await request(`/api/series/${created.data.id}/attendance`, { cookie: admin.cookie });
  assert.deepEqual(attendanceResult.data.items.map((person) => person.participantName).sort(), ['Persona A', 'Persona B']);

  await meetings.transitionMeeting(created.data.sessions[0].room, 'complete');
  const sessionTwo = await request('/api/series-access', { cookie: personA.seriesCookie });
  assert.equal(sessionTwo.data.resolution.meeting.sessionNumber, 2);
  const movedDate = new Date(base + 5 * 86_400_000).toISOString();
  await meetings.transitionMeeting(created.data.sessions[1].room, 'reschedule', { scheduledAt: movedDate });
  const afterReschedule = await request(`/api/series/${created.data.id}/general-access`, { method: 'POST', cookie: admin.cookie, csrf: admin.csrf, body: {} });
  assert.equal(afterReschedule.data.access.url, general.data.access.url);
  await meetings.transitionMeeting(created.data.sessions[1].room, 'start', { livekitConfirmedAt: new Date().toISOString() });
  assert.equal((await request('/api/series-access', { cookie: personB.seriesCookie })).data.resolution.meeting.sessionNumber, 2);
  await meetings.transitionMeeting(created.data.sessions[1].room, 'complete');
  assert.equal((await request('/api/series-access', { cookie: personA.seriesCookie })).data.resolution.meeting.sessionNumber, 3);
  await meetings.transitionMeeting(created.data.sessions[2].room, 'start', { livekitConfirmedAt: new Date().toISOString() });
  assert.equal((await request('/api/series-access', { cookie: personB.seriesCookie })).data.resolution.meeting.sessionNumber, 3);
  await meetings.transitionMeeting(created.data.sessions[2].room, 'complete');
  const finished = await request('/api/series-access', { cookie: personA.seriesCookie });
  assert.equal(finished.data.resolution.phase, 'COMPLETED');
  assert.equal(finished.data.resolution.meeting, null);
});
