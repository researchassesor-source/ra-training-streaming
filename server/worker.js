const { EgressClient, EgressStatus } = require('livekit-server-sdk');
const db = require('./db');
const redis = require('./redis');
const backgroundJobs = require('./background-jobs');
const transcriptions = require('./transcriptions');
const meetings = require('./meetings');
const { createTranscriptionProvider } = require('./transcription-provider');
const { resolveRecording } = require('./recording-resolver');
const { config, assertRuntimeConfig } = require('./config');
const { log } = require('./logger');
const { AppError } = require('./http-utils');
const { updateRecording, updateFacebook } = require('./external-sessions');
const { facebookStateFromEgress, isRecordingEgress, isStreamingEgress } = require('./facebook-live');

function egressStatusName(info) {
  return typeof info?.status === 'string' ? info.status : EgressStatus[info?.status] || '';
}

function recordingStateFromEgress(info) {
  const status = egressStatusName(info);
  if (status === 'EGRESS_ACTIVE') return 'RECORDING';
  if (status === 'EGRESS_STARTING') return 'STARTING';
  if (status === 'EGRESS_ENDING') return 'STOPPING';
  if (status === 'EGRESS_COMPLETE') return 'READY';
  if (status === 'EGRESS_FAILED' || status === 'EGRESS_ABORTED') return 'FAILED';
  return 'PENDING_RECONCILIATION';
}

function createDefaultServices() {
  return {
    transcriptionProvider: createTranscriptionProvider(),
    recordingResolver: resolveRecording,
    meetings,
    egressClient: new EgressClient(process.env.LIVEKIT_HTTP_URL || config.livekitWsUrl.replace(/^ws/i, 'http'), config.livekitApiKey, config.livekitApiSecret),
  };
}

function createHandlers(services = createDefaultServices()) {
  return {
    TRANSCRIPTION_PROCESS: async (job) => transcriptions.processTranscriptionJob({
      transcriptionId: job.payload?.transcriptionId,
      provider: services.transcriptionProvider,
      recordingResolver: services.recordingResolver,
      meetings: services.meetings,
    }),
    TRANSCRIPTION_RETENTION_DELETE: async (job) => transcriptions.applyRetention(await transcriptions.getTranscript(job.payload?.transcriptionId)),
    RECORDING_RECONCILE: async (job) => {
      const egressId = job.payload?.egressId;
      const room = job.payload?.room;
      if (!egressId && !room) throw new AppError(400, 'Job de reconciliación de grabación inválido.', 'JOB_PAYLOAD_INVALID');
      const egresses = await services.egressClient.listEgress({ roomName: room });
      const info = (egresses || []).find((item) => item.egressId === egressId || (!egressId && isRecordingEgress(item)));
      if (!info) {
        if (job.payload?.sessionId) await updateRecording(job.payload.sessionId, { status: 'FAILED', lastReconciledAt: new Date().toISOString(), lastErrorCode: 'EGRESS_NOT_FOUND', lastErrorMessage: 'Egress no encontrado durante reconciliación.' });
        return { missing: true };
      }
      if (job.payload?.sessionId) {
        await updateRecording(job.payload.sessionId, {
          egressId: info.egressId,
          status: recordingStateFromEgress(info),
          providerStatus: egressStatusName(info),
          outputObjectKey: info.fileResults?.[0]?.filename || info.fileResults?.[0]?.location || null,
          lastReconciledAt: new Date().toISOString(),
          metadata: { source: 'livekit-egress' },
        });
      }
      return { egressId: info.egressId, status: egressStatusName(info) };
    },
    FACEBOOK_RECONCILE: async (job) => {
      const egressId = job.payload?.egressId;
      const room = job.payload?.room;
      if (!egressId && !room) throw new AppError(400, 'Job de reconciliación Facebook inválido.', 'JOB_PAYLOAD_INVALID');
      const egresses = await services.egressClient.listEgress({ roomName: room });
      const info = (egresses || []).find((item) => item.egressId === egressId || (!egressId && isStreamingEgress(item)));
      const state = facebookStateFromEgress(info);
      if (job.payload?.sessionId) {
        await updateFacebook(job.payload.sessionId, {
          egressId: state.egressId,
          status: state.active ? 'LIVE' : state.state === 'ERROR' ? 'FAILED' : 'STOPPED',
          startedAt: state.startedAt,
          endedAt: state.stoppedAt,
          lastReconciledAt: new Date().toISOString(),
          metadata: { source: 'facebook-livekit-egress' },
        });
      }
      return state;
    },
  };
}

async function runJob(job, worker, handlers) {
  const handler = handlers[job.type];
  if (!handler) throw new AppError(500, `Tipo de job no soportado: ${job.type}`, 'JOB_TYPE_UNKNOWN');
  await backgroundJobs.recordWorkerHeartbeat(worker, { currentJobId: job.id, metadata: { jobType: job.type } });
  return handler(job);
}

async function runOne({ worker = backgroundJobs.workerId(), services, handlers = createHandlers(services), leaseMs = config.jobLeaseMs } = {}) {
  const job = await backgroundJobs.claimNext({ worker, leaseMs });
  if (!job) return false;
  let heartbeatTimer;
  try {
    heartbeatTimer = setInterval(() => {
      backgroundJobs.heartbeat(job.id, worker, { leaseMs }).catch((error) => log('warn', 'job_heartbeat_failed', { jobId: job.id, worker, code: error.code || error.name || 'HEARTBEAT_FAILED' }));
      backgroundJobs.recordWorkerHeartbeat(worker, { currentJobId: job.id, metadata: { jobType: job.type } }).catch(() => null);
    }, config.jobHeartbeatIntervalMs);
    await runJob(job, worker, handlers);
    await backgroundJobs.complete(job.id, worker);
    log('info', 'job_completed', { jobId: job.id, type: job.type, attempt: job.attempts });
  } catch (error) {
    await backgroundJobs.fail(job, worker, error, { forceTerminal: error?.code === 'JOB_TYPE_UNKNOWN' || error?.code === 'JOB_PAYLOAD_INVALID' });
    log('warn', 'job_failed', { jobId: job.id, type: job.type, attempt: job.attempts, code: error.code || error.name || 'JOB_FAILED' });
  } finally {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    await backgroundJobs.recordWorkerHeartbeat(worker, { currentJobId: null, metadata: {} }).catch(() => null);
  }
  return true;
}

async function runOnce(options = {}) {
  let processed = 0;
  while (await runOne(options)) processed += 1;
  return processed;
}

async function runContinuous(options = {}) {
  const worker = options.worker || backgroundJobs.workerId();
  let stopping = false;
  const stop = () => { stopping = true; };
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);
  while (!stopping) {
    const processed = await runOnce({ ...options, worker });
    if (!processed) await new Promise((resolve) => setTimeout(resolve, config.jobPollIntervalMs));
  }
  await backgroundJobs.recordWorkerHeartbeat(worker, { status: 'STOPPING' }).catch(() => null);
}

async function main() {
  require('dotenv').config();
  assertRuntimeConfig();
  if (!db.usingPostgres()) throw new Error('DATA_BACKEND=postgres es requerido para worker durable.');
  await db.ping();
  if (redis.hasRedis()) await redis.ping();
  const once = process.argv.includes('--once');
  if (once) {
    const processed = await runOnce();
    console.log(`Worker processed ${processed} job(s)`);
  } else {
    await runContinuous();
  }
}

if (require.main === module) {
  main().catch(async (error) => {
    log('error', 'worker_failed', { code: error.code || error.name || 'WORKER_FAILED', message: error.message });
    await redis.disconnect().catch(() => null);
    await db.closePool().catch(() => null);
    process.exit(1);
  }).finally(async () => {
    await redis.disconnect().catch(() => null);
    await db.closePool().catch(() => null);
  });
}

module.exports = { createHandlers, runContinuous, runJob, runOnce, runOne };
