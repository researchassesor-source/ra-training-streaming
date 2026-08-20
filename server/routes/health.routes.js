const express = require('express');
const db = require('../db');
const redis = require('../redis');
const backgroundJobs = require('../background-jobs');
const liveKitWebhooks = require('../livekit-webhooks');
const { config } = require('../config');
const { asyncHandler } = require('../http-utils');

function workerStatus(jobs) {
  if (!db.usingPostgres()) return 'not-required';
  if (!jobs?.workerLastSeenAt) return 'stale';
  const ageMs = Date.now() - new Date(jobs.workerLastSeenAt).getTime();
  return Number.isFinite(ageMs) && ageMs <= 5 * 60_000 ? 'ok' : 'stale';
}

function queueStatus(jobs) {
  if (!jobs?.oldestQueuedAt) return 'ok';
  const ageMs = Date.now() - new Date(jobs.oldestQueuedAt).getTime();
  return Number.isFinite(ageMs) && ageMs > 15 * 60_000 ? 'degraded' : 'ok';
}

function createHealthRouter({ livekitProbe, storageProbe, transcriptionStatus, recordingConfigured }) {
  const router = express.Router();

  router.get('/live', (_req, res) => {
    res.json({ status: 'live', checkedAt: new Date().toISOString() });
  });

  router.get('/ready', asyncHandler(async (_req, res) => {
    const checks = {};
    let ready = true;
    if (db.usingPostgres()) {
      try { checks.postgres = await db.ping() ? 'ok' : 'unavailable'; }
      catch { checks.postgres = 'unavailable'; }
      if (checks.postgres !== 'ok') ready = false;
    } else checks.postgres = 'not-required';
    if (config.isProductionLike || redis.hasRedis()) {
      try { checks.redis = await redis.ping() ? 'ok' : 'unavailable'; }
      catch { checks.redis = 'unavailable'; }
      if (checks.redis !== 'ok') ready = false;
    } else checks.redis = 'not-required';
    res.status(ready ? 200 : 503).json({ status: ready ? 'ready' : 'not-ready', checkedAt: new Date().toISOString(), checks });
  }));

  router.get('/health', asyncHandler(async (_req, res) => {
    const [livekit, storage, transcription, jobs] = await Promise.all([
      livekitProbe(),
      storageProbe(),
      transcriptionStatus(),
      backgroundJobs.diagnostics(),
    ]);
    let postgres = 'not-required';
    if (db.usingPostgres()) {
      try { postgres = await db.ping() ? 'ok' : 'unavailable'; }
      catch { postgres = 'unavailable'; }
    }
    const redisDiagnostics = redis.diagnostics();
    const redisStatus = redis.hasRedis()
      ? redisDiagnostics.connected ? 'ok' : 'unavailable'
      : config.isProductionLike ? 'unavailable' : 'not-required';
    const services = {
      postgres,
      redis: { status: redisStatus, configured: redisDiagnostics.configured, connected: redisDiagnostics.connected },
      worker: workerStatus(jobs),
      queue: { status: queueStatus(jobs), queued: jobs.queued || 0, oldestQueuedAt: jobs.oldestQueuedAt || null, failedRecent: jobs.failedRecent || 0 },
      livekit: { configured: livekit.configured === true, available: livekit.available === true },
      storage: { configured: storage.configured === true, available: storage.available === true, mode: storage.mode },
      recording: { available: recordingConfigured && livekit.available === true && storage.available === true },
      transcription: { configured: transcription.configured === true, available: transcription.available === true, status: transcription.status || (transcription.available ? 'healthy' : transcription.configured ? 'degraded' : 'disabled') },
      livekitWebhooks: liveKitWebhooks.diagnostics(),
      backgroundJobs: jobs,
    };
    const coreReady = postgres !== 'unavailable' && redisStatus !== 'unavailable';
    const degraded = services.worker === 'stale' || services.queue.status === 'degraded'
      || (config.isProductionLike && (!services.livekit.available || !services.storage.available || (config.transcriptionEnabled && !services.transcription.available)));
    const status = !coreReady ? 'unhealthy' : degraded ? 'degraded' : 'healthy';
    res.status(status === 'unhealthy' ? 503 : 200).json({
      app: config.appName,
      environment: config.appEnv,
      displayEnvironment: config.appDisplayEnv,
      version: config.appVersion,
      status,
      checkedAt: new Date().toISOString(),
      services,
    });
  }));

  return router;
}

module.exports = { createHealthRouter, queueStatus, workerStatus };
