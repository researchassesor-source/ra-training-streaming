const redis = require('./index');

async function acquire(key, ttlMs = 5_000) {
  return redis.acquireLock(key, ttlMs);
}

async function release(key, token) {
  return redis.releaseLock(key, token);
}

async function withLock(key, ttlMs, operation) {
  const token = await acquire(key, ttlMs);
  if (!token) return null;
  try {
    return await operation(token);
  } finally {
    await release(key, token).catch(() => null);
  }
}

module.exports = { acquire, release, withLock };
