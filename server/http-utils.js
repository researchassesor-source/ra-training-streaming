const crypto = require('crypto');

class AppError extends Error {
  constructor(status, message, code = 'REQUEST_ERROR') {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
  }
}

function parseCookies(header = '') {
  const cookies = {};
  for (const part of String(header).split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

function serializeCookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.httpOnly) parts.push('HttpOnly');
  if (options.secure) parts.push('Secure');
  if (options.sameSite) parts.push(`SameSite=${options.sameSite}`);
  return parts.join('; ');
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function sanitizeText(value, { field = 'valor', min = 0, max = 255, required = false } = {}) {
  if (value === undefined || value === null) {
    if (required) throw new AppError(400, `${field} es requerido`, 'VALIDATION_ERROR');
    return '';
  }
  if (typeof value !== 'string') throw new AppError(400, `${field} debe ser texto`, 'VALIDATION_ERROR');
  const normalized = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (required && normalized.length < Math.max(1, min)) {
    throw new AppError(400, `${field} es requerido`, 'VALIDATION_ERROR');
  }
  if (normalized.length < min || normalized.length > max) {
    throw new AppError(400, `${field} debe tener entre ${min} y ${max} caracteres`, 'VALIDATION_ERROR');
  }
  return normalized;
}

function validateUsername(value) {
  const username = sanitizeText(value, { field: 'username', min: 3, max: 50, required: true }).toLowerCase();
  if (!/^[a-z0-9._-]+$/.test(username)) {
    throw new AppError(400, 'username solo puede contener letras, números, punto, guion y guion bajo', 'VALIDATION_ERROR');
  }
  return username;
}

function validatePassword(value) {
  if (typeof value !== 'string' || value.length < 10 || value.length > 128) {
    throw new AppError(400, 'La contraseña debe tener entre 10 y 128 caracteres', 'VALIDATION_ERROR');
  }
  return value;
}

function slugify(value) {
  const slug = sanitizeText(value, { field: 'room', max: 80, required: true })
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
  if (slug.length < 3) throw new AppError(400, 'El slug de sala debe tener al menos 3 caracteres', 'VALIDATION_ERROR');
  return slug;
}

function parseBoolean(value, fallback) {
  if (value === undefined) return fallback;
  if (typeof value !== 'boolean') throw new AppError(400, 'Se esperaba un valor booleano', 'VALIDATION_ERROR');
  return value;
}

function parsePositiveInteger(value, { field, min = 0, max = 100_000, fallback } = {}) {
  if (value === undefined || value === null || value === '') return fallback;
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new AppError(400, `${field} debe ser un entero entre ${min} y ${max}`, 'VALIDATION_ERROR');
  }
  return value;
}

function parseDate(value, { field, nullable = false } = {}) {
  if ((value === null || value === '') && nullable) return null;
  if (typeof value !== 'string') throw new AppError(400, `${field} debe ser una fecha ISO válida`, 'VALIDATION_ERROR');
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new AppError(400, `${field} debe ser una fecha ISO válida`, 'VALIDATION_ERROR');
  return date.toISOString();
}

function requestIp(req) {
  return String(req.ip || req.socket?.remoteAddress || '').slice(0, 80);
}

function limitedUserAgent(req) {
  return String(req.headers['user-agent'] || '')
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .slice(0, 300);
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

module.exports = {
  AppError,
  asyncHandler,
  limitedUserAgent,
  parseBoolean,
  parseCookies,
  parseDate,
  parsePositiveInteger,
  requestIp,
  safeEqual,
  sanitizeText,
  serializeCookie,
  slugify,
  validatePassword,
  validateUsername,
};
