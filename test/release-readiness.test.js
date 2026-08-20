const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'test';
process.env.APP_PUBLIC_URL = 'https://preview-ra-training.example';
process.env.APP_TIME_ZONE = 'America/Guayaquil';
process.env.APP_TIME_ZONE_LABEL = 'Ecuador continental';
process.env.SESSION_SECRET = 'test-session-secret-with-more-than-32-characters';
process.env.INVITATION_HASH_SECRET = 'test-invitation-secret-with-more-than-32-characters';

const { config, validateRuntimeConfig } = require('../server/config');
const { invitationSharePayload, meetingSchedule } = require('../server/invitation-message');
const { safeMetadata } = require('../server/logger');
const { HttpTranscriptionProvider, isPrivateAddress } = require('../server/transcription-provider');
const { safeRequestPath } = require('../server/app');

test('professional invitation uses the canonical public URL and WhatsApp-safe encoding', () => {
  const payload = invitationSharePayload({
    token: 'A'.repeat(43),
    role: 'VIEWER',
    meeting: {
      title: 'Seguridad & Operaciones',
      trainerName: 'María Pérez',
      scheduledAt: '2030-07-30T15:00:00.000Z',
      durationMinutes: 90,
    },
  });
  assert.equal(payload.url, `https://preview-ra-training.example/i/${'A'.repeat(43)}`);
  assert.doesNotMatch(payload.message, /localhost|undefined|null/i);
  assert.match(payload.message, /Seguridad & Operaciones/);
  assert.match(payload.message, /Ecuador continental/);
  assert.match(payload.message, /90 minutos/);
  assert.equal(new URL(payload.whatsappUrl).searchParams.get('text'), payload.message);
});

test('panelist invitation explains private publishing permissions', () => {
  const payload = invitationSharePayload({
    token: 'B'.repeat(43), role: 'PANELIST',
    meeting: { title: 'Taller', trainerName: 'Equipo R.A.', scheduledAt: '2030-07-30T15:00:00.000Z' },
  });
  assert.match(payload.message, /panelista/i);
  assert.match(payload.message, /audio, cámara y pantalla/i);
  assert.match(payload.message, /No lo compartas públicamente/i);
});

test('an unscheduled draft invitation never falls back to the Unix epoch', () => {
  const schedule = meetingSchedule({ scheduledAt: null });
  assert.equal(schedule.date, 'Por confirmar');
  assert.equal(schedule.time, 'Por confirmar');
});

test('Preview configuration fails closed until every isolated real integration is acknowledged', () => {
  const validPreview = {
    ...config,
    nodeEnv: 'production', appEnv: 'preview', appDisplayEnv: 'Vista previa',
    isProduction: true, isProductionLike: true, previewIsolationAcknowledged: true,
    appPublicUrl: 'https://ra-training-preview.example', cookieSecure: true,
    sessionSecret: 's'.repeat(40), invitationHashSecret: 'i'.repeat(40),
    livekitWsUrl: 'wss://preview-livekit.example', livekitApiKey: 'preview-key', livekitApiSecret: 'preview-secret',
    redisUrlConfigured: true,
    storageConfigured: true, transcriptionEnabled: true, transcriptionProvider: 'deepgram',
    transcriptionApiUrl: 'https://api.deepgram.com/v1/listen', transcriptionApiKeyConfigured: true,
    transcriptionAllowedHosts: new Set(['api.deepgram.com']), transcriptionDeepgramModel: 'nova-3',
  };
  assert.deepEqual(validateRuntimeConfig(validPreview), []);
  const errors = validateRuntimeConfig({ ...validPreview, previewIsolationAcknowledged: false, storageConfigured: false });
  assert.ok(errors.some((message) => message.includes('PREVIEW_ISOLATION_ACK')));
  assert.ok(errors.some((message) => message.includes('S3/R2')));
  assert.ok(validateRuntimeConfig({ ...validPreview, transcriptionAllowedHosts: new Set() }).some((message) => message.includes('TRANSCRIPTION_ALLOWED_HOSTS')));
  assert.ok(validateRuntimeConfig({
    ...validPreview,
    transcriptionApiUrl: 'http://api.deepgram.com/v1/listen',
  }).some((message) => message.includes('HTTPS')));
  assert.ok(validateRuntimeConfig({
    ...validPreview,
    transcriptionApiUrl: 'https://user:password@api.deepgram.com/v1/listen',
  }).some((message) => message.includes('credenciales')));
  assert.ok(validateRuntimeConfig({
    ...validPreview,
    appEnv: 'production',
    transcriptionApiKeyConfigured: false,
  }).some((message) => message.includes('TRANSCRIPTION_API_KEY')));
  assert.ok(validateRuntimeConfig({ ...validPreview, livekitWsUrl: 'wss://' }).some((message) => message.includes('LiveKit')));
});

test('Preview reports the Render commit while Production keeps an explicit application version', () => {
  const script = "console.log(require('./server/config').config.appVersion)";
  const baseEnv = {
    ...process.env,
    NODE_ENV: 'production',
    APP_VERSION: 'shared-stale-version',
    RENDER_GIT_COMMIT: 'current-render-commit',
  };
  const previewVersion = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), env: { ...baseEnv, APP_ENV: 'preview' }, encoding: 'utf8',
  }).trim();
  const productionVersion = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'), env: { ...baseEnv, APP_ENV: 'production' }, encoding: 'utf8',
  }).trim();
  assert.equal(previewVersion, 'current-render-commit');
  assert.equal(productionVersion, 'shared-stale-version');
});

test('safe diagnostics redact credential-shaped metadata recursively', () => {
  assert.deepEqual(safeMetadata({ room: 'training', nested: { apiKey: 'secret-value', token: 'token-value' } }), {
    room: 'training', nested: { apiKey: '[redacted]', token: '[redacted]' },
  });
});

test('structured request logs redact invitation tokens from paths', () => {
  assert.equal(safeRequestPath(`/i/${'secret-token'.repeat(5)}`), '/i/[redacted]');
  assert.equal(safeRequestPath('/api/health'), '/api/health');
});

test('transcription target checks recognize private and link-local addresses', () => {
  for (const address of ['127.0.0.1', '10.2.3.4', '172.16.0.1', '192.168.1.10', '169.254.2.1', '::1', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1']) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  assert.equal(isPrivateAddress('1.1.1.1'), false);
  assert.equal(isPrivateAddress('2606:4700:4700::1111'), false);
});

test('HTTP transcription health distinguishes configured from remotely available and caches checks', async () => {
  let calls = 0;
  const provider = new HttpTranscriptionProvider({
    enabled: true, apiUrl: 'https://transcription.example', apiKey: 'test-key',
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => ({ status: 'ok' }) }; },
  });
  const healthy = await provider.healthStatus();
  assert.equal(healthy.configured, true);
  assert.equal(healthy.available, true);
  assert.equal(healthy.status, 'healthy');
  assert.equal(healthy.mode, 'http');
  await provider.healthStatus();
  assert.equal(calls, 1);

  const unavailable = new HttpTranscriptionProvider({
    enabled: true, apiUrl: 'https://unavailable.example', apiKey: 'test-key',
    fetchImpl: async () => ({ ok: false, json: async () => ({}) }),
  });
  const status = await unavailable.healthStatus();
  assert.equal(status.configured, true);
  assert.equal(status.available, false);
});

test('Preview Blueprint is isolated, manual and cannot silently fall back to mocks', () => {
  const blueprint = fs.readFileSync(path.join(__dirname, '..', 'render.preview.yaml'), 'utf8');
  assert.match(blueprint, /name: ra-training-streaming-preview/);
  assert.match(blueprint, /branch: feature\/streaming-ux-roles-mobile/);
  assert.match(blueprint, /autoDeploy: false/);
  assert.match(blueprint, /healthCheckPath: \/health/);
  assert.match(blueprint, /key: APP_ENV\s+value: preview/);
  assert.match(blueprint, /key: TRANSCRIPTION_PROVIDER\s+value: deepgram/);
  assert.match(blueprint, /key: TRANSCRIPTION_API_URL\s+value: https:\/\/api\.deepgram\.com\/v1\/listen/);
  assert.match(blueprint, /key: TRANSCRIPTION_ALLOWED_HOSTS\s+value: api\.deepgram\.com/);
  assert.doesNotMatch(blueprint, /value: mock/);
});

test('production Render Blueprint separates web readiness from the worker process', () => {
  const blueprint = fs.readFileSync(path.join(__dirname, '..', 'render.yaml'), 'utf8');
  assert.match(blueprint, /type: web[\s\S]*name: ra-training-streaming-web/);
  assert.match(blueprint, /healthCheckPath: \/ready/);
  assert.match(blueprint, /buildCommand: npm ci && npm run build/);
  assert.match(blueprint, /type: worker[\s\S]*name: ra-training-streaming-worker/);
  assert.match(blueprint, /startCommand: npm run worker/);
  assert.match(blueprint, /key: DATA_BACKEND\s+value: postgres/);

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['check:release'], 'npm test && npm run build');
});

test('load harness is Preview-only, staged and high-cost guarded', () => {
  const harness = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'livekit-load-preview.ps1'), 'utf8');
  assert.match(harness, /ValidateSet\(25, 50, 100, 250, 500, 750, 1000\)/);
  assert.match(harness, /APP_ENV -ne "preview"/);
  assert.match(harness, /LOAD_TEST_ALLOWED_HOST/);
  assert.match(harness, /LOAD_TEST_PREVIEW_ACK/);
  assert.match(harness, /Subscribers -ge 100[\s\S]*ApproveHighCost/);
  assert.match(harness, /lk[\s\S]*load-test/);
  assert.doesNotMatch(harness, /productionAllowed\s*=\s*\$true/);
});

test('Preview responses enforce noindex, HSTS and Secure room cookies', () => {
  const script = `
    const { createApp } = require('./server/app');
    const { roomCookie } = require('./server/room-session');
    const provider = { isConfigured: () => true };
    const app = createApp({
      services: { roomService: {}, egressClient: {}, transcriptionProvider: provider },
      livekitProbe: async () => ({ configured: true, available: true, mode: 'remoto', checkedAt: new Date().toISOString() }),
      storageProbe: async () => ({ configured: true, available: true, mode: 's3', checkedAt: new Date().toISOString() }),
    });
    const server = app.listen(0, '127.0.0.1', async () => {
      const response = await fetch('http://127.0.0.1:' + server.address().port + '/robots.txt');
      console.log(JSON.stringify({
        robots: await response.text(),
        xRobots: response.headers.get('x-robots-tag'),
        hsts: response.headers.get('strict-transport-security'),
        cookie: roomCookie('signed-value'),
      }));
      server.close();
    });
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production', APP_ENV: 'preview', APP_DISPLAY_ENV: 'Vista previa',
      APP_PUBLIC_URL: 'https://preview.example', PREVIEW_ISOLATION_ACK: 'true',
      COOKIE_SECURE: 'true', SESSION_SECRET: 's'.repeat(40), INVITATION_HASH_SECRET: 'i'.repeat(40),
      REDIS_URL: 'redis://preview-redis.example:6379',
      LIVEKIT_WS_URL: 'wss://livekit-preview.example', LIVEKIT_API_KEY: 'preview-key', LIVEKIT_API_SECRET: 'preview-secret',
      RECORDING_S3_ACCESS_KEY: 'preview-access', RECORDING_S3_SECRET_KEY: 'preview-storage-secret', RECORDING_S3_BUCKET: 'preview-bucket',
      TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER: 'deepgram', TRANSCRIPTION_API_URL: 'https://api.deepgram.com/v1/listen', TRANSCRIPTION_API_KEY: 'preview-provider-key',
      TRANSCRIPTION_ALLOWED_HOSTS: 'api.deepgram.com',
    },
    encoding: 'utf8',
  });
  const data = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  assert.equal(data.robots, 'User-agent: *\nDisallow: /\n');
  assert.equal(data.xRobots, 'noindex, nofollow, noarchive');
  assert.match(data.hsts, /max-age=31536000/);
  assert.match(data.cookie, /; Secure(?:;|$)/);
  assert.match(data.cookie, /; HttpOnly(?:;|$)/);
  assert.match(data.cookie, /; SameSite=Lax(?:;|$)/);
});

test('/docs is unavailable in production app environment', () => {
  const script = `
    const { createApp } = require('./server/app');
    const provider = { isConfigured: () => true };
    const app = createApp({
      services: { roomService: {}, egressClient: {}, transcriptionProvider: provider },
      livekitProbe: async () => ({ configured: true, available: true, mode: 'remoto', checkedAt: new Date().toISOString() }),
      storageProbe: async () => ({ configured: true, available: true, mode: 's3', checkedAt: new Date().toISOString() }),
    });
    const server = app.listen(0, '127.0.0.1', async () => {
      try {
        const response = await fetch('http://127.0.0.1:' + server.address().port + '/docs/LOCAL_DEVELOPMENT.md');
        console.log(JSON.stringify({ status: response.status }));
      } finally {
        server.close();
      }
    });
  `;
  const output = execFileSync(process.execPath, ['-e', script], {
    cwd: path.join(__dirname, '..'),
    env: {
      ...process.env,
      NODE_ENV: 'production', APP_ENV: 'production', APP_DISPLAY_ENV: 'Producción',
      APP_PUBLIC_URL: 'https://app.example',
      COOKIE_SECURE: 'true', SESSION_SECRET: 's'.repeat(40), INVITATION_HASH_SECRET: 'i'.repeat(40),
      LIVEKIT_WS_URL: 'wss://livekit.example', LIVEKIT_API_KEY: 'production-key', LIVEKIT_API_SECRET: 'production-secret',
      RECORDING_S3_ACCESS_KEY: 'production-access', RECORDING_S3_SECRET_KEY: 'production-storage-secret', RECORDING_S3_BUCKET: 'production-bucket',
      TRANSCRIPTION_ENABLED: 'true', TRANSCRIPTION_PROVIDER: 'deepgram', TRANSCRIPTION_API_URL: 'https://api.deepgram.com/v1/listen', TRANSCRIPTION_API_KEY: 'production-provider-key',
      TRANSCRIPTION_ALLOWED_HOSTS: 'api.deepgram.com',
    },
    encoding: 'utf8',
  });
  const data = JSON.parse(output.trim().split(/\r?\n/).at(-1));
  assert.equal(data.status, 404);
});

test('dashboard meeting form does not expose lifecycle status editing', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.html'), 'utf8');
  const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'dashboard.js'), 'utf8');
  assert.doesNotMatch(html, /id="meetingStatus"/);
  assert.doesNotMatch(js, /getElementById\('meetingStatus'\)/);
});

test('public release surfaces contain no synthetic QA labels and static links resolve', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const publicFiles = fs.readdirSync(publicDir).filter((name) => /\.(?:html|js|webmanifest)$/.test(name));
  const visibleSource = publicFiles.map((name) => fs.readFileSync(path.join(publicDir, name), 'utf8')).join('\n');
  assert.doesNotMatch(visibleSource, /Prueba de persistencia local|QA Professional Meeting|Asistente de prueba|Versión local|Entorno local|Almacenamiento local|LiveKit local/);

  for (const name of publicFiles.filter((item) => item.endsWith('.html'))) {
    const html = fs.readFileSync(path.join(publicDir, name), 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const reference = match[1].split(/[?#]/)[0];
      if (!reference || /^(?:https?:|data:|#)/.test(reference) || reference.startsWith('/vendor/')) continue;
      const target = reference.startsWith('/docs/')
        ? path.join(__dirname, '..', reference.slice(1))
        : path.join(publicDir, reference.replace(/^\//, ''));
      assert.equal(fs.existsSync(target), true, `${name}: ${reference}`);
    }
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(publicDir, 'manifest.webmanifest'), 'utf8'));
  for (const icon of manifest.icons || []) assert.equal(fs.existsSync(path.join(publicDir, icon.src)), true, icon.src);
});

test('frontend E2E smoke suite runs against an isolated local server and mobile viewport', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['test:e2e'], 'playwright test');
  assert.match(manifest.scripts['test:e2e:smoke'], /chromium-desktop/);
  assert.ok(manifest.devDependencies['@playwright/test']);

  const configSource = fs.readFileSync(path.join(__dirname, '..', 'playwright.config.js'), 'utf8');
  assert.match(configSource, /scripts\/e2e-server\.js/);
  assert.match(configSource, /chromium-desktop/);
  assert.match(configSource, /chromium-mobile/);
  assert.match(configSource, /width: 390/);

  const serverSource = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'e2e-server.js'), 'utf8');
  assert.match(serverSource, /LOCAL_DATA_DIR/);
  assert.match(serverSource, /rat-streaming-e2e/);
  assert.match(serverSource, /livekit-e2e\.invalid/);
  assert.doesNotMatch(serverSource, /DATABASE_URL|REDIS_URL|TRANSCRIPTION_API_KEY/);
});
