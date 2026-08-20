const APP_ENVIRONMENTS = new Set(['development', 'test', 'preview', 'production']);

function boolFromEnv(name, fallback = false) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function intFromEnv(name, fallback, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const parsed = Number.parseInt(process.env[name] || '', 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function normalizePublicUrl(value) {
  const raw = String(value || '').trim().replace(/\/+$/, '');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) return '';
    if (parsed.pathname !== '/' && parsed.pathname !== '') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

function defaultAppEnvironment(nodeEnv) {
  if (nodeEnv === 'test') return 'test';
  if (nodeEnv === 'production') return 'production';
  return 'development';
}

const nodeEnv = String(process.env.NODE_ENV || 'development').trim().toLowerCase();
const appEnv = String(process.env.APP_ENV || defaultAppEnvironment(nodeEnv)).trim().toLowerCase();
const isProduction = nodeEnv === 'production';
const isProductionLike = appEnv === 'preview' || appEnv === 'production';
const port = intFromEnv('PORT', 3000, { min: 1, max: 65_535 });
const appDisplayEnv = String(process.env.APP_DISPLAY_ENV || ({
  development: 'Desarrollo',
  test: 'Pruebas',
  preview: 'Vista previa',
  production: 'Producción',
})[appEnv] || '').trim();
const configuredPublicUrl = normalizePublicUrl(process.env.APP_PUBLIC_URL);
const appPublicUrl = configuredPublicUrl || (isProductionLike ? '' : `http://localhost:${port}`);
const sessionSecret = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const renderGitCommit = String(process.env.RENDER_GIT_COMMIT || '').trim();
const configuredAppVersion = appEnv === 'preview'
  ? (renderGitCommit || process.env.APP_VERSION)
  : (process.env.APP_VERSION || renderGitCommit);
const dataBackend = String(process.env.DATA_BACKEND || 'legacy').trim().toLowerCase();

const config = {
  nodeEnv,
  appEnv,
  appDisplayEnv,
  appName: String(process.env.APP_NAME || 'R.A. Training Streaming').trim(),
  appPublicUrl,
  appVersion: String(configuredAppVersion || (appEnv === 'development' ? 'desarrollo' : 'sin-versión')).trim().slice(0, 64),
  dataBackend,
  databaseUrlConfigured: Boolean(process.env.DATABASE_URL),
  databaseDirectUrlConfigured: Boolean(process.env.DATABASE_URL_DIRECT),
  databasePoolMax: intFromEnv('DATABASE_POOL_MAX', 10, { min: 1, max: 50 }),
  databaseStatementTimeoutMs: intFromEnv('DATABASE_STATEMENT_TIMEOUT_MS', 15_000, { min: 1_000, max: 120_000 }),
  redisUrlConfigured: Boolean(process.env.REDIS_URL),
  workerConcurrency: intFromEnv('WORKER_CONCURRENCY', 1, { min: 1, max: 10 }),
  jobPollIntervalMs: intFromEnv('JOB_POLL_INTERVAL_MS', 2_000, { min: 250, max: 60_000 }),
  jobLeaseMs: intFromEnv('JOB_LEASE_MS', 60_000, { min: 5_000, max: 3_600_000 }),
  jobHeartbeatIntervalMs: intFromEnv('JOB_HEARTBEAT_INTERVAL_MS', 15_000, { min: 1_000, max: 300_000 }),
  appTimeZone: String(process.env.APP_TIME_ZONE || 'America/Guayaquil').trim(),
  appTimeZoneLabel: String(process.env.APP_TIME_ZONE_LABEL || process.env.APP_TIME_ZONE || 'America/Guayaquil').trim(),
  noIndex: appEnv === 'preview',
  previewIsolationAcknowledged: boolFromEnv('PREVIEW_ISOLATION_ACK', false),
  isProduction,
  isProductionLike,
  port,
  sessionSecret,
  invitationHashSecret: process.env.INVITATION_HASH_SECRET || (isProductionLike ? '' : sessionSecret),
  sessionTtlMs: intFromEnv('SESSION_TTL_HOURS', 12, { min: 1, max: 168 }) * 60 * 60 * 1000,
  roomSessionTtlMs: intFromEnv('ROOM_SESSION_TTL_HOURS', 8, { min: 1, max: 48 }) * 60 * 60 * 1000,
  cookieSecure: boolFromEnv('COOKIE_SECURE', isProductionLike || isProduction),
  allowOpenDevRooms: !isProductionLike && !isProduction && boolFromEnv('ALLOW_OPEN_DEV_ROOMS', false),
  invitationTtlMinutes: intFromEnv('INVITATION_TOKEN_TTL_MINUTES', 1_440, { min: 5, max: 43_200 }),
  loginRateLimitWindowMs: intFromEnv('LOGIN_RATE_LIMIT_WINDOW', 900, { min: 10, max: 86_400 }) * 1000,
  loginRateLimitMax: intFromEnv('LOGIN_RATE_LIMIT_MAX', 8, { min: 1, max: 1_000 }),
  chatRateLimitMax: intFromEnv('CHAT_RATE_LIMIT_MAX', 20, { min: 1, max: 1_000 }),
  meetingRateLimitMax: intFromEnv('MEETING_RATE_LIMIT_MAX', 20, { min: 1, max: 1_000 }),
  livekitWsUrl: String(process.env.LIVEKIT_WS_URL || (isProductionLike ? '' : 'ws://localhost:7880')).trim(),
  livekitApiKey: String(process.env.LIVEKIT_API_KEY || (isProductionLike ? '' : 'devkey')).trim(),
  livekitApiSecret: String(process.env.LIVEKIT_API_SECRET || (isProductionLike ? '' : 'secret')).trim(),
  storageConfigured: Boolean(process.env.RECORDING_S3_ACCESS_KEY && process.env.RECORDING_S3_SECRET_KEY && process.env.RECORDING_S3_BUCKET),
  transcriptionEnabled: boolFromEnv('TRANSCRIPTION_ENABLED', false),
  transcriptionProvider: String(process.env.TRANSCRIPTION_PROVIDER || 'mock').trim().toLowerCase(),
  transcriptionLanguage: String(process.env.TRANSCRIPTION_LANGUAGE || 'es').trim(),
  transcriptionMaxDurationMinutes: intFromEnv('TRANSCRIPTION_MAX_DURATION_MINUTES', 240, { min: 1, max: 1_440 }),
  transcriptionRetentionDays: intFromEnv('TRANSCRIPTION_RETENTION_DAYS', 90, { min: 1, max: 3_650 }),
  transcriptionRateLimitMax: intFromEnv('TRANSCRIPTION_RATE_LIMIT_MAX', 10, { min: 1, max: 1_000 }),
  transcriptionApiUrl: String(process.env.TRANSCRIPTION_API_URL || '').trim(),
  transcriptionApiKeyConfigured: Boolean(process.env.TRANSCRIPTION_API_KEY),
  transcriptionAllowedHosts: new Set(String(process.env.TRANSCRIPTION_ALLOWED_HOSTS || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean)),
  transcriptionDeepgramModel: String(process.env.TRANSCRIPTION_DEEPGRAM_MODEL || 'nova-3').trim(),
  transcriptionDeepgramDiarize: boolFromEnv('TRANSCRIPTION_DEEPGRAM_DIARIZE', true),
  transcriptionDeepgramSmartFormat: boolFromEnv('TRANSCRIPTION_DEEPGRAM_SMART_FORMAT', true),
  transcriptionDeepgramUtterances: boolFromEnv('TRANSCRIPTION_DEEPGRAM_UTTERANCES', true),
  transcriptionDeepgramParagraphs: boolFromEnv('TRANSCRIPTION_DEEPGRAM_PARAGRAPHS', true),
  transcriptionRequestTimeoutMs: intFromEnv('TRANSCRIPTION_REQUEST_TIMEOUT_MS', 600_000, { min: 10_000, max: 3_600_000 }),
  transcriptionMaxAudioBytes: intFromEnv('TRANSCRIPTION_MAX_AUDIO_BYTES', 2_147_483_648, { min: 1_048_576, max: 5_368_709_120 }),
  transcriptionPresignedUrlTtlSeconds: intFromEnv('TRANSCRIPTION_PRESIGNED_URL_TTL_SECONDS', 600, { min: 300, max: 900 }),
  transcriptionRetryMax: intFromEnv('TRANSCRIPTION_RETRY_MAX', 2, { min: 0, max: 5 }),
  maxJsonPayload: process.env.MAX_JSON_PAYLOAD || '256kb',
  maxChatMessageLength: intFromEnv('MAX_CHAT_MESSAGE_LENGTH', 2_000, { min: 50, max: 10_000 }),
  maxChatFileSize: intFromEnv('MAX_CHAT_FILE_SIZE', 10 * 1024 * 1024, { min: 1_024, max: 50 * 1024 * 1024 }),
  allowedChatMimeTypes: new Set(
    String(process.env.ALLOWED_CHAT_MIME_TYPES || 'image/jpeg,image/png,image/webp,application/pdf,text/plain')
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean)
  ),
};

function validateRuntimeConfig(candidate = config) {
  const errors = [];
  if (!APP_ENVIRONMENTS.has(candidate.appEnv)) errors.push('APP_ENV debe ser development, test, preview o production.');
  if (!['legacy', 'postgres'].includes(candidate.dataBackend)) errors.push('DATA_BACKEND debe ser legacy o postgres.');
  if (candidate.dataBackend === 'postgres' && !candidate.databaseUrlConfigured) errors.push('DATABASE_URL is required when DATA_BACKEND=postgres.');
  if (candidate.isProductionLike && !candidate.redisUrlConfigured) errors.push('REDIS_URL is required for distributed runtime.');
  if (!candidate.appName) errors.push('APP_NAME no puede estar vacío.');
  try { new Intl.DateTimeFormat('es-EC', { timeZone: candidate.appTimeZone }).format(new Date()); }
  catch { errors.push('APP_TIME_ZONE no es una zona horaria válida.'); }
  if (candidate.isProductionLike) {
    if (candidate.nodeEnv !== 'production') errors.push('NODE_ENV debe ser production en Preview y Producción.');
    if (!candidate.appPublicUrl || !candidate.appPublicUrl.startsWith('https://')) errors.push('APP_PUBLIC_URL debe ser una URL HTTPS sin ruta en Preview y Producción.');
    if (!candidate.cookieSecure) errors.push('COOKIE_SECURE debe estar activado en Preview y Producción.');
    if (!candidate.sessionSecret || candidate.sessionSecret.length < 32 || candidate.sessionSecret === 'dev-insecure-secret-change-me') errors.push('SESSION_SECRET debe tener al menos 32 caracteres seguros.');
    if (!candidate.invitationHashSecret || candidate.invitationHashSecret.length < 32) errors.push('INVITATION_HASH_SECRET debe tener al menos 32 caracteres seguros.');
    let secureLiveKitUrl = false;
    try {
      const liveKitUrl = new URL(candidate.livekitWsUrl);
      secureLiveKitUrl = liveKitUrl.protocol === 'wss:' && Boolean(liveKitUrl.hostname) && !liveKitUrl.username && !liveKitUrl.password;
    } catch {}
    if (!secureLiveKitUrl || !candidate.livekitApiKey || !candidate.livekitApiSecret) errors.push('LiveKit debe configurarse con WSS y credenciales aisladas.');
  }
  if (candidate.appEnv === 'preview') {
    if (!candidate.previewIsolationAcknowledged) errors.push('PREVIEW_ISOLATION_ACK debe confirmar que todas las integraciones usan recursos no productivos.');
    if (!candidate.storageConfigured) errors.push('Preview requiere almacenamiento S3/R2 aislado.');
    if (!candidate.transcriptionEnabled || candidate.transcriptionProvider !== 'deepgram' || !candidate.transcriptionApiUrl || !candidate.transcriptionApiKeyConfigured) errors.push('Preview requiere el proveedor Deepgram real de transcripción.');
  }
  if (candidate.isProductionLike && candidate.transcriptionEnabled && ['http', 'deepgram'].includes(candidate.transcriptionProvider)) {
    if (!candidate.transcriptionApiKeyConfigured) errors.push('TRANSCRIPTION_API_KEY debe configurarse cuando la transcripción está habilitada.');
    try {
      const providerUrl = new URL(candidate.transcriptionApiUrl);
      const hostname = providerUrl.hostname.toLowerCase();
      if (providerUrl.protocol !== 'https:' || providerUrl.username || providerUrl.password || providerUrl.search || providerUrl.hash) {
        errors.push('TRANSCRIPTION_API_URL debe usar HTTPS y no incluir credenciales.');
      }
      if (!candidate.transcriptionAllowedHosts?.has(hostname)) errors.push('TRANSCRIPTION_ALLOWED_HOSTS debe autorizar explícitamente el host del proveedor.');
      if (candidate.transcriptionProvider === 'deepgram' && (hostname !== 'api.deepgram.com' || providerUrl.pathname.replace(/\/+$/, '') !== '/v1/listen')) {
        errors.push('Deepgram debe usar exactamente https://api.deepgram.com/v1/listen.');
      }
    } catch {
      errors.push('TRANSCRIPTION_API_URL debe ser una URL HTTPS válida.');
    }
  }
  if (candidate.isProduction && candidate.sessionSecret === 'dev-insecure-secret-change-me') errors.push('SESSION_SECRET debe configurarse en Producción.');
  if (candidate.isProduction && !candidate.cookieSecure) errors.push('COOKIE_SECURE no puede desactivarse en Producción.');
  if (candidate.isProduction && candidate.transcriptionEnabled && candidate.transcriptionProvider === 'mock') errors.push('El proveedor mock de transcripción no puede habilitarse en Producción.');
  if (candidate.transcriptionEnabled && !['deepgram', 'http', 'mock'].includes(candidate.transcriptionProvider)) errors.push('TRANSCRIPTION_PROVIDER debe ser deepgram, http o mock.');
  if (candidate.transcriptionEnabled && candidate.transcriptionProvider === 'deepgram' && !/^[a-z0-9][a-z0-9._-]{1,79}$/i.test(candidate.transcriptionDeepgramModel || '')) errors.push('TRANSCRIPTION_DEEPGRAM_MODEL no es válido.');
  return errors;
}

function assertRuntimeConfig() {
  const errors = validateRuntimeConfig();
  if (errors.length) throw new Error(errors.join(' '));
}

function publicUrl(pathname = '/') {
  const path = String(pathname || '/').startsWith('/') ? String(pathname || '/') : `/${pathname}`;
  return new URL(path, `${config.appPublicUrl}/`).href;
}

module.exports = {
  APP_ENVIRONMENTS,
  assertRuntimeConfig,
  boolFromEnv,
  config,
  intFromEnv,
  normalizePublicUrl,
  publicUrl,
  validateRuntimeConfig,
};
