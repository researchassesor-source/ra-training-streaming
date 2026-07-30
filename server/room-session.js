const crypto = require('crypto');
const { config } = require('./config');
const { decodeSignedPayload, signPayload } = require('./auth');
const { parseCookies, safeEqual, serializeCookie } = require('./http-utils');

const ROOM_COOKIE = 'rat_room_session';
const ROOM_COOKIE_PREFIX = `${ROOM_COOKIE}_`;
const ROOM_ROLES = new Set(['ADMIN', 'ORGANIZER', 'PANELIST', 'VIEWER']);

function normalizeSessionSelector(value) {
  const selector = String(value || '').trim();
  return /^[a-f0-9-]{36}$/i.test(selector) ? selector : '';
}

function sessionCookieName(sessionId) {
  const selector = normalizeSessionSelector(sessionId);
  return selector ? `${ROOM_COOKIE_PREFIX}${selector}` : ROOM_COOKIE;
}

function createRoomSession({ room, meetingId, role, username = null, displayName = null, invitationId = null }) {
  const normalizedRole = String(role || '').toUpperCase();
  if (!ROOM_ROLES.has(normalizedRole)) throw new Error('Rol de sala no válido');
  const identity = `${normalizedRole.toLowerCase()}-${crypto.randomUUID()}`;
  const payload = {
    type: 'room',
    sid: crypto.randomUUID(),
    room,
    meetingId,
    role: normalizedRole,
    username,
    identity,
    displayName: String(displayName || username || (normalizedRole === 'VIEWER' ? 'Asistente' : 'Panelista')).slice(0, 80),
    invitationId,
    csrf: crypto.randomBytes(24).toString('base64url'),
    exp: Date.now() + config.roomSessionTtlMs,
  };
  return { token: signPayload(payload), session: payload };
}

function readRoomSession(req) {
  const cookies = parseCookies(req.headers.cookie);
  const selector = normalizeSessionSelector(req.headers['x-room-session-id']);
  const token = cookies[sessionCookieName(selector)];
  const payload = decodeSignedPayload(token);
  if (!payload || payload.type !== 'room' || !ROOM_ROLES.has(payload.role) || (selector && payload.sid !== selector)) return null;
  return payload;
}

function roomAuthDiagnostic(req) {
  if (config.nodeEnv === 'production') return undefined;
  const cookies = parseCookies(req.headers.cookie);
  const selector = normalizeSessionSelector(req.headers['x-room-session-id']);
  return {
    selectorPresent: Boolean(selector),
    selectedCookiePresent: Boolean(cookies[sessionCookieName(selector)]),
    csrfHeaderPresent: Boolean(req.headers['x-room-csrf']),
  };
}

function requireRoomSession(req, res, next) {
  const session = readRoomSession(req);
  if (!session) return res.status(401).json({
    error: 'Tu sesión de sala expiró o ya no corresponde a esta pestaña. Vuelve a entrar.',
    code: 'ROOM_SESSION_REQUIRED',
    diagnostic: roomAuthDiagnostic(req),
  });
  req.roomSession = session;
  req.roomSessionSelector = normalizeSessionSelector(req.headers['x-room-session-id']);
  return next();
}

function requireRoomRoles(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.roomSession || !allowed.has(req.roomSession.role)) {
      return res.status(403).json({ error: 'Tu rol de reunión no permite esta acción', code: 'ROOM_FORBIDDEN' });
    }
    return next();
  };
}

function requireRoomCsrf(req, res, next) {
  if (!req.roomSession || !safeEqual(req.headers['x-room-csrf'], req.roomSession.csrf)) {
    return res.status(403).json({
      error: 'La sesión de sala cambió en esta pestaña. Recarga la sala antes de reintentar.',
      code: 'CSRF_INVALID',
      diagnostic: roomAuthDiagnostic(req),
    });
  }
  return next();
}

function updateDisplayName(session, displayName) {
  const updated = { ...session, displayName, csrf: crypto.randomBytes(24).toString('base64url') };
  return { token: signPayload(updated), session: updated };
}

function updateConsents(session, consents) {
  const updated = {
    ...session,
    consents: {
      privacy: consents.privacy === true,
      recording: consents.recording === true,
      transcription: consents.transcription === true,
      acceptedAt: new Date().toISOString(),
    },
    csrf: crypto.randomBytes(24).toString('base64url'),
  };
  return { token: signPayload(updated), session: updated };
}

function roomCookie(token, sessionId = '') {
  return serializeCookie(sessionCookieName(sessionId), token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(config.roomSessionTtlMs / 1000),
  });
}

function clearRoomCookie(sessionId = '') {
  return serializeCookie(sessionCookieName(sessionId), '', {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  });
}

module.exports = {
  ROOM_COOKIE,
  ROOM_COOKIE_PREFIX,
  clearRoomCookie,
  createRoomSession,
  readRoomSession,
  requireRoomCsrf,
  requireRoomRoles,
  requireRoomSession,
  roomCookie,
  sessionCookieName,
  updateConsents,
  updateDisplayName,
};
