// Lightweight auth for the organizer dashboard: users stored as JSON in R2
// (same bucket as everything else), stateless signed session tokens (no
// server-side session store needed), and an env-var bootstrap admin that
// always works so there's always a way in.
const crypto = require('crypto');
const { PutObjectCommand, GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');

const SESSION_SECRET = process.env.SESSION_SECRET || 'dev-insecure-secret-change-me';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const check = crypto.scryptSync(password, salt, 64).toString('hex');
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function signSession(username) {
  const payload = JSON.stringify({ u: username, exp: Date.now() + SESSION_TTL_MS });
  const b64 = Buffer.from(payload).toString('base64url');
  const sig = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  return `${b64}.${sig}`;
}

function verifySession(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [b64, sig] = parts;
  const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expBuf = Buffer.from(expected);
  if (sigBuf.length !== expBuf.length || !crypto.timingSafeEqual(sigBuf, expBuf)) return null;
  try {
    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (!payload.exp || payload.exp < Date.now()) return null;
    return payload.u;
  } catch {
    return null;
  }
}

function userKey(username) {
  return `users/${encodeURIComponent(username)}.json`;
}

async function getUser(username) {
  if (!storageConfigured) return undefined;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: userKey(username) }));
    const body = await res.Body.transformToString();
    return JSON.parse(body);
  } catch {
    return undefined;
  }
}

async function listUsers() {
  if (!storageConfigured) return [];
  const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'users/' }));
  return (listing.Contents || []).map((obj) =>
    decodeURIComponent(obj.Key.replace('users/', '').replace('.json', ''))
  );
}

async function createUser(username, password) {
  if (!storageConfigured) throw new Error('El almacenamiento no está configurado en el servidor.');
  const record = { username, passwordHash: hashPassword(password), createdAt: Date.now() };
  await s3.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: userKey(username),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    })
  );
  return { username, createdAt: record.createdAt };
}

async function verifyLogin(username, password) {
  // The bootstrap admin (from env vars) always works, regardless of the R2 store —
  // otherwise a storage hiccup could lock everyone out permanently.
  if (process.env.ADMIN_USERNAME && process.env.ADMIN_PASSWORD && username === process.env.ADMIN_USERNAME) {
    if (password === process.env.ADMIN_PASSWORD) return true;
  }
  const user = await getUser(username);
  if (!user) return false;
  return verifyPassword(password, user.passwordHash);
}

function requireAuth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  const username = verifySession(token);
  if (!username) return res.status(401).json({ error: 'Sesión inválida o expirada' });
  req.username = username;
  next();
}

module.exports = { signSession, verifySession, createUser, verifyLogin, getUser, listUsers, requireAuth };
