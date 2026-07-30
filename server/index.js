require('dotenv').config({ quiet: true });
const { assertRuntimeConfig, config } = require('./config');
const { createApp, recordingConfigured } = require('./app');

assertRuntimeConfig();

const app = createApp();
const server = app.listen(config.port, () => {
  const livekitUrl = process.env.LIVEKIT_WS_URL || 'ws://localhost:7880';
  console.info(`R.A. Training disponible en http://localhost:${config.port}`);
  console.info(`LiveKit: ${livekitUrl.startsWith('ws://localhost') ? 'local' : 'configurado'} | Grabación: ${recordingConfigured ? 'configurada' : 'deshabilitada'}`);
});

function shutdown(signal) {
  console.info(`${signal}: cerrando servidor`);
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
