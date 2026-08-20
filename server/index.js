require('dotenv').config({ quiet: true });
const { assertRuntimeConfig, config } = require('./config');
const { createApp, recordingConfigured } = require('./app');
const { log } = require('./logger');
const db = require('./db');

assertRuntimeConfig();

const app = createApp();
const server = app.listen(config.port, async () => {
  if (db.usingPostgres()) {
    await db.ping();
    log('info', 'service_status', { service: 'postgres', available: true, backend: config.dataBackend });
  }
  log('info', 'server_started', { app: config.appName, environment: config.appEnv, publicUrl: config.appPublicUrl, port: config.port });
  const livekit = await app.locals.livekitProbe({ fresh: true });
  log('info', 'service_status', { service: 'livekit', mode: livekit.mode, available: livekit.available, recordingConfigured });
});

function shutdown(signal) {
  log('info', 'server_shutdown', { signal });
  server.close(() => db.closePool().finally(() => process.exit(0)));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
