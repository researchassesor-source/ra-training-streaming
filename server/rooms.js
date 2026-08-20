const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { config } = require('./config');
const redis = require('./redis');
const distributedLock = require('./redis/distributed-lock');
const { AppError } = require('./http-utils');

const KEY_PREFIX = 'room-configs/';
const CACHE_TTL_MS = 30_000;
const cache = new Map();
const admissionLocks = new Map();

function keyFor(room) {
  return `${KEY_PREFIX}${encodeURIComponent(room)}.json`;
}

function stateInS3() {
  return storageConfigured && !localStore.usesPostgres();
}

async function persist(room, record) {
  if (stateInS3()) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: keyFor(room),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  } else {
    await localStore.writeJson('rooms', room, record);
  }
  if (!localStore.usesPostgres()) cache.set(room, { config: record, expiresAt: Date.now() + CACHE_TTL_MS });
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
    mediaGrants: existing?.mediaGrants && typeof existing.mediaGrants === 'object' ? existing.mediaGrants : {},
    roleOverrides: existing?.roleOverrides && typeof existing.roleOverrides === 'object' ? existing.roleOverrides : {},
  });
}

async function getRoom(room) {
  const cached = localStore.usesPostgres() ? null : cache.get(room);
  if (cached && cached.expiresAt > Date.now()) return cached.config;
  if (!stateInS3()) return localStore.readJson('rooms', room);
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(room) }));
    const record = JSON.parse(await response.Body.transformToString());
    if (!localStore.usesPostgres()) cache.set(room, { config: record, expiresAt: Date.now() + CACHE_TTL_MS });
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
  if (redis.hasRedis()) {
    const token = await distributedLock.acquire(`room-admission:${key}`, 5_000);
    if (!token) throw new AppError(409, 'Otra operación está actualizando la sala. Intenta nuevamente.', 'ROOM_CONCURRENT_UPDATE');
    try { return await localStore.withTransaction(operation); } finally {
      await distributedLock.release(`room-admission:${key}`, token).catch(() => null);
    }
  }
  const previous = admissionLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  admissionLocks.set(key, current);
  await previous;
  try { return await localStore.withTransaction(operation); } finally {
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
    const mediaGrants = { ...(existing.mediaGrants || {}) };
    const current = { ...(mediaGrants[identity] || {}) };
    if (granted) mediaGrants[identity] = { ...current, microphone: true, updatedAt: new Date().toISOString(), updatedBy: String(actor || '').slice(0, 100) };
    else {
      delete current.microphone;
      if (Object.keys(current).filter((key) => !['updatedAt', 'updatedBy'].includes(key)).length) mediaGrants[identity] = current;
      else delete mediaGrants[identity];
    }
    return persist(room, { ...existing, speakerGrants: grants, mediaGrants });
  });
}

async function hasSpeakerGrant(room, identity) {
  const existing = await getRoom(room);
  return Boolean(existing?.speakerGrants?.[identity]);
}

async function participantAccess(room, identity) {
  const existing = await getRoom(room);
  return {
    grants: existing?.mediaGrants?.[identity] || {},
    meetingRole: existing?.roleOverrides?.[identity]?.meetingRole || null,
  };
}

async function setMediaGrant(room, identity, source, granted, actor = '') {
  if (!['microphone', 'camera', 'screen'].includes(source)) throw new Error('Fuente multimedia no válida');
  return withAdmissionLock(room, async () => {
    const existing = await getRoom(room);
    if (!existing || existing.status !== 'ACTIVE' || existing.revokedAt) throw new Error('La sala no está activa');
    const mediaGrants = { ...(existing.mediaGrants || {}) };
    const current = { ...(mediaGrants[identity] || {}) };
    current[source] = granted === true;
    mediaGrants[identity] = { ...current, updatedAt: new Date().toISOString(), updatedBy: String(actor || '').slice(0, 100) };
    const speakerGrants = { ...(existing.speakerGrants || {}) };
    if (source === 'microphone') {
      if (granted) speakerGrants[identity] = { grantedAt: new Date().toISOString(), grantedBy: String(actor || '').slice(0, 100) };
      else delete speakerGrants[identity];
    }
    return persist(room, { ...existing, mediaGrants, speakerGrants });
  });
}

async function setParticipantRole(room, identity, meetingRole, actor = '') {
  return withAdmissionLock(room, async () => {
    const existing = await getRoom(room);
    if (!existing || existing.status !== 'ACTIVE' || existing.revokedAt) throw new Error('La sala no está activa');
    const roleOverrides = { ...(existing.roleOverrides || {}) };
    const speakerGrants = { ...(existing.speakerGrants || {}) };
    const mediaGrants = { ...(existing.mediaGrants || {}) };
    if (meetingRole) roleOverrides[identity] = { meetingRole, updatedAt: new Date().toISOString(), updatedBy: String(actor || '').slice(0, 100) };
    else delete roleOverrides[identity];
    // A role transition always starts from the new role's least-privilege policy.
    // Temporary grants from the previous role must never survive a demotion.
    delete speakerGrants[identity];
    delete mediaGrants[identity];
    return persist(room, { ...existing, roleOverrides, speakerGrants, mediaGrants });
  });
}

async function clearParticipantAccess(room, identity) {
  return withAdmissionLock(room, async () => {
    const existing = await getRoom(room);
    if (!existing) return existing;
    const speakerGrants = { ...(existing.speakerGrants || {}) };
    const mediaGrants = { ...(existing.mediaGrants || {}) };
    const roleOverrides = { ...(existing.roleOverrides || {}) };
    delete speakerGrants[identity];
    delete mediaGrants[identity];
    delete roleOverrides[identity];
    return persist(room, { ...existing, speakerGrants, mediaGrants, roleOverrides });
  });
}

async function revokeRoom(room) {
  const existing = await getRoom(room);
  return persist(room, {
    ...(existing || { room, meetingId: null, createdAt: new Date().toISOString() }),
    status: 'REVOKED',
    revokedAt: new Date().toISOString(),
  });
}

module.exports = {
  checkAccess,
  clearParticipantAccess,
  createRoom,
  getRoom,
  hasSpeakerGrant,
  participantAccess,
  revokeRoom,
  setMediaGrant,
  setParticipantRole,
  setRoomLock,
  setSpeakerGrant,
  withAdmissionLock,
};
