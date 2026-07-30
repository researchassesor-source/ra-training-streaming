const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { config } = require('./config');

const KEY_PREFIX = 'room-configs/';
const CACHE_TTL_MS = 30_000;
const cache = new Map();
const admissionLocks = new Map();

function keyFor(room) {
  return `${KEY_PREFIX}${encodeURIComponent(room)}.json`;
}

async function persist(room, record) {
  if (storageConfigured) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: keyFor(room),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  } else {
    await localStore.writeJson('rooms', room, record);
  }
  cache.set(room, { config: record, expiresAt: Date.now() + CACHE_TTL_MS });
  return record;
}

async function createRoom(room, { meetingId = null, status = 'ACTIVE' } = {}) {
  const existing = await getRoom(room);
  return persist(room, {
    ...(existing || {}),
    room,
    meetingId,
    status,
    createdAt: existing?.createdAt || new Date().toISOString(),
    revokedAt: null,
    locked: existing?.locked === true,
    lockedAt: existing?.lockedAt || null,
    lockedBy: existing?.lockedBy || null,
    speakerGrants: existing?.speakerGrants && typeof existing.speakerGrants === 'object' ? existing.speakerGrants : {},
  });
}

async function getRoom(room) {
  const cached = cache.get(room);
  if (cached && cached.expiresAt > Date.now()) return cached.config;
  if (!storageConfigured) return localStore.readJson('rooms', room);
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(room) }));
    const record = JSON.parse(await response.Body.transformToString());
    cache.set(room, { config: record, expiresAt: Date.now() + CACHE_TTL_MS });
    return record;
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function checkAccess(room, { allowLocked = false } = {}) {
  try {
    const record = await getRoom(room);
    if (record?.status === 'ACTIVE' && !record.revokedAt) {
      if (record.locked && !allowLocked) return { allowed: false, reason: 'ROOM_LOCKED', room: record };
      return { allowed: true, room: record };
    }
    if (!record && config.allowOpenDevRooms) return { allowed: true, devOpenRoom: true };
    return { allowed: false, reason: record?.revokedAt ? 'ROOM_REVOKED' : 'ROOM_NOT_REGISTERED' };
  } catch (error) {
    if (config.allowOpenDevRooms) return { allowed: true, devOpenRoom: true, storageError: true };
    return { allowed: false, reason: 'ROOM_STORAGE_UNAVAILABLE' };
  }
}

async function setRoomLock(room, locked, actor) {
  return withAdmissionLock(room, async () => {
    const existing = await getRoom(room);
    if (!existing || existing.status !== 'ACTIVE' || existing.revokedAt) {
      throw new Error('La sala no está activa');
    }
    const now = new Date().toISOString();
    return persist(room, {
      ...existing,
      locked: Boolean(locked),
      lockedAt: locked ? now : null,
      lockedBy: locked ? String(actor || '').slice(0, 100) : null,
    });
  });
}

async function withAdmissionLock(room, operation) {
  const key = String(room);
  const previous = admissionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  admissionLocks.set(key, current);
  await previous;
  try { return await operation(); } finally {
    release();
    if (admissionLocks.get(key) === current) admissionLocks.delete(key);
  }
}

async function setSpeakerGrant(room, identity, granted, actor = '') {
  return withAdmissionLock(room, async () => {
    const existing = await getRoom(room);
    if (!existing || existing.status !== 'ACTIVE' || existing.revokedAt) throw new Error('La sala no está activa');
    const grants = { ...(existing.speakerGrants || {}) };
    if (granted) grants[identity] = { grantedAt: new Date().toISOString(), grantedBy: String(actor || '').slice(0, 100) };
    else delete grants[identity];
    return persist(room, { ...existing, speakerGrants: grants });
  });
}

async function hasSpeakerGrant(room, identity) {
  const existing = await getRoom(room);
  return Boolean(existing?.speakerGrants?.[identity]);
}

async function revokeRoom(room) {
  const existing = await getRoom(room);
  return persist(room, {
    ...(existing || { room, meetingId: null, createdAt: new Date().toISOString() }),
    status: 'REVOKED',
    revokedAt: new Date().toISOString(),
  });
}

module.exports = { checkAccess, createRoom, getRoom, hasSpeakerGrant, revokeRoom, setRoomLock, setSpeakerGrant, withAdmissionLock };
