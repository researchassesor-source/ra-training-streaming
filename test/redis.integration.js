const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const redis = require('../server/redis');
const { createRateLimiter } = require('../server/rate-limit');

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function callLimiter(limiter, key) {
  const req = { ip: key };
  const res = fakeResponse();
  let allowed = false;
  await limiter(req, res, () => { allowed = true; });
  return { allowed, res };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupRunKeys(runKey) {
  const client = redis.getClient();
  if (!client?.isOpen) return;
  await client.del([
    redis.namespacedKey(['rate-limit', `${runKey}:counter`]),
    redis.namespacedKey(['rate-limit', `${runKey}:user`]),
    redis.namespacedKey(['lock', `${runKey}:lock`]),
    redis.namespacedKey(['lock', `${runKey}:ttl`]),
  ]);
}

test.after(async () => {
  await redis.disconnect();
});

test('Redis shared counter, distributed rate limit and safe locks work with one backend', async () => {
  assert.equal(await redis.ping(), true);
  const runKey = `redis-${crypto.randomUUID()}`;
  try {
    const first = await redis.incrementWindow(`${runKey}:counter`, 5_000);
    const second = await redis.incrementWindow(`${runKey}:counter`, 5_000);
    assert.equal(first.count, 1);
    assert.equal(second.count, 2);

    const limiterA = createRateLimiter({ windowMs: 5_000, max: 2, key: () => `${runKey}:user` });
    const limiterB = createRateLimiter({ windowMs: 5_000, max: 2, key: () => `${runKey}:user` });
    assert.equal((await callLimiter(limiterA, runKey)).allowed, true);
    assert.equal((await callLimiter(limiterB, runKey)).allowed, true);
    const limited = await callLimiter(limiterA, runKey);
    assert.equal(limited.allowed, false);
    assert.equal(limited.res.statusCode, 429);

    const token = await redis.acquireLock(`${runKey}:lock`, 5_000);
    assert.ok(token);
    assert.equal(await redis.acquireLock(`${runKey}:lock`, 5_000), null);
    assert.equal(await redis.releaseLock(`${runKey}:lock`, 'not-owner'), false);
    assert.equal(await redis.acquireLock(`${runKey}:lock`, 5_000), null);
    assert.equal(await redis.releaseLock(`${runKey}:lock`, token), true);

    const expiring = await redis.acquireLock(`${runKey}:ttl`, 150);
    assert.ok(expiring);
    let reacquired = null;
    const deadline = Date.now() + 2_000;
    while (!reacquired && Date.now() < deadline) {
      await sleep(50);
      reacquired = await redis.acquireLock(`${runKey}:ttl`, 1_000);
    }
    assert.ok(reacquired);
  } finally {
    await cleanupRunKeys(runKey);
  }
});
