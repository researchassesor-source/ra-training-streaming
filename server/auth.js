const crypto = require('crypto');
const {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { config } = require('./config');
const {
  AppError,
  parseCookies,
  safeEqual,
  serializeCookie,
  validatePassword,
  validateUsername,
} = require('./http-utils');

const AUTH_COOKIE = 'rat_session';
const ROLES = Object.freeze(['ADMIN', 'ORGANIZER', 'PANELIST', 'VIEWER']);
const ROLE_SET = new Set(ROLES);

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  validatePassword(password);
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  if (typeof password !== 'string' || typeof stored !== 'string') return false;
  const [salt, hash] = stored.split(':');
  if (!salt || !hash || !/^[a-f0-9]+$/i.test(hash)) return false;
  try {
    const check = crypto.scryptSync(password, salt, 64).toString('hex');
    return safeEqual(hash, check);
  } catch {
    return false;
  }
}

function normalizeRole(role, fallback = 'ORGANIZER') {
  const normalized = String(role || fallback).toUpperCase();
  if (!ROLE_SET.has(normalized)) {
    throw new AppError(400, 'Rol no válido', 'VALIDATION_ERROR');
  }
  return normalized;
}

function userKey(username) {
  return `users/${encodeURIComponent(username)}.json`;
}

async function readRemoteUser(username) {
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: userKey(username) }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

function stateInS3() {
  return storageConfigured && !localStore.usesPostgres();
}

async function writeUser(record) {
  if (stateInS3()) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: userKey(record.username),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  } else {
    await localStore.writeJson('users', record.username, record);
  }
  return record;
}

function bootstrapUser() {
  if (!process.env.ADMIN_USERNAME || !process.env.ADMIN_PASSWORD) return null;
  return {
    username: String(process.env.ADMIN_USERNAME).toLowerCase(),
    role: 'ADMIN',
    active: true,
    bootstrap: true,
    sessionVersion: 1,
    createdAt: null,
    updatedAt: null,
    lastLoginAt: null,
  };
}

async function getUser(username, { includeBootstrap = true } = {}) {
  const normalized = String(username || '').toLowerCase();
  const bootstrap = bootstrapUser();
  if (includeBootstrap && bootstrap && bootstrap.username === normalized) return bootstrap;
  const user = stateInS3()
    ? await readRemoteUser(normalized)
    : await localStore.readJson('users', normalized);
  if (!user) return undefined;
  return {
    ...user,
    username: normalized,
    role: normalizeRole(user.role, 'ORGANIZER'),
    active: user.active !== false,
    sessionVersion: Number.isInteger(user.sessionVersion) ? user.sessionVersion : 1,
  };
}

async function listStoredUsers() {
  if (!stateInS3()) return localStore.listJson('users');
  const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'users/' }));
  return Promise.all((listing.Contents || []).map(async (object) => {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
    return JSON.parse(await response.Body.transformToString());
  }));
}

function publicUser(user) {
  return {
    username: user.username,
    role: normalizeRole(user.role, 'ORGANIZER'),
    active: user.active !== false,
    bootstrap: Boolean(user.bootstrap),
    createdAt: user.createdAt || null,
    updatedAt: user.updatedAt || null,
    lastLoginAt: user.lastLoginAt || null,
    sessionVersion: Number.isInteger(user.sessionVersion) ? user.sessionVersion : 1,
  };
}

async function listUsers() {
  const users = (await listStoredUsers()).map((user) => publicUser(user));
  const bootstrap = bootstrapUser();
  if (bootstrap && !users.some((user) => user.username === bootstrap.username)) users.unshift(publicUser(bootstrap));
  return users.sort((a, b) => {
    if (a.bootstrap !== b.bootstrap) return a.bootstrap ? -1 : 1;
    return a.username.localeCompare(b.username);
  });
}

async function createUser({ username, password, role = 'ORGANIZER', active = true }) {
  const normalized = validateUsername(username);
  const normalizedRole = normalizeRole(role);
  validatePassword(password);
  if (await getUser(normalized)) throw new AppError(409, 'El usuario ya existe', 'DUPLICATE_USER');
  const now = new Date().toISOString();
  const record = {
    username: normalized,
    passwordHash: hashPassword(password),
    role: normalizedRole,
    active: active !== false,
    sessionVersion: 1,
    createdAt: now,
    updatedAt: now,
    lastLoginAt: null,
  };
  await writeUser(record);
  return publicUser(record);
}

async function updateUser(username, updates) {
  const normalized = validateUsername(username);
  const existing = await getUser(normalized);
  if (!existing) throw new AppError(404, 'Usuario no encontrado', 'NOT_FOUND');
  if (existing.bootstrap) throw new AppError(400, 'El administrador bootstrap se gestiona mediante variables de entorno', 'BOOTSTRAP_USER');

  const record = { ...existing, updatedAt: new Date().toISOString() };
  delete record.bootstrap;
  if (updates.role !== undefined) {
    const nextRole = normalizeRole(updates.role);
    if (record.role !== nextRole) record.sessionVersion += 1;
    record.role = nextRole;
  }
  if (updates.active !== undefined) {
    if (typeof updates.active !== 'boolean') throw new AppError(400, 'active debe ser booleano', 'VALIDATION_ERROR');
    if (record.active !== updates.active) record.sessionVersion += 1;
    record.active = updates.active;
  }
  await ensureAdminRemains(existing, record);
  await writeUser(record);
  return publicUser(record);
}

async function resetPassword(username, password) {
  validatePassword(password);
  const normalized = validateUsername(username);
  const existing = await getUser(normalized);
  if (!existing) throw new AppError(404, 'Usuario no encontrado', 'NOT_FOUND');
  if (existing.bootstrap) throw new AppError(400, 'La contraseña bootstrap se gestiona mediante variables de entorno', 'BOOTSTRAP_USER');
  const record = {
    ...existing,
    passwordHash: hashPassword(password),
    sessionVersion: existing.sessionVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  delete record.bootstrap;
  await writeUser(record);
  return publicUser(record);
}

async function revokeSessions(username) {
  const normalized = validateUsername(username);
  const existing = await getUser(normalized);
  if (!existing) throw new AppError(404, 'Usuario no encontrado', 'NOT_FOUND');
  if (existing.bootstrap) throw new AppError(400, 'Reinicia SESSION_SECRET para revocar de forma global el acceso bootstrap', 'BOOTSTRAP_USER');
  const record = {
    ...existing,
    sessionVersion: existing.sessionVersion + 1,
    updatedAt: new Date().toISOString(),
  };
  delete record.bootstrap;
  await writeUser(record);
  return publicUser(record);
}

async function ensureAdminRemains(before, after) {
  if (before.role !== 'ADMIN' || (after.role === 'ADMIN' && after.active !== false)) return;
  const users = await listUsers();
  const otherAdmin = users.some((user) => user.username !== before.username && user.role === 'ADMIN' && user.active);
  if (!otherAdmin) throw new AppError(409, 'No se puede desactivar o degradar al último ADMIN', 'LAST_ADMIN');
}

async function deleteUser(username) {
  const normalized = validateUsername(username);
  const existing = await getUser(normalized);
  if (!existing) throw new AppError(404, 'Usuario no encontrado', 'NOT_FOUND');
  if (existing.bootstrap) throw new AppError(400, 'No se puede eliminar el administrador bootstrap', 'BOOTSTRAP_USER');
  await ensureAdminRemains(existing, { ...existing, active: false, role: 'VIEWER' });
  if (stateInS3()) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: userKey(normalized) }));
  } else {
    await localStore.deleteJson('users', normalized);
  }
  return true;
}

async function authenticate(username, password) {
  const normalized = String(username || '').toLowerCase();
  const bootstrap = bootstrapUser();
  if (bootstrap && bootstrap.username === normalized && safeEqual(password, process.env.ADMIN_PASSWORD)) return bootstrap;
  const user = await getUser(normalized, { includeBootstrap: false });
  if (!user || !user.active || !verifyPassword(password, user.passwordHash)) return null;
  const updated = { ...user, lastLoginAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  delete updated.bootstrap;
  await writeUser(updated);
  return updated;
}

function signPayload(payload) {
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.sessionSecret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function decodeSignedPayload(token) {
  if (!token || typeof token !== 'string') return null;
  const [encoded, signature, extra] = token.split('.');
  if (!encoded || !signature || extra) return null;
  const expected = crypto.createHmac('sha256', config.sessionSecret).update(encoded).digest('base64url');
  if (!safeEqual(signature, expected)) return null;
  try {
    const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
    if (!payload.exp || payload.exp <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function signSession(user) {
  return signPayload({
    type: 'auth',
    sid: crypto.randomUUID(),
    u: user.username,
    role: normalizeRole(user.role, 'ORGANIZER'),
    sv: user.sessionVersion || 1,
    csrf: crypto.randomBytes(24).toString('base64url'),
    exp: Date.now() + config.sessionTtlMs,
  });
}

async function verifySession(token) {
  const payload = decodeSignedPayload(token);
  if (!payload || payload.type !== 'auth' || !payload.u || !ROLE_SET.has(payload.role)) return null;
  const user = await getUser(payload.u);
  if (!user || !user.active || (user.sessionVersion || 1) !== payload.sv || user.role !== payload.role) return null;
  return { ...payload, role: user.role, user: publicUser(user) };
}

function getRequestToken(req) {
  const cookies = parseCookies(req.headers.cookie);
  if (cookies[AUTH_COOKIE]) return cookies[AUTH_COOKIE];
  const header = String(req.headers.authorization || '');
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requireAuth(req, res, next) {
  try {
    const session = await verifySession(getRequestToken(req));
    if (!session) return res.status(401).json({ error: 'Sesión inválida o expirada', code: 'AUTH_REQUIRED' });
    req.auth = session;
    req.username = session.u;
    return next();
  } catch (error) {
    return next(error);
  }
}

function requireRoles(...roles) {
  const allowed = new Set(roles);
  return (req, res, next) => {
    if (!req.auth || !allowed.has(req.auth.role)) {
      return res.status(403).json({ error: 'No tienes permisos para esta acción', code: 'FORBIDDEN' });
    }
    return next();
  };
}

function requireCsrf(req, res, next) {
  const supplied = req.headers['x-csrf-token'];
  if (!req.auth || !safeEqual(supplied, req.auth.csrf)) {
    return res.status(403).json({ error: 'La solicitud no pudo validarse', code: 'CSRF_INVALID' });
  }
  return next();
}

function authCookie(token) {
  return serializeCookie(AUTH_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
}

function clearAuthCookie() {
  return serializeCookie(AUTH_COOKIE, '', {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'Lax',
    path: '/',
    maxAge: 0,
    expires: new Date(0),
  });
}

module.exports = {
  AUTH_COOKIE,
  ROLES,
  authCookie,
  authenticate,
  bootstrapUser,
  clearAuthCookie,
  createUser,
  decodeSignedPayload,
  deleteUser,
  getUser,
  hashPassword,
  listUsers,
  normalizeRole,
  publicUser,
  requireAuth,
  requireCsrf,
  requireRoles,
  resetPassword,
  revokeSessions,
  signPayload,
  signSession,
  updateUser,
  verifyPassword,
  verifySession,
};
