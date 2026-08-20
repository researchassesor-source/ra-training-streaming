const crypto = require('node:crypto');
const os = require('node:os');
const db = require('./db');
const localStore = require('./local-store');
const { config } = require('./config');
const { AppError, sanitizeText } = require('./http-utils');
const { classifyProviderError, safeMessage } = require('./provider-errors');

const ACTIVE_STATUSES = new Set(['QUEUED', 'RUNNING', 'RETRY_WAIT']);
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);
const memoryJobs = new Map();

function workerId(prefix = 'worker') {
  return `${prefix}-${os.hostname()}-${process.pid}-${crypto.randomUUID()}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sanitizePayload(value) {
  if (Array.isArray(value)) return value.map(sanitizePayload);
  if (!value || typeof value !== 'object') return value;
  const clean = {};
  for (const [key, entry] of Object.entries(value)) {
    if (/password|secret|token|authorization|api.?key|stream.?key|signed.?url|database.?url|redis.?url/i.test(key)) continue;
    clean[key] = sanitizePayload(entry);
  }
  return clean;
}

function publicJob(row) {
  if (!row) return null;
  const data = row.data || row;
  return {
    id: data.id,
    type: data.type,
    status: data.status,
    dedupeKey: data.dedupe_key || data.dedupeKey || null,
    attempts: Number(data.attempts || 0),
    maxAttempts: Number(data.max_attempts || data.maxAttempts || 0),
    availableAt: data.available_at || data.availableAt || null,
    lockedBy: data.locked_by || data.lockedBy || null,
    leaseExpiresAt: data.lease_expires_at || data.leaseExpiresAt || null,
    lastErrorCode: data.last_error_code || data.lastErrorCode || null,
    lastErrorMessage: data.last_error_message || data.lastErrorMessage || null,
    createdAt: data.created_at || data.createdAt || null,
    updatedAt: data.updated_at || data.updatedAt || null,
    completedAt: data.completed_at || data.completedAt || null,
    failedAt: data.failed_at || data.failedAt || null,
    cancelledAt: data.cancelled_at || data.cancelledAt || null,
    payload: data.payload || {},
    payloadVersion: Number(data.payload_version || data.payloadVersion || 1),
    priority: Number(data.priority || 0),
  };
}

function rowToJob(row) {
  if (!row) return null;
  return publicJob(row);
}

function clientOrPool(client) {
  return client || localStore.currentClient() || db.getPool();
}

async function withMaybeTransaction(callback) {
  if (!db.usingPostgres()) return callback();
  if (localStore.currentClient()) return callback(localStore.currentClient());
  return db.transaction(callback);
}

async function enqueue({ type, payload = {}, dedupeKey = null, priority = 0, maxAttempts = 5, availableAt = null, payloadVersion = 1 }, client) {
  const safeType = sanitizeText(type, { field: 'jobType', min: 3, max: 100, required: true });
  const safeDedupe = dedupeKey ? sanitizeText(dedupeKey, { field: 'dedupeKey', min: 3, max: 240 }) : null;
  const safePayload = sanitizePayload(payload || {});
  if (!db.usingPostgres()) {
    if (safeDedupe) {
      const existing = [...memoryJobs.values()].find((job) => job.dedupeKey === safeDedupe && ACTIVE_STATUSES.has(job.status));
      if (existing) return { job: publicJob(existing), created: false };
    }
    const job = {
      id: crypto.randomUUID(), type: safeType, status: 'QUEUED', payload: safePayload, dedupeKey: safeDedupe,
      priority: Number(priority) || 0, attempts: 0, maxAttempts: Math.max(1, Number(maxAttempts) || 5),
      availableAt: availableAt || nowIso(), createdAt: nowIso(), updatedAt: nowIso(), payloadVersion: Math.max(1, Number(payloadVersion) || 1),
    };
    memoryJobs.set(job.id, job);
    return { job: publicJob(job), created: true };
  }
  return withMaybeTransaction(async (transactionClient) => {
    const pgClient = clientOrPool(client || transactionClient);
    if (safeDedupe) {
      const existing = await pgClient.query(
        `SELECT * FROM background_jobs
         WHERE dedupe_key = $1 AND status IN ('QUEUED', 'RUNNING', 'RETRY_WAIT')
         ORDER BY created_at DESC
         LIMIT 1
         FOR UPDATE`,
        [safeDedupe]
      );
      if (existing.rows[0]) return { job: rowToJob(existing.rows[0]), created: false };
    }
    const id = crypto.randomUUID();
    const result = await pgClient.query(
      `INSERT INTO background_jobs (id, type, payload, dedupe_key, priority, max_attempts, available_at, payload_version)
       VALUES ($1, $2, $3::jsonb, $4, $5, $6, COALESCE($7::timestamptz, now()), $8)
       RETURNING *`,
      [id, safeType, JSON.stringify(safePayload), safeDedupe, Math.trunc(Number(priority) || 0), Math.max(1, Number(maxAttempts) || 5), availableAt, Math.max(1, Number(payloadVersion) || 1)]
    );
    return { job: rowToJob(result.rows[0]), created: true };
  });
}

async function claimNext({ worker, leaseMs = config.jobLeaseMs || 60_000, types = null } = {}) {
  const safeWorker = sanitizeText(worker || workerId(), { field: 'workerId', min: 3, max: 180, required: true });
  if (!db.usingPostgres()) {
    const now = Date.now();
    const candidates = [...memoryJobs.values()]
      .filter((job) => (types ? types.includes(job.type) : true))
      .filter((job) => (['QUEUED', 'RETRY_WAIT'].includes(job.status) && Date.parse(job.availableAt) <= now) || (job.status === 'RUNNING' && Date.parse(job.leaseExpiresAt || 0) <= now))
      .sort((a, b) => b.priority - a.priority || Date.parse(a.availableAt) - Date.parse(b.availableAt));
    const job = candidates[0];
    if (!job) return null;
    Object.assign(job, { status: 'RUNNING', lockedBy: safeWorker, lockedAt: nowIso(), leaseExpiresAt: new Date(now + leaseMs).toISOString(), attempts: Number(job.attempts || 0) + 1, updatedAt: nowIso() });
    return publicJob(job);
  }
  return db.transaction(async (client) => {
    const params = [safeWorker, Math.max(1_000, Number(leaseMs) || 60_000)];
    let typeFilter = '';
    if (Array.isArray(types) && types.length) {
      params.push(types);
      typeFilter = `AND type = ANY($${params.length})`;
    }
    const result = await client.query(
      `WITH candidate AS (
         SELECT id FROM background_jobs
         WHERE TRUE
           ${typeFilter}
           AND (
             (status IN ('QUEUED', 'RETRY_WAIT') AND available_at <= now())
             OR (status = 'RUNNING' AND lease_expires_at < now())
           )
         ORDER BY priority DESC, available_at ASC, created_at ASC
         FOR UPDATE SKIP LOCKED
         LIMIT 1
       )
       UPDATE background_jobs job
       SET status = 'RUNNING',
           locked_by = $1,
           locked_at = now(),
           lease_expires_at = now() + ($2::text || ' milliseconds')::interval,
           attempts = attempts + 1,
           updated_at = now()
       FROM candidate
       WHERE job.id = candidate.id
       RETURNING job.*`,
      params
    );
    return rowToJob(result.rows[0]);
  });
}

async function heartbeat(jobId, worker, { leaseMs = config.jobLeaseMs || 60_000 } = {}) {
  if (!db.usingPostgres()) {
    const job = memoryJobs.get(String(jobId));
    if (!job || job.lockedBy !== worker || job.status !== 'RUNNING') return false;
    job.leaseExpiresAt = new Date(Date.now() + leaseMs).toISOString();
    job.updatedAt = nowIso();
    return true;
  }
  const result = await db.query(
    `UPDATE background_jobs
     SET lease_expires_at = now() + ($3::text || ' milliseconds')::interval, updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING'
     RETURNING id`,
    [jobId, worker, Math.max(1_000, Number(leaseMs) || 60_000)]
  );
  return result.rowCount === 1;
}

async function complete(jobId, worker) {
  if (!db.usingPostgres()) {
    const job = memoryJobs.get(String(jobId));
    if (!job || job.lockedBy !== worker || job.status !== 'RUNNING') return false;
    Object.assign(job, { status: 'SUCCEEDED', completedAt: nowIso(), updatedAt: nowIso(), leaseExpiresAt: null, lockedBy: null });
    return true;
  }
  const result = await db.query(
    `UPDATE background_jobs
     SET status = 'SUCCEEDED', completed_at = now(), updated_at = now(), lease_expires_at = NULL
     WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING'
     RETURNING id`,
    [jobId, worker]
  );
  return result.rowCount === 1;
}

function backoffMs(attempts) {
  const base = Math.min(300_000, 5_000 * (3 ** Math.max(0, Number(attempts || 1) - 1)));
  return Math.round(base + crypto.randomInt(0, Math.max(1_000, Math.min(base, 30_000))));
}

async function fail(job, worker, error, { forceTerminal = false } = {}) {
  const classified = classifyProviderError(error);
  const terminal = forceTerminal || classified.terminal || classified.unknownSideEffect || Number(job.attempts || 0) >= Number(job.maxAttempts || 1) || !classified.retryable;
  const code = sanitizeText(classified.code || error?.code || 'JOB_FAILED', { field: 'jobErrorCode', max: 100 }) || 'JOB_FAILED';
  const message = safeMessage(classified.safeMessage || error?.message || 'No fue posible completar el trabajo.');
  if (!db.usingPostgres()) {
    const stored = memoryJobs.get(String(job.id));
    if (!stored || stored.lockedBy !== worker || stored.status !== 'RUNNING') return false;
    Object.assign(stored, {
      status: terminal ? 'FAILED' : 'RETRY_WAIT',
      availableAt: terminal ? stored.availableAt : new Date(Date.now() + backoffMs(stored.attempts)).toISOString(),
      failedAt: terminal ? nowIso() : null,
      lastErrorCode: code,
      lastErrorMessage: message,
      lockedBy: null,
      leaseExpiresAt: null,
      updatedAt: nowIso(),
    });
    return true;
  }
  const result = await db.query(
    `UPDATE background_jobs
     SET status = CASE WHEN $3::boolean THEN 'FAILED' ELSE 'RETRY_WAIT' END,
         available_at = CASE WHEN $3::boolean THEN available_at ELSE now() + ($4::text || ' milliseconds')::interval END,
         failed_at = CASE WHEN $3::boolean THEN now() ELSE NULL END,
         last_error_code = $5,
         last_error_message = $6,
         locked_by = NULL,
         lease_expires_at = NULL,
         updated_at = now()
     WHERE id = $1 AND locked_by = $2 AND status = 'RUNNING'
     RETURNING id`,
    [job.id, worker, terminal, backoffMs(job.attempts), code, message]
  );
  return result.rowCount === 1;
}

async function cancelByDedupe(dedupeKey) {
  if (!dedupeKey) return 0;
  if (!db.usingPostgres()) {
    let count = 0;
    for (const job of memoryJobs.values()) {
      if (job.dedupeKey === dedupeKey && ACTIVE_STATUSES.has(job.status)) {
        Object.assign(job, { status: 'CANCELLED', cancelledAt: nowIso(), updatedAt: nowIso(), lockedBy: null, leaseExpiresAt: null });
        count += 1;
      }
    }
    return count;
  }
  const result = await db.query(
    `UPDATE background_jobs
     SET status = 'CANCELLED', cancelled_at = now(), updated_at = now(), locked_by = NULL, lease_expires_at = NULL
     WHERE dedupe_key = $1 AND status IN ('QUEUED', 'RUNNING', 'RETRY_WAIT')`,
    [dedupeKey]
  );
  return result.rowCount;
}

async function recordWorkerHeartbeat(worker, { status = 'RUNNING', currentJobId = null, metadata = {} } = {}) {
  if (!db.usingPostgres()) return;
  await db.query(
    `INSERT INTO worker_heartbeats (worker_id, status, current_job_id, metadata, last_seen_at)
     VALUES ($1, $2, $3, $4::jsonb, now())
     ON CONFLICT (worker_id) DO UPDATE SET
       status = EXCLUDED.status,
       current_job_id = EXCLUDED.current_job_id,
       metadata = EXCLUDED.metadata,
       last_seen_at = now()`,
    [worker, status, currentJobId, JSON.stringify(sanitizePayload(metadata))]
  );
}

async function diagnostics() {
  if (!db.usingPostgres()) {
    const queued = [...memoryJobs.values()].filter((job) => ACTIVE_STATUSES.has(job.status));
    return { configured: false, queued: queued.length, failedRecent: [...memoryJobs.values()].filter((job) => job.status === 'FAILED').length };
  }
  const result = await db.query(`
    SELECT
      MIN(created_at) FILTER (WHERE status IN ('QUEUED', 'RETRY_WAIT')) AS oldest_queued_at,
      COUNT(*) FILTER (WHERE status IN ('QUEUED', 'RETRY_WAIT'))::int AS queued_count,
      COUNT(*) FILTER (WHERE status = 'FAILED' AND failed_at > now() - interval '24 hours')::int AS failed_recent_count
    FROM background_jobs
  `);
  const heartbeat = await db.query('SELECT MAX(last_seen_at) AS last_seen_at FROM worker_heartbeats');
  return {
    configured: true,
    queued: result.rows[0]?.queued_count || 0,
    oldestQueuedAt: result.rows[0]?.oldest_queued_at || null,
    failedRecent: result.rows[0]?.failed_recent_count || 0,
    workerLastSeenAt: heartbeat.rows[0]?.last_seen_at || null,
  };
}

async function getJob(id) {
  if (!db.usingPostgres()) return publicJob(memoryJobs.get(String(id)));
  const result = await db.query('SELECT * FROM background_jobs WHERE id = $1', [id]);
  return rowToJob(result.rows[0]);
}

function resetForTest() {
  memoryJobs.clear();
}

module.exports = {
  ACTIVE_STATUSES,
  TERMINAL_STATUSES,
  backoffMs,
  cancelByDedupe,
  claimNext,
  complete,
  diagnostics,
  enqueue,
  fail,
  getJob,
  heartbeat,
  publicJob,
  recordWorkerHeartbeat,
  resetForTest,
  sanitizePayload,
  workerId,
};
