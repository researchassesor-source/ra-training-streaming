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
const { createRoomSession, roomCookie } = require('../server/room-session');
const { createApp } = require('../server/app');

const mockRoomService = {
  participants: [],
  sentData: [],
  async listParticipants() { return this.participants; },
  async updateParticipant() {},
  async removeParticipant() {},
  async mutePublishedTrack() {},
  async deleteRoom() {},
  async sendData(room, data, kind, options) { this.sentData.push({ room, data: JSON.parse(Buffer.from(data).toString('utf8')), kind, options }); },
};
const mockEgressClient = {
  async listEgress() { return []; },
  async stopEgress() {},
  async startRoomCompositeEgress() { return { egressId: 'egress-test' }; },
};
let mockLivekitAvailable = true;

let server;
let baseUrl;

async function request(route, { method = 'GET', body, cookie, csrf, roomCsrf, redirect = 'follow' } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (csrf) headers['X-CSRF-Token'] = csrf;
  if (roomCsrf) headers['X-Room-CSRF'] = roomCsrf;
  const response = await fetch(`${baseUrl}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect,
  });
  let data = null;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('application/json')) data = await response.json();
  return { response, data, cookie: response.headers.get('set-cookie')?.split(';')[0] || null };
}

async function login(username = 'rootadmin', password = 'Bootstrap-password-123') {
  const result = await request('/api/auth/login', { method: 'POST', body: { username, password } });
  assert.equal(result.response.status, 200, JSON.stringify(result.data));
  return { cookie: result.cookie, csrf: result.data.csrfToken, user: result.data.user };
}

test.before(async () => {
  await fs.rm(testDataDir, { recursive: true, force: true });
  const app = createApp({
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
});

test('room access fails closed unless explicitly configured', async () => {
  const missing = await rooms.checkAccess('missing-room');
  assert.equal(missing.allowed, false);
  await rooms.createRoom('registered-room', { meetingId: 'meeting-id' });
  assert.equal((await rooms.checkAccess('registered-room')).allowed, true);
  await rooms.revokeRoom('registered-room');
  assert.equal((await rooms.checkAccess('registered-room')).allowed, false);
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

test('invitation redemption removes the token from the URL and creates a room cookie', async () => {
  const admin = await login();
  const invitation = await request('/api/meetings/api-meeting/invitations', {
    method: 'POST', cookie: admin.cookie, csrf: admin.csrf,
    body: { role: 'VIEWER', singleUse: true, expiresInMinutes: 60 },
  });
  assert.equal(invitation.response.status, 201, JSON.stringify(invitation.data));
  assert.match(invitation.data.path, /^\/i\/[A-Za-z0-9_-]{40,}$/);
  const redemption = await request(invitation.data.path, { redirect: 'manual' });
  assert.equal(redemption.response.status, 303);
  assert.equal(redemption.response.headers.get('location'), '/viewer.html');
  assert.match(redemption.response.headers.get('set-cookie'), /rat_room_session=.*HttpOnly/i);
  const reused = await request(invitation.data.path, { redirect: 'manual' });
  assert.equal(reused.response.status, 410);
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
