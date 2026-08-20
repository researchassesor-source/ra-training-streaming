const test = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';
process.env.DATA_BACKEND = 'legacy';
process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'test-session-secret-with-more-than-32-characters';

const backgroundJobs = require('../server/background-jobs');
const { runOnce } = require('../server/worker');
const { AppError } = require('../server/http-utils');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test.beforeEach(() => {
  backgroundJobs.resetForTest();
});

test('durable queue primitives cover dedupe, claim-once, lease recovery and heartbeat', async () => {
  const [first, duplicate] = await Promise.all([
    backgroundJobs.enqueue({ type: 'TEST_JOB', dedupeKey: 'test:dedupe', payload: { id: 'safe' } }),
    backgroundJobs.enqueue({ type: 'TEST_JOB', dedupeKey: 'test:dedupe', payload: { id: 'safe' } }),
  ]);
  assert.equal(first.job.id, duplicate.job.id);
  assert.equal(first.created || duplicate.created, true);

  const claimedA = await backgroundJobs.claimNext({ worker: 'worker-a', leaseMs: 25 });
  const claimedB = await backgroundJobs.claimNext({ worker: 'worker-b', leaseMs: 25 });
  assert.equal(claimedA.id, first.job.id);
  assert.equal(claimedB, null);

  await backgroundJobs.heartbeat(claimedA.id, 'worker-a', { leaseMs: 1_000 });
  await sleep(40);
  assert.equal(await backgroundJobs.claimNext({ worker: 'worker-b', leaseMs: 25 }), null);

  await sleep(1_010);
  const recovered = await backgroundJobs.claimNext({ worker: 'worker-b', leaseMs: 1_000 });
  assert.equal(recovered.id, first.job.id);
  assert.equal(recovered.attempts, 2);
});

test('worker handles retryable, terminal, max-attempt, cancellation, unknown and poison jobs', async () => {
  const worker = 'worker-test';
  const retryable = await backgroundJobs.enqueue({ type: 'RETRYABLE', dedupeKey: 'job:retryable', maxAttempts: 3, payload: {} });
  await runOnce({ worker, handlers: { RETRYABLE: async () => { throw new AppError(503, 'Temporal', 'TEMPORARY_PROVIDER_ERROR'); } } });
  assert.equal((await backgroundJobs.getJob(retryable.job.id)).status, 'RETRY_WAIT');

  const terminal = await backgroundJobs.enqueue({ type: 'TERMINAL', dedupeKey: 'job:terminal', maxAttempts: 3, payload: {} });
  await runOnce({ worker, handlers: { TERMINAL: async () => { throw new AppError(403, 'Credenciales inválidas', 'PROVIDER_AUTH_FAILED'); } } });
  assert.equal((await backgroundJobs.getJob(terminal.job.id)).status, 'FAILED');

  const maxed = await backgroundJobs.enqueue({ type: 'MAXED', dedupeKey: 'job:maxed', maxAttempts: 1, payload: {} });
  await runOnce({ worker, handlers: { MAXED: async () => { throw new AppError(503, 'Temporal', 'TEMPORARY_PROVIDER_ERROR'); } } });
  assert.equal((await backgroundJobs.getJob(maxed.job.id)).status, 'FAILED');

  const cancelled = await backgroundJobs.enqueue({ type: 'CANCEL_ME', dedupeKey: 'job:cancel', payload: {} });
  await backgroundJobs.cancelByDedupe('job:cancel');
  assert.equal(await runOnce({ worker, handlers: { CANCEL_ME: async () => { throw new Error('must not run'); } } }), 0);
  assert.equal((await backgroundJobs.getJob(cancelled.job.id)).status, 'CANCELLED');

  const unknown = await backgroundJobs.enqueue({ type: 'UNKNOWN_TYPE', dedupeKey: 'job:unknown', payload: {} });
  const next = await backgroundJobs.enqueue({ type: 'NEXT_OK', dedupeKey: 'job:next', payload: {} });
  let processed = 0;
  await runOnce({ worker, handlers: { NEXT_OK: async () => { processed += 1; } } });
  await runOnce({ worker, handlers: { NEXT_OK: async () => { processed += 1; } } });
  assert.equal((await backgroundJobs.getJob(unknown.job.id)).status, 'FAILED');
  assert.equal((await backgroundJobs.getJob(next.job.id)).status, 'SUCCEEDED');
  assert.equal(processed, 1);
});
