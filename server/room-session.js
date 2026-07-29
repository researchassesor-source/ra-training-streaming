const crypto = require('crypto');
const { config } = require('./config');
const { decodeSignedPayload, signPayload } = require('./auth');
const { parseCookies, safeEqual, serializeCookie } = require('./http-utils');

const ROOM_COOKIE = 'rat_room_session';
const ROOM_ROLES = new Set(['ADMIN', 'ORGANIZER', 'PANELIST', 'VIEWER']);

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
  const token = parseCookies(req.headers.cookie)[ROOM_COOKIE];
  const payload = decodeSignedPayload(token);
  if (!payload || payload.type !== 'room' || !ROOM_ROLES.has(payload.role)) return null;
  return payload;
}

function requireRoomSession(req, res, next) {
  const session = readRoomSession(req);
  if (!session) return res.status(401).json({ error: 'La sesión de reunión no es válida o expiró', code: 'ROOM_SESSION_REQUIRED' });
  req.roomSession = session;
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
    return res.status(403).json({ error: 'La solicitud de reunión no pudo validarse', code: 'CSRF_INVALID' });
  }
  return next();
}

function updateDisplayName(session, displayName) {
  const updated = { ...session, displayName, csrf: crypto.randomBytes(24).toString('base64url') };
  return { token: signPayload(updated), session: updated };
}

function roomCookie(token) {
  return serializeCookie(ROOM_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(config.roomSessionTtlMs / 1000),
  });
}

function clearRoomCookie() {
  return serializeCookie(ROOM_COOKIE, '', {
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
  clearRoomCookie,
  createRoomSession,
  readRoomSession,
  requireRoomCsrf,
  requireRoomRoles,
  requireRoomSession,
  roomCookie,
  updateDisplayName,
};
