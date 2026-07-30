const REDACTED_KEYS = /(authorization|cookie|password|secret|token|api[-_]?key|credential)/i;

function safeMetadata(value, depth = 0) {
  if (depth > 3) return '[truncated]';
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => safeMetadata(item, depth + 1));
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 500) : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    REDACTED_KEYS.test(key) ? '[redacted]' : safeMetadata(item, depth + 1),
  ]));
}

function log(level, event, metadata = {}) {
  const entry = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...safeMetadata(metadata) });
  const writer = level === 'error' ? console.error : level === 'warn' ? console.warn : console.info;
  writer(entry);
}

module.exports = { log, safeMetadata };
