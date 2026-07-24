// Room access registry, persisted as small JSON objects in the same R2/S3
// bucket used for recordings — avoids standing up a separate database for
// something this small. Falls back to "rooms are open" if storage isn't
// configured (e.g. local dev without S3 credentials).
const { PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');

const KEY_PREFIX = 'room-configs/';
const CACHE_TTL_MS = 30_000;
const cache = new Map(); // room -> { config, expiresAt }

function keyFor(room) {
  return `${KEY_PREFIX}${encodeURIComponent(room)}.json`;
}

async function createRoom(room, { hostCode, viewerPassword } = {}) {
  const config = {
    hostCode: hostCode ? String(hostCode) : null,
    viewerPassword: viewerPassword ? String(viewerPassword) : null,
    createdAt: Date.now(),
  };

  if (storageConfigured) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: keyFor(room),
        Body: JSON.stringify(config),
        ContentType: 'application/json',
      })
    );
  }
  cache.set(room, { config, expiresAt: Date.now() + CACHE_TTL_MS });
  return config;
}

async function getRoom(room) {
  const cached = cache.get(room);
  if (cached && cached.expiresAt > Date.now()) return cached.config;

  if (!storageConfigured) return undefined;

  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(room) }));
    const body = await res.Body.transformToString();
    const config = JSON.parse(body);
    cache.set(room, { config, expiresAt: Date.now() + CACHE_TTL_MS });
    return config;
  } catch (err) {
    if (err.name === 'NoSuchKey' || err.$metadata?.httpStatusCode === 404) {
      cache.set(room, { config: undefined, expiresAt: Date.now() + CACHE_TTL_MS });
      return undefined;
    }
    console.error('rooms/getRoom error', err);
    return undefined; // fail open rather than lock everyone out on a storage hiccup
  }
}

// Rooms that were never explicitly created (or created with no codes) stay
// open, so the simple "type a room name and join" flow keeps working.
async function checkAccess(room, role, suppliedCode) {
  const config = await getRoom(room);
  if (!config) return { allowed: true };

  const requiredCode = role === 'presenter' ? config.hostCode : config.viewerPassword;
  if (!requiredCode) return { allowed: true };
  if (suppliedCode && suppliedCode === requiredCode) return { allowed: true };
  return { allowed: false, requiresCode: true };
}

module.exports = { createRoom, getRoom, checkAccess };
