require('dotenv').config({ quiet: true });
const { assertRuntimeConfig, config } = require('./config');
const { createApp, recordingConfigured } = require('./app');
const { log } = require('./logger');
const db = require('./db');
const redis = require('./redis');
const { createShutdown } = require('./lifecycle');

assertRuntimeConfig();

const app = createApp();
let server;
const shutdown = createShutdown({ serverRef: () => server, redis, db });

async function start() {
  if (db.usingPostgres()) {
    await db.ping();
    log('info', 'service_status', { service: 'postgres', available: true, backend: config.dataBackend });
  }
  if (redis.hasRedis()) {
    await redis.ping();
    log('info', 'service_status', { service: 'redis', available: true });
  }
  server = app.listen(config.port, async () => {
    log('info', 'server_started', { app: config.appName, environment: config.appEnv, publicUrl: config.appPublicUrl, port: config.port });
    const livekit = await app.locals.livekitProbe({ fresh: true });
    log('info', 'service_status', { service: 'livekit', mode: livekit.mode, available: livekit.available, recordingConfigured });
  });
}

start().catch((error) => {
  log('error', 'server_start_failed', { errorName: error.name, errorCode: error.code });
  Promise.allSettled([redis.disconnect(), db.closePool()]).finally(() => process.exit(1));
});

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (error) => {
  log('error', 'uncaught_exception', { errorName: error.name, errorCode: error.code });
  shutdown('uncaughtException', 1);
});
process.on('unhandledRejection', (error) => {
  log('error', 'unhandled_rejection', { errorName: error?.name || 'UnhandledRejection', errorCode: error?.code });
  shutdown('unhandledRejection', 1);
});
