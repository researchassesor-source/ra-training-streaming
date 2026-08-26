const { AppError, sanitizeText } = require('./http-utils');

const RETRYABLE_HTTP = new Set([408, 429, 500, 502, 503, 504]);
const TERMINAL_HTTP = new Set([400, 401, 403, 404, 413, 415, 422]);
const SECRET_PATTERNS = [
  /authorization:\s*[^\s,;]+/ig,
  /(token|secret|password|api[_-]?key|stream[_-]?key)=([^&\s]+)/ig,
  /FB-\d+-\d+-[A-Za-z0-9_-]+/g,
  /(rediss?|postgres(?:ql)?):\/\/[^\s]+/ig,
  /rtmps?:\/\/[^\s]+/ig,
];

function safeMessage(value, fallback = 'No fue posible completar la operación externa.') {
  let text = sanitizeText(value || fallback, { field: 'providerError', max: 300 }) || fallback;
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, '$1=[redacted]');
  return text;
}

function classifyProviderError(error, { operation = 'external', creatingSideEffect = false } = {}) {
  if (error?.classification) return error;
  const status = Number(error?.status || error?.statusCode || error?.httpStatus || error?.$metadata?.httpStatusCode);
  const code = sanitizeText(error?.code || error?.name || (status ? `HTTP_${status}` : 'PROVIDER_ERROR'), { field: 'providerErrorCode', max: 100 }) || 'PROVIDER_ERROR';
  const message = safeMessage(error?.message);
  if (creatingSideEffect && ['AbortError', 'TimeoutError', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE'].includes(code)) {
    return { classification: 'UNKNOWN_SIDE_EFFECT', retryable: false, terminal: false, unknownSideEffect: true, httpStatus: status || null, code, safeMessage: message, operation };
  }
  if (status && TERMINAL_HTTP.has(status)) return { classification: 'TERMINAL', retryable: false, terminal: true, unknownSideEffect: false, httpStatus: status, code, safeMessage: message, operation };
  if (status && RETRYABLE_HTTP.has(status)) return { classification: 'RETRYABLE', retryable: true, terminal: false, unknownSideEffect: false, httpStatus: status, code, safeMessage: message, operation };
  if (['AbortError', 'TimeoutError', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'TRANSCRIPTION_DEEPGRAM_TIMEOUT', 'TRANSCRIPTION_DEEPGRAM_UNAVAILABLE', 'TRANSCRIPTION_DEEPGRAM_RATE_LIMITED', 'TRANSCRIPTION_PROVIDER_UNAVAILABLE'].includes(code)) {
    return { classification: 'RETRYABLE', retryable: true, terminal: false, unknownSideEffect: false, httpStatus: status || null, code, safeMessage: message, operation };
  }
  if (error instanceof AppError && error.status && error.status < 500) return { classification: 'TERMINAL', retryable: false, terminal: true, unknownSideEffect: false, httpStatus: error.status, code, safeMessage: message, operation };
  return { classification: 'TERMINAL', retryable: false, terminal: true, unknownSideEffect: false, httpStatus: status || null, code, safeMessage: message, operation };
}

module.exports = { classifyProviderError, safeMessage };
