const crypto = require('crypto');
const { config } = require('./config');
const { decodeSignedPayload, signPayload } = require('./auth');
const { parseCookies, safeEqual, serializeCookie } = require('./http-utils');

const SERIES_COOKIE = 'rat_series_access';

function createSeriesSession(access) {
  const payload = {
    type: 'series-access', sid: crypto.randomUUID(), seriesId: access.seriesId, accessId: access.id,
    participantKey: access.participantKey, displayName: access.participantName, meetingType: access.meetingType,
    meetingRole: access.meetingRole, csrf: crypto.randomBytes(24).toString('base64url'), consents: null,
    exp: Date.now() + config.roomSessionTtlMs,
  };
  return { token: signPayload(payload), session: payload };
}

function readSeriesSession(req) {
  const payload = decodeSignedPayload(parseCookies(req.headers.cookie)[SERIES_COOKIE]);
  return payload?.type === 'series-access' ? payload : null;
}

function requireSeriesSession(req, res, next) {
  const session = readSeriesSession(req);
  if (!session) return res.status(401).json({ error: 'Vuelve a abrir tu enlace de capacitaci\u00f3n', code: 'SERIES_SESSION_REQUIRED' });
  req.seriesSession = session; return next();
}

function requireSeriesCsrf(req, res, next) {
  if (!req.seriesSession || !safeEqual(req.headers['x-series-csrf'], req.seriesSession.csrf)) {
    return res.status(403).json({ error: 'La sesi\u00f3n de capacitaci\u00f3n cambi\u00f3. Recarga la p\u00e1gina.', code: 'CSRF_INVALID' });
  }
  return next();
}

function updateSeriesSession(session, changes) {
  const updated = { ...session, ...changes, csrf: crypto.randomBytes(24).toString('base64url') };
  return { token: signPayload(updated), session: updated };
}

function seriesCookie(token) {
  return serializeCookie(SERIES_COOKIE, token, { httpOnly: true, secure: config.cookieSecure, sameSite: 'Lax', path: '/', maxAge: Math.floor(config.roomSessionTtlMs / 1000) });
}

module.exports = { SERIES_COOKIE, createSeriesSession, readSeriesSession, requireSeriesCsrf, requireSeriesSession, seriesCookie, updateSeriesSession };
