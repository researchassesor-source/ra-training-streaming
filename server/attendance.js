const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const db = require('./db');
const postgresStore = require('./db/postgres-store');
const locks = new Map();

function idFor(seriesId, meetingId, participantKey) { return `${seriesId}--${meetingId}--${participantKey}`; }
function keyFor(id) { return `attendance/${encodeURIComponent(id)}.json`; }
function stateInS3() { return storageConfigured && !localStore.usesPostgres(); }
async function write(record) {
  if (stateInS3()) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(record.id), Body: JSON.stringify(record), ContentType: 'application/json' }));
  else await localStore.writeJson('attendance', record.id, record);
  return record;
}
async function read(id) {
  if (!stateInS3()) return localStore.readJson('attendance', id);
  try { const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(id) })); return JSON.parse(await response.Body.transformToString()); }
  catch (error) { if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined; throw error; }
}
async function withLock(key, operation) {
  const previous = locks.get(key) || Promise.resolve(); let release;
  const current = new Promise((resolve) => { release = resolve; }); locks.set(key, current); await previous;
  try { return await localStore.withTransaction(operation); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

async function transactionalRead(id) {
  if (db.usingPostgres()) return postgresStore.readJson('attendance', id, localStore.currentClient(), { forUpdate: true });
  return read(id);
}

function eventTime(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function isOlderPresenceEvent(existing, at, type) {
  const previous = existing?.lastPresenceEventAt ? new Date(existing.lastPresenceEventAt).getTime() : 0;
  if (!previous) return false;
  const current = at.getTime();
  if (current < previous) return true;
  return current === previous && existing.lastPresenceEventType === type;
}

async function applyPresenceEvent({ type, seriesId, meetingId, sessionNumber, participantKey, participantIdentity, participantName, eventAt }) {
  if (!seriesId || !meetingId || !participantKey) return null;
  const id = idFor(seriesId, meetingId, participantKey);
  return withLock(id, async () => {
    const existing = await transactionalRead(id);
    const at = eventTime(eventAt);
    const now = at.toISOString();
    if (isOlderPresenceEvent(existing, at, type)) return existing;
    if (type === 'join') {
      return write({
        id, seriesId, meetingId, sessionNumber, participantKey,
        participantIdentity: participantIdentity || existing?.participantIdentity || null,
        participantName: participantName || existing?.participantName || 'Participante',
        firstJoinedAt: existing?.firstJoinedAt || now,
        lastJoinedAt: now,
        lastLeftAt: existing?.lastLeftAt || null,
        activeSince: existing?.activeSince || now,
        activeIdentity: participantIdentity || existing?.activeIdentity || existing?.participantIdentity || null,
        accumulatedMs: Number(existing?.accumulatedMs || 0),
        joinCount: Number(existing?.joinCount || 0) + (existing?.activeSince ? 0 : 1),
        lastPresenceEventAt: now,
        lastPresenceEventType: 'join',
        updatedAt: now,
      });
    }
    if (!existing) return null;
    const activeStart = existing.activeSince ? new Date(existing.activeSince).getTime() : null;
    const elapsed = Number.isFinite(activeStart) ? Math.max(0, at.getTime() - activeStart) : 0;
    return write({
      ...existing,
      participantIdentity: participantIdentity || existing.participantIdentity,
      participantName: participantName || existing.participantName,
      lastLeftAt: now,
      activeSince: null,
      activeIdentity: null,
      accumulatedMs: Number(existing.accumulatedMs || 0) + elapsed,
      lastPresenceEventAt: now,
      lastPresenceEventType: 'leave',
      updatedAt: now,
    });
  });
}

async function joined({ seriesId, meetingId, sessionNumber, participantKey, participantIdentity, participantName, eventAt }) {
  return applyPresenceEvent({ type: 'join', seriesId, meetingId, sessionNumber, participantKey, participantIdentity, participantName, eventAt });
}
async function left({ seriesId, meetingId, participantKey, participantIdentity, participantName, eventAt }) {
  return applyPresenceEvent({ type: 'leave', seriesId, meetingId, participantKey, participantIdentity, participantName, eventAt });
}

async function applyLiveKitEvent({ event, room, meeting, participantIdentity, participantKey, participantName, eventAt }) {
  if (!meeting?.seriesId || !participantKey) return null;
  if (event === 'participant_joined') {
    return joined({
      seriesId: meeting.seriesId,
      meetingId: meeting.id,
      sessionNumber: meeting.sessionNumber,
      participantKey,
      participantIdentity,
      participantName,
      eventAt,
    });
  }
  if (event === 'participant_left') {
    return left({
      seriesId: meeting.seriesId,
      meetingId: meeting.id,
      participantKey,
      participantIdentity,
      participantName,
      eventAt,
    });
  }
  return null;
}

async function getRecord({ seriesId, meetingId, participantKey }) {
  if (!seriesId || !meetingId || !participantKey) return null;
  return read(idFor(seriesId, meetingId, participantKey));
}

async function resetForTest({ seriesId, meetingId, participantKey }) {
  if (!seriesId || !meetingId || !participantKey) return false;
  return localStore.deleteJson('attendance', idFor(seriesId, meetingId, participantKey));
}
async function listSeriesAttendance(seriesId) {
  let items;
  if (stateInS3()) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'attendance/' }));
    items = await Promise.all((listing.Contents || []).map(async (object) => { const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key })); return JSON.parse(await response.Body.transformToString()); }));
  } else items = await localStore.listJson('attendance');
  return items.filter((item) => item.seriesId === seriesId).sort((a, b) => String(a.participantName).localeCompare(String(b.participantName)) || Number(a.sessionNumber) - Number(b.sessionNumber));
}
module.exports = { applyLiveKitEvent, getRecord, joined, left, listSeriesAttendance, resetForTest };
