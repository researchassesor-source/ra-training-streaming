const crypto = require('crypto');
const db = require('./db');
const localStore = require('./local-store');
const { AppError } = require('./http-utils');

const memory = new Map();

function normalizeKey(value) {
  const key = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{8,160}$/.test(key) ? key : '';
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function requestHash({ method, path, body }) {
  return crypto.createHash('sha256').update(`${method}\n${path}\n${stableJson(body || {})}`).digest('hex');
}

function scopeFor(req, action) {
  const actor = req.auth?.u || req.roomSession?.identity || req.ip || 'anonymous';
  return `${actor}:${req.method}:${action}`;
}

async function runMemory({ scope, key, hash, operation }) {
  const composite = `${scope}:${key}`;
  const existing = memory.get(composite);
  if (existing) {
    if (existing.hash !== hash) throw new AppError(409, 'Idempotency-Key reutilizada con un payload diferente', 'IDEMPOTENCY_CONFLICT');
    return existing.promise;
  }
  const promise = Promise.resolve().then(operation);
  memory.set(composite, { hash, promise, expiresAt: Date.now() + 24 * 60 * 60_000 });
  try {
    return await promise;
  } finally {
    if (memory.size > 5_000) {
      const now = Date.now();
      for (const [entryKey, entry] of memory) if (entry.expiresAt <= now) memory.delete(entryKey);
    }
  }
}

async function runPostgres({ scope, key, hash, actor, operation, ttlMs = 24 * 60 * 60_000 }) {
  return localStore.withTransaction(async () => {
    const client = localStore.currentClient();
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const inserted = await client.query(
      `INSERT INTO idempotency_keys (scope, key, actor, request_hash, status, expires_at)
       VALUES ($1, $2, $3, $4, 'PROCESSING', $5)
       ON CONFLICT DO NOTHING`,
      [scope, key, actor, hash, expiresAt]
    );

    if (inserted.rowCount === 0) {
      const existing = await client.query(
        `SELECT request_hash, status, response_status, response_body
         FROM idempotency_keys
         WHERE scope = $1 AND key = $2
         FOR UPDATE`,
        [scope, key]
      );
      const row = existing.rows[0];
      if (!row) throw new AppError(409, 'No fue posible resolver la operación idempotente', 'IDEMPOTENCY_STATE_CONFLICT');
      if (row.request_hash !== hash) throw new AppError(409, 'Idempotency-Key reutilizada con un payload diferente', 'IDEMPOTENCY_CONFLICT');
      if (row.status === 'COMPLETED') return { status: row.response_status, body: row.response_body, replayed: true };
    }

    const result = await operation();
    await client.query(
      `UPDATE idempotency_keys
       SET status = 'COMPLETED', response_status = $3, response_body = $4::jsonb, updated_at = now()
       WHERE scope = $1 AND key = $2`,
      [scope, key, result.status || 200, JSON.stringify(result.body || {})]
    );
    return result;
  });
}

async function runHttp(req, action, operation) {
  const key = normalizeKey(req.headers['idempotency-key']);
  if (!key || req.method === 'GET') return operation();
  const scope = scopeFor(req, action);
  const hash = requestHash({ method: req.method, path: req.route?.path || req.path, body: req.body });
  const actor = req.auth?.u || req.roomSession?.identity || req.ip || 'anonymous';
  if (db.usingPostgres()) return runPostgres({ scope, key, hash, actor, operation });
  return runMemory({ scope, key, hash, operation });
}

function resetMemory() {
  memory.clear();
}

module.exports = {
  normalizeKey,
  requestHash,
  resetMemory,
  runHttp,
  stableJson,
};
