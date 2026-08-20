const { AppError } = require('./http-utils');

function parseLimit(value, { defaultLimit = 50, maxLimit = 200 } = {}) {
  if (value === undefined || value === null || value === '') return defaultLimit;
  if (!/^\d+$/.test(String(value))) throw new AppError(400, 'Límite de paginación no válido', 'VALIDATION_ERROR');
  const parsed = Number.parseInt(value, 10);
  if (parsed < 1 || parsed > maxLimit) throw new AppError(400, 'Límite de paginación no válido', 'VALIDATION_ERROR');
  return parsed;
}

function encodeCursor(value) {
  if (!value) return null;
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function decodeCursor(value) {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(String(value), 'base64url').toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('invalid');
    return decoded;
  } catch {
    throw new AppError(400, 'Cursor de paginación no válido', 'VALIDATION_ERROR');
  }
}

function page(items, limit, cursorFactory) {
  const visible = items.slice(0, limit);
  return {
    items: visible,
    nextCursor: items.length > limit && visible.length ? encodeCursor(cursorFactory(visible.at(-1))) : null,
  };
}

module.exports = { decodeCursor, encodeCursor, page, parseLimit };
