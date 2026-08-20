const { createClient } = require('redis');
const crypto = require('crypto');
const { config } = require('../config');

let client;
let connecting;
let lastError = null;

function hasRedis() {
  return Boolean(process.env.REDIS_URL);
}

function keyPrefix() {
  const app = String(config.appName || 'ra-training-streaming').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'ra-training-streaming';
  const env = String(config.appEnv || 'development').toLowerCase().replace(/[^a-z0-9-]+/g, '-') || 'development';
  return `${app}:${env}`;
}

function namespacedKey(parts) {
  const suffix = Array.isArray(parts) ? parts.join(':') : String(parts);
  return `${keyPrefix()}:${suffix}`;
}

function getClient() {
  if (!hasRedis()) return null;
  if (client) return client;
  client = createClient({
    url: process.env.REDIS_URL,
    socket: { reconnectStrategy: (retries) => Math.min(1_000, 50 * retries) },
  });
  client.on('error', (error) => {
    lastError = { name: error.name, message: error.message };
  });
  return client;
}

async function connect() {
  const redisClient = getClient();
  if (!redisClient) return false;
  if (redisClient.isOpen) return true;
  if (!connecting) {
    connecting = redisClient.connect().finally(() => {
      connecting = null;
    });
  }
  await connecting;
  return true;
}

async function disconnect() {
  if (!client) return;
  const current = client;
  client = null;
  connecting = null;
  if (current.isOpen) await current.quit().catch(() => current.disconnect());
}

async function ping() {
  await connect();
  if (!client) return false;
  return (await client.ping()) === 'PONG';
}

const RATE_LIMIT_SCRIPT = `
local current = redis.call('INCR', KEYS[1])
if current == 1 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
end
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return { current, ttl }
`;

async function incrementWindow(key, windowMs) {
  const redisClient = getClient();
  if (!redisClient) return null;
  await connect();
  const result = await redisClient.eval(RATE_LIMIT_SCRIPT, {
    keys: [namespacedKey(['rate-limit', key])],
    arguments: [String(windowMs)],
  });
  return { count: Number(result[0]), ttlMs: Number(result[1]) };
}

async function acquireLock(key, ttlMs) {
  const redisClient = getClient();
  if (!redisClient) return null;
  await connect();
  const token = crypto.randomUUID();
  const result = await redisClient.set(namespacedKey(['lock', key]), token, { NX: true, PX: ttlMs });
  return result === 'OK' ? token : null;
}

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

async function releaseLock(key, token) {
  const redisClient = getClient();
  if (!redisClient || !token) return false;
  await connect();
  const result = await redisClient.eval(RELEASE_LOCK_SCRIPT, {
    keys: [namespacedKey(['lock', key])],
    arguments: [String(token)],
  });
  return Number(result) === 1;
}

function diagnostics() {
  return {
    configured: hasRedis(),
    connected: Boolean(client?.isOpen),
    lastError,
  };
}

module.exports = {
  acquireLock,
  connect,
  diagnostics,
  disconnect,
  getClient,
  hasRedis,
  incrementWindow,
  keyPrefix,
  namespacedKey,
  ping,
  releaseLock,
};
