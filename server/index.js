require('dotenv').config({ quiet: true });
const { assertRuntimeConfig, config } = require('./config');
const { createApp, recordingConfigured } = require('./app');
const { log } = require('./logger');

assertRuntimeConfig();

const app = createApp();
const server = app.listen(config.port, async () => {
  log('info', 'server_started', { app: config.appName, environment: config.appEnv, publicUrl: config.appPublicUrl, port: config.port });
  const livekit = await app.locals.livekitProbe({ fresh: true });
  log('info', 'service_status', { service: 'livekit', mode: livekit.mode, available: livekit.available, recordingConfigured });
});

function shutdown(signal) {
  log('info', 'server_shutdown', { signal });
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
