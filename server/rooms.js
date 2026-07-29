const { GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { config } = require('./config');

const KEY_PREFIX = 'room-configs/';
const CACHE_TTL_MS = 30_000;
const cache = new Map();

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
  return persist(room, {
    room,
    meetingId,
    status,
    createdAt: new Date().toISOString(),
    revokedAt: null,
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

async function checkAccess(room) {
  try {
    const record = await getRoom(room);
    if (record?.status === 'ACTIVE' && !record.revokedAt) return { allowed: true, room: record };
    if (!record && config.allowOpenDevRooms) return { allowed: true, devOpenRoom: true };
    return { allowed: false, reason: record?.revokedAt ? 'ROOM_REVOKED' : 'ROOM_NOT_REGISTERED' };
  } catch (error) {
    if (config.allowOpenDevRooms) return { allowed: true, devOpenRoom: true, storageError: true };
    return { allowed: false, reason: 'ROOM_STORAGE_UNAVAILABLE' };
  }
}

async function revokeRoom(room) {
  const existing = await getRoom(room);
  return persist(room, {
    ...(existing || { room, meetingId: null, createdAt: new Date().toISOString() }),
    status: 'REVOKED',
    revokedAt: new Date().toISOString(),
  });
}

module.exports = { checkAccess, createRoom, getRoom, revokeRoom };
