const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');

const testDataDir = path.join(os.tmpdir(), `rat-training-series-${process.pid}-${Date.now()}`);
process.env.NODE_ENV = 'test';
process.env.LOCAL_DATA_DIR = testDataDir;
process.env.SESSION_SECRET = 'series-test-session-secret-with-32-characters';
process.env.INVITATION_HASH_SECRET = 'series-test-invitation-secret-with-32-characters';
process.env.APP_PUBLIC_URL = 'http://127.0.0.1:3000';
process.env.ADMIN_USERNAME = 'series-admin';
process.env.ADMIN_PASSWORD = 'Series-password-123';

const trainingSeries = require('../server/training-series');
const seriesAccesses = require('../server/series-accesses');
const { createSeriesSession } = require('../server/series-session');
const speakerRequests = require('../server/speaker-requests');
const attendance = require('../server/attendance');
const localStore = require('../server/local-store');
const meetings = require('../server/meetings');
const RATCore = require('../public/app-core');

test.before(async () => { await fs.rm(testDataDir, { recursive: true, force: true }); });
test.after(async () => { await fs.rm(testDataDir, { recursive: true, force: true }); });

test('a training series creates independent ordered meetings without changing legacy records', async () => {
  const base = Date.now() + 86_400_000;
  const created = await trainingSeries.createSeries({
    title: 'Liderazgo seguro', description: 'Tres encuentros', trainerName: 'Andrea Ruiz', type: 'SESSION', timezone: 'America/Guayaquil',
    earlyAccessMinutes: 120, createdBy: 'series-admin', sessions: [1, 2, 3].map((number) => ({ scheduledAt: new Date(base + number * 86_400_000).toISOString(), durationMinutes: 50 })),
  });
  assert.equal(created.sessions.length, 3);
  assert.equal(new Set(created.sessions.map((meeting) => meeting.room)).size, 3);
  assert.deepEqual(created.sessions.map((meeting) => meeting.sessionNumber), [1, 2, 3]);
  assert.ok(created.sessions.every((meeting) => meeting.seriesId === created.series.id));

  await localStore.writeJson('meetings', 'legacy-independent-room', { id: 'legacy-independent-id', room: 'legacy-independent-room', title: 'Reunión histórica', status: 'SCHEDULED' });
  const legacy = await meetings.getMeeting('legacy-independent-room');
  assert.equal(legacy.seriesId, null);
  assert.equal(legacy.sessionNumber, null);

  const zoned = await trainingSeries.createSeries({
    title: `Horario zonificado ${Date.now()}`, trainerName: 'Andrea Ruiz', type: 'SESSION', timezone: 'America/New_York',
    sessions: [{ scheduledLocal: '2026-08-11T10:00', durationMinutes: 50 }],
  });
  assert.equal(zoned.sessions[0].scheduledAt, '2026-08-11T14:00:00.000Z');
});

test('authoritative series resolution implements 2-hour waiting, live priority, cancellation and completion', () => {
  const now = new Date('2026-08-11T15:00:00.000Z');
  const series = { earlyAccessMinutes: 120, status: 'ACTIVE' };
  const future = { id: 'one', sessionNumber: 1, status: 'SCHEDULED', scheduledAt: '2026-08-11T18:01:00.000Z' };
  assert.equal(trainingSeries.resolveSeriesSession(series, [future], now).phase, 'UPCOMING');
  const waiting = { ...future, scheduledAt: '2026-08-11T16:30:00.000Z' };
  assert.equal(trainingSeries.resolveSeriesSession(series, [waiting], now).phase, 'WAITING');
  assert.equal(trainingSeries.resolveSeriesSession(series, [{ ...future, status: 'LIVE' }, waiting], now).meeting.id, 'one');
  const next = { id: 'two', sessionNumber: 2, status: 'SCHEDULED', scheduledAt: '2026-08-12T18:00:00.000Z' };
  assert.equal(trainingSeries.resolveSeriesSession(series, [{ ...future, status: 'CANCELLED' }, next], now).meeting.id, 'two');
  const cancelledSeries = trainingSeries.resolveSeriesSession({ ...series, status: 'CANCELLED' }, [{ ...future, status: 'LIVE' }], now);
  assert.equal(cancelledSeries.phase, 'UNAVAILABLE');
  assert.equal(cancelledSeries.meeting, null);
  assert.equal(cancelledSeries.canEnter, false);
  const completed = trainingSeries.resolveSeriesSession(series, [{ ...future, status: 'COMPLETED' }, { ...next, status: 'CANCELLED' }], now);
  assert.equal(completed.phase, 'COMPLETED');
  assert.equal(completed.canEnter, false);
});

test('individual series links are stable, hash-only and revoked independently', async () => {
  const series = { id: 'series-access-fixture', title: 'Ciclo privado', type: 'CLASS' };
  const ana = await seriesAccesses.createOrGetAccess({ series, participantName: 'Ana Pérez', participantKey: 'ana-01', createdBy: 'series-admin' });
  const reused = await seriesAccesses.createOrGetAccess({ series, participantName: 'Ana Pérez', participantKey: 'ana-01', createdBy: 'series-admin' });
  const carlos = await seriesAccesses.createOrGetAccess({ series, participantName: 'Carlos Paz', participantKey: 'carlos-01', createdBy: 'series-admin' });
  assert.equal(reused.reused, true);
  assert.equal(reused.token, ana.token);
  assert.notEqual(carlos.token, ana.token);
  const stored = await seriesAccesses.getAccess(ana.access.id);
  assert.equal(stored.token, undefined);
  assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
  assert.equal((await seriesAccesses.resolveToken(carlos.token)).participantKey, 'carlos-01');
  await seriesAccesses.revokeAccess(ana.access.id, series.id);
  await assert.rejects(() => seriesAccesses.resolveToken(ana.token), (error) => error.code === 'SERIES_ACCESS_REVOKED');
  assert.equal((await seriesAccesses.resolveToken(carlos.token)).status, 'ACTIVE');
  const regenerated = await seriesAccesses.regenerateAccess(ana.access.id, series, 'series-admin');
  assert.notEqual(regenerated.token, ana.token);
});

test('one general cycle link is stable while every browser receives a separate attendee identity', async () => {
  const series = { id: `series-general-${Date.now()}`, title: 'Ciclo para todo el grupo', type: 'WEBINAR' };
  const first = await seriesAccesses.createOrGetGeneralAccess({ series, createdBy: 'series-admin' });
  const recovered = await seriesAccesses.createOrGetGeneralAccess({ series, createdBy: 'series-admin' });
  assert.equal(recovered.reused, true);
  assert.equal(recovered.token, first.token);
  assert.equal(first.access.mode, 'GENERAL');
  assert.equal(first.access.meetingRole, 'ATTENDEE');
  const stored = await seriesAccesses.getAccess(first.access.id);
  assert.equal(stored.token, undefined);
  assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);

  const personA = createSeriesSession(first.access).session;
  const personB = createSeriesSession(first.access).session;
  assert.equal(personA.displayName, '');
  assert.equal(personB.displayName, '');
  assert.notEqual(personA.participantKey, personB.participantKey);
  assert.notEqual(personA.roomIdentity, personB.roomIdentity);
  assert.match(personA.roomIdentity, /^series-general-[a-f0-9-]{36}$/);

  const regenerated = await seriesAccesses.regenerateAccess(first.access.id, series, 'series-admin');
  assert.notEqual(regenerated.token, first.token);
  await assert.rejects(() => seriesAccesses.resolveToken(first.token), (error) => error.code === 'SERIES_ACCESS_REVOKED');
  assert.equal((await seriesAccesses.resolveToken(regenerated.token)).mode, 'GENERAL');
});

test('revocation cannot be undone by an in-flight access touch', async () => {
  const series = { id: `series-race-${Date.now()}`, title: 'Ciclo concurrente', type: 'WEBINAR' };
  const created = await seriesAccesses.createOrGetAccess({ series, participantName: 'Elena Mora', participantKey: `elena-${Date.now()}`, createdBy: 'series-admin' });
  const originalRead = localStore.readJson;
  let releaseRead;
  let markReadStarted;
  let blockNextRead = true;
  const readStarted = new Promise((resolve) => { markReadStarted = resolve; });
  const readGate = new Promise((resolve) => { releaseRead = resolve; });
  localStore.readJson = async (section, id) => {
    const record = await originalRead(section, id);
    if (blockNextRead && section === 'series-accesses' && id === created.access.id) {
      blockNextRead = false;
      markReadStarted();
      await readGate;
    }
    return record;
  };
  try {
    const touching = seriesAccesses.resolveToken(created.token, { touch: true });
    await readStarted;
    const revoking = seriesAccesses.revokeAccess(created.access.id, series.id);
    await new Promise((resolve) => setTimeout(resolve, 20));
    releaseRead();
    const [touchResult, revokeResult] = await Promise.allSettled([touching, revoking]);
    assert.equal(touchResult.status, 'fulfilled');
    assert.equal(revokeResult.status, 'fulfilled');
    assert.equal((await seriesAccesses.getAccess(created.access.id)).status, 'REVOKED');
    await assert.rejects(() => seriesAccesses.resolveToken(created.token), (error) => error.code === 'SERIES_ACCESS_REVOKED');
  } finally {
    localStore.readJson = originalRead;
    releaseRead();
  }
});

test('the exact same link advances through three sessions and survives rescheduling', async () => {
  const base = Date.now() + 4 * 60 * 60_000;
  const created = await trainingSeries.createSeries({
    title: `Continuidad ${Date.now()}`, trainerName: 'Laura Torres', type: 'WEBINAR', earlyAccessMinutes: 120,
    sessions: [0, 1, 2].map((offset) => ({ scheduledAt: new Date(base + offset * 86_400_000).toISOString(), durationMinutes: 45 })),
  });
  const stable = await seriesAccesses.createOrGetAccess({ series: created.series, participantName: 'Daniel Solís', participantKey: `daniel-${Date.now()}`, createdBy: 'series-admin' });
  const stableUrl = seriesAccesses.publicAccess(stable.access, { includeUrl: true }).url;
  const resolveWithSameToken = async () => {
    const access = await seriesAccesses.resolveToken(stable.token);
    assert.equal(access.id, stable.access.id);
    return trainingSeries.resolveSeriesSession(created.series, await trainingSeries.seriesSessions(created.series.id), new Date());
  };
  assert.equal((await resolveWithSameToken()).meeting.sessionNumber, 1);
  await meetings.transitionMeeting(created.sessions[0].room, 'complete');
  assert.equal((await resolveWithSameToken()).meeting.sessionNumber, 2);
  const movedDate = new Date(base + 4 * 86_400_000).toISOString();
  await meetings.transitionMeeting(created.sessions[1].room, 'reschedule', { scheduledAt: movedDate });
  assert.equal(seriesAccesses.publicAccess(await seriesAccesses.getAccess(stable.access.id), { includeUrl: true }).url, stableUrl);
  assert.equal((await meetings.getMeeting(created.sessions[1].room)).scheduledAt, movedDate);
  await meetings.transitionMeeting(created.sessions[1].room, 'complete');
  assert.equal((await resolveWithSameToken()).meeting.sessionNumber, 3);
  await meetings.transitionMeeting(created.sessions[2].room, 'complete');
  const finished = await resolveWithSameToken();
  assert.equal(finished.phase, 'COMPLETED');
  assert.equal(finished.meeting, null);
});

test('speaker requests and attendance survive refreshes without inventing presence', async () => {
  const request = await speakerRequests.requestSpeaker({ meetingId: 'meeting-1', room: 'room-series-1', participantIdentity: 'series-person-1', participantName: 'Ana' });
  assert.equal(request.status, 'PENDING');
  assert.equal((await speakerRequests.listRequests('room-series-1', { activeOnly: true }))[0].id, request.id);
  await speakerRequests.resolveSpeaker('room-series-1', 'series-person-1', 'GRANTED', 'host-1');
  assert.equal((await speakerRequests.listRequests('room-series-1', { activeOnly: true }))[0].status, 'GRANTED');
  await speakerRequests.resolveSpeaker('room-series-1', 'series-person-1', 'REVOKED', 'host-1');
  assert.equal((await speakerRequests.listRequests('room-series-1', { activeOnly: true })).length, 0);

  assert.equal(await attendance.joined({ seriesId: null, meetingId: 'meeting-1', participantKey: null }), null);
  assert.equal(await attendance.joined({ seriesId: 'series-attendance', meetingId: null, participantKey: 'ana-01' }), null);
  await attendance.joined({ seriesId: 'series-attendance', meetingId: 'meeting-1', sessionNumber: 1, participantKey: 'ana-01', participantIdentity: 'series-person-1', participantName: 'Ana' });
  await attendance.left({ seriesId: 'series-attendance', meetingId: 'meeting-1', participantKey: 'ana-01' });
  const records = await attendance.listSeriesAttendance('series-attendance');
  assert.equal(records.length, 1);
  assert.equal(records[0].joinCount, 1);
  assert.equal(records[0].activeSince, null);
  assert.ok(records[0].firstJoinedAt);

  const attendanceInput = { seriesId: 'series-attendance', meetingId: 'meeting-1', sessionNumber: 1, participantKey: 'ana-01', participantIdentity: 'series-person-1', participantName: 'Ana' };
  await attendance.joined(attendanceInput);
  await Promise.all([
    attendance.left(attendanceInput),
    attendance.joined(attendanceInput),
  ]);
  const reconnected = (await attendance.listSeriesAttendance('series-attendance')).find((item) => item.meetingId === 'meeting-1');
  assert.equal(reconnected.joinCount, 3);
  assert.ok(reconnected.activeSince);
  await attendance.left(attendanceInput);
  await attendance.joined({ ...attendanceInput, meetingId: 'meeting-2', sessionNumber: 2 });
  const separated = await attendance.listSeriesAttendance('series-attendance');
  assert.equal(separated.length, 2);
  assert.deepEqual(separated.map((item) => item.meetingId).sort(), ['meeting-1', 'meeting-2']);
});

test('waiting and dashboard contracts keep LiveKit behind explicit live entry', async () => {
  const [html, script, dashboard, dashboardHtml, roomUi, style] = await Promise.all([
    fs.readFile(path.join(__dirname, '..', 'public', 'series-access.html'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'public', 'series-access.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'public', 'room-ui.js'), 'utf8'),
    fs.readFile(path.join(__dirname, '..', 'public', 'style.css'), 'utf8'),
  ]);
  assert.doesNotMatch(html, /livekit-client(?:\.umd)?\.js/i);
  assert.doesNotMatch(script, /LivekitClient|\/api\/token/);
  assert.match(script, /\/api\/series-access\/enter/);
  assert.match(html, /No conectado/);
  assert.match(dashboard, /Compartir acceso/);
  assert.match(dashboardHtml, /data-copy-series="reminder2h"/);
  assert.match(dashboardHtml, /ACCESO GENERAL/);
  assert.match(dashboardHtml, /Crear o recuperar enlace general/);
  assert.match(dashboardHtml, /dashboard\.js\?v=general-access-result-fix/);
  assert.match(dashboardHtml, /id="seriesGeneralStatus"[^>]*role="status"/);
  assert.match(dashboardHtml, /id="seriesGeneralShareResult"[^>]*tabindex="-1"/);
  assert.match(dashboardHtml, /id="seriesShareError"[^>]*role="alert"[^>]*tabindex="-1"/);
  assert.match(dashboardHtml, /data-copy-series-general="reminder15m"/);
  assert.match(dashboardHtml, /ACCESO INDIVIDUAL/);
  assert.match(dashboard, /\/general-access/);
  assert.match(dashboard, /access\.mode !== 'GENERAL'/);
  assert.match(dashboard, /showGeneralSeriesShare\(result\.access, \{ reveal: true \}\)/);
  assert.match(dashboard, /scrollIntoView\(\{ behavior: 'smooth', block: 'nearest' \}\)/);
  assert.match(dashboard, /showSeriesShareError\(requestError\.message\)/);
  assert.match(html, /privacy-consent-option[^>]*>[\s\S]*?type="checkbox" required[^>]*>[\s\S]*?He leído el aviso de privacidad y acepto participar\./);
  assert.match(script, /button\.disabled = !document\.getElementById\('privacyConsent'\)\.checked \|\| !validName/);
  assert.match(style, /\.privacy-consent-option input[^}]*appearance: none/);
  assert.match(style, /\.privacy-consent-option input:checked::after[^}]*content: '\\2713'/);
  assert.match(roomUi, /syncSpeakerRequests/);
  assert.match(roomUi, /temporarySpeaker/);
  assert.match(roomUi, /function showWordGrantNotice\(\)/);
  assert.match(roomUi, /previousTemporaryMicrophone === false && temporaryMicrophone/);
  const queue = new RATCore.HandQueue();
  queue.replace([{ identity: 'one', displayName: 'Uno', status: 'GRANTED', raisedAt: '2026-08-11T10:00:00.000Z' }]);
  assert.deepEqual(queue.list().map((item) => [item.identity, item.status, item.order]), [['one', 'GRANTED', 1]]);
});
