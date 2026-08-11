const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { config } = require('./config');
const { AppError, sanitizeText, slugify } = require('./http-utils');
const { normalizeMeetingRole, normalizeMeetingType } = require('./meeting-permissions');

const SECTION = 'series-accesses';
const locks = new Map();

function keyFor(id) { return `series-accesses/${encodeURIComponent(id)}.json`; }
function signatureFor(id) { return crypto.createHmac('sha256', config.invitationHashSecret || config.sessionSecret).update(`series-access:${id}`).digest('base64url'); }
function tokenFor(id) { return `${id}.${signatureFor(id)}`; }
function tokenHash(token) { return crypto.createHash('sha256').update(String(token)).digest('hex'); }
function safeEqual(left, right) {
  const a = Buffer.from(String(left)); const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function publicRole(type) { return ({ WEBINAR: 'ATTENDEE', SESSION: 'PARTICIPANT', CLASS: 'STUDENT' })[normalizeMeetingType(type)]; }

async function writeAccess(record) {
  if (storageConfigured) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(record.id), Body: JSON.stringify(record), ContentType: 'application/json' }));
  else await localStore.writeJson(SECTION, record.id, record);
  return record;
}

async function getAccess(id) {
  if (!id) return undefined;
  if (!storageConfigured) return localStore.readJson(SECTION, id);
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(id) }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function listAccesses({ seriesId } = {}) {
  let items;
  if (storageConfigured) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'series-accesses/' }));
    items = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else items = await localStore.listJson(SECTION);
  return items.filter((item) => !seriesId || item.seriesId === seriesId).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function withLock(key, operation) {
  const previous = locks.get(key) || Promise.resolve(); let release;
  const current = new Promise((resolve) => { release = resolve; }); locks.set(key, current); await previous;
  try { return await operation(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

function participantKeyFor(name, supplied) {
  const explicit = String(supplied || '').trim().toLowerCase();
  if (explicit) return sanitizeText(explicit, { field: 'participantKey', min: 2, max: 80, required: true }).replace(/\s+/g, '-');
  return slugify(name).slice(0, 80);
}

async function createOrGetAccess({ series, participantName, participantKey, meetingRole, createdBy }) {
  const name = sanitizeText(participantName, { field: 'participantName', min: 2, max: 80, required: true });
  const type = normalizeMeetingType(series.type);
  const role = normalizeMeetingRole(type, meetingRole || publicRole(type));
  if (role !== publicRole(type)) throw new AppError(400, 'El acceso estable solo admite la funci\u00f3n participante de esta modalidad', 'SERIES_ROLE_FORBIDDEN');
  const key = participantKeyFor(name, participantKey);
  return withLock(`${series.id}:${key}:${role}`, async () => {
    const existing = (await listAccesses({ seriesId: series.id })).find((item) => item.status === 'ACTIVE' && item.participantKey === key && item.meetingRole === role);
    if (existing) return { access: existing, token: tokenFor(existing.id), reused: true };
    const id = crypto.randomUUID(); const token = tokenFor(id); const now = new Date().toISOString();
    const record = {
      id, seriesId: series.id, mode: 'INDIVIDUAL', participantKey: key, participantName: name,
      meetingType: type, meetingRole: role, tokenHash: tokenHash(token), status: 'ACTIVE',
      createdBy: String(createdBy || '').slice(0, 80), createdAt: now, updatedAt: now,
      revokedAt: null, lastUsedAt: null, usageCount: 0,
    };
    await writeAccess(record);
    return { access: record, token, reused: false };
  });
}

async function resolveToken(token, { touch = false } = {}) {
  const match = /^([a-f0-9-]{36})\.([A-Za-z0-9_-]{40,60})$/.exec(String(token || ''));
  if (!match || !safeEqual(match[2], signatureFor(match[1]))) throw new AppError(404, 'Acceso de capacitaci\u00f3n no v\u00e1lido', 'SERIES_ACCESS_NOT_FOUND');
  const record = await getAccess(match[1]);
  if (!record || !safeEqual(record.tokenHash, tokenHash(token))) throw new AppError(404, 'Acceso de capacitaci\u00f3n no v\u00e1lido', 'SERIES_ACCESS_NOT_FOUND');
  if (record.status !== 'ACTIVE' || record.revokedAt) throw new AppError(410, 'Este acceso fue revocado', 'SERIES_ACCESS_REVOKED');
  if (!touch) return record;
  const updated = { ...record, lastUsedAt: new Date().toISOString(), usageCount: Number(record.usageCount || 0) + 1, updatedAt: new Date().toISOString() };
  await writeAccess(updated);
  return updated;
}

async function revokeAccess(id, seriesId = null) {
  const existing = await getAccess(id);
  if (!existing || (seriesId && existing.seriesId !== seriesId)) throw new AppError(404, 'Acceso no encontrado', 'NOT_FOUND');
  if (existing.status === 'REVOKED') return existing;
  return writeAccess({ ...existing, status: 'REVOKED', revokedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
}

async function regenerateAccess(id, series, createdBy) {
  const existing = await revokeAccess(id, series.id);
  return createOrGetAccess({ series, participantName: existing.participantName, participantKey: existing.participantKey, meetingRole: existing.meetingRole, createdBy });
}

function publicAccess(record, { includeUrl = false } = {}) {
  const result = {
    id: record.id, seriesId: record.seriesId, mode: record.mode, participantKey: record.participantKey,
    participantName: record.participantName, meetingType: record.meetingType, meetingRole: record.meetingRole,
    status: record.status, createdAt: record.createdAt, revokedAt: record.revokedAt || null,
    lastUsedAt: record.lastUsedAt || null, usageCount: Number(record.usageCount || 0),
  };
  if (includeUrl && record.status === 'ACTIVE') result.url = `${config.appPublicUrl}/s/${tokenFor(record.id)}`;
  return result;
}

module.exports = { createOrGetAccess, getAccess, listAccesses, publicAccess, publicRole, regenerateAccess, resolveToken, revokeAccess, tokenFor };
