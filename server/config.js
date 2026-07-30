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

const nodeEnv = process.env.NODE_ENV || 'development';
const isProduction = nodeEnv === 'production';

const config = {
  nodeEnv,
  isProduction,
  port: intFromEnv('PORT', 3000, { min: 1, max: 65_535 }),
  sessionSecret: process.env.SESSION_SECRET || 'dev-insecure-secret-change-me',
  sessionTtlMs: intFromEnv('SESSION_TTL_HOURS', 12, { min: 1, max: 168 }) * 60 * 60 * 1000,
  roomSessionTtlMs: intFromEnv('ROOM_SESSION_TTL_HOURS', 8, { min: 1, max: 48 }) * 60 * 60 * 1000,
  cookieSecure: boolFromEnv('COOKIE_SECURE', isProduction),
  allowOpenDevRooms: !isProduction && boolFromEnv('ALLOW_OPEN_DEV_ROOMS', false),
  invitationTtlMinutes: intFromEnv('INVITATION_TOKEN_TTL_MINUTES', 1_440, { min: 5, max: 43_200 }),
  loginRateLimitWindowMs: intFromEnv('LOGIN_RATE_LIMIT_WINDOW', 900, { min: 10, max: 86_400 }) * 1000,
  loginRateLimitMax: intFromEnv('LOGIN_RATE_LIMIT_MAX', 8, { min: 1, max: 1_000 }),
  chatRateLimitMax: intFromEnv('CHAT_RATE_LIMIT_MAX', 20, { min: 1, max: 1_000 }),
  meetingRateLimitMax: intFromEnv('MEETING_RATE_LIMIT_MAX', 20, { min: 1, max: 1_000 }),
  transcriptionEnabled: boolFromEnv('TRANSCRIPTION_ENABLED', false),
  transcriptionProvider: String(process.env.TRANSCRIPTION_PROVIDER || 'mock').trim().toLowerCase(),
  transcriptionLanguage: String(process.env.TRANSCRIPTION_LANGUAGE || 'es').trim(),
  transcriptionMaxDurationMinutes: intFromEnv('TRANSCRIPTION_MAX_DURATION_MINUTES', 240, { min: 1, max: 1_440 }),
  transcriptionRetentionDays: intFromEnv('TRANSCRIPTION_RETENTION_DAYS', 90, { min: 1, max: 3_650 }),
  transcriptionRateLimitMax: intFromEnv('TRANSCRIPTION_RATE_LIMIT_MAX', 10, { min: 1, max: 1_000 }),
  transcriptionApiUrl: String(process.env.TRANSCRIPTION_API_URL || '').trim(),
  transcriptionApiKeyConfigured: Boolean(process.env.TRANSCRIPTION_API_KEY),
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

function assertRuntimeConfig() {
  if (config.isProduction && config.sessionSecret === 'dev-insecure-secret-change-me') {
    throw new Error('SESSION_SECRET debe configurarse en Producción.');
  }
  if (config.isProduction && !config.cookieSecure) {
    throw new Error('COOKIE_SECURE no puede desactivarse en Producción.');
  }
  if (config.isProduction && config.transcriptionEnabled && config.transcriptionProvider === 'mock') {
    throw new Error('El proveedor mock de transcripción no puede habilitarse en Producción.');
  }
  if (config.transcriptionEnabled && !['http', 'mock'].includes(config.transcriptionProvider)) {
    throw new Error('TRANSCRIPTION_PROVIDER debe ser http o mock.');
  }
}

module.exports = { config, boolFromEnv, intFromEnv, assertRuntimeConfig };
