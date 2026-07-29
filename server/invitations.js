const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { config } = require('./config');
const { AppError } = require('./http-utils');

const INVITATION_ROLES = new Set(['PANELIST', 'VIEWER']);
const consumeLocks = new Map();

function tokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function keyForHash(hash) {
  return `invitations/${hash}.json`;
}

async function writeInvitation(record) {
  if (storageConfigured) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: keyForHash(record.tokenHash),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  } else {
    await localStore.writeJson('invitations', record.tokenHash, record);
  }
  return record;
}

async function getByToken(token) {
  const hash = tokenHash(token);
  if (!storageConfigured) return localStore.readJson('invitations', hash);
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyForHash(hash) }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function listInvitations({ room } = {}) {
  let items;
  if (storageConfigured) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'invitations/' }));
    items = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else {
    items = await localStore.listJson('invitations');
  }
  const now = Date.now();
  return items
    .filter((item) => !room || item.room === room)
    .map(publicInvitation)
    .map((item) => ({ ...item, status: deriveStatus(item, now) }))
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function deriveStatus(record, now = Date.now()) {
  if (record.revokedAt || record.status === 'REVOKED') return 'REVOKED';
  if (new Date(record.expiresAt).getTime() <= now) return 'EXPIRED';
  if (record.maxUses !== null && record.uses >= record.maxUses) return 'USED';
  return 'ACTIVE';
}

function publicInvitation(record) {
  return {
    id: record.id,
    meetingId: record.meetingId,
    room: record.room,
    role: record.role,
    expiresAt: record.expiresAt,
    status: record.status,
    maxUses: record.maxUses,
    uses: record.uses,
    createdAt: record.createdAt,
    createdBy: record.createdBy,
    revokedAt: record.revokedAt || null,
    lastUsedAt: record.lastUsedAt || null,
  };
}

async function createInvitation({ meetingId, room, role, expiresInMinutes, singleUse = false, maxUses, createdBy }) {
  const normalizedRole = String(role || '').toUpperCase();
  if (!INVITATION_ROLES.has(normalizedRole)) throw new AppError(400, 'El rol de invitación debe ser PANELIST o VIEWER', 'VALIDATION_ERROR');
  if (typeof singleUse !== 'boolean') throw new AppError(400, 'singleUse debe ser booleano', 'VALIDATION_ERROR');
  const ttl = Number.isInteger(expiresInMinutes) ? expiresInMinutes : config.invitationTtlMinutes;
  if (ttl < 5 || ttl > 43_200) throw new AppError(400, 'La expiración debe estar entre 5 y 43200 minutos', 'VALIDATION_ERROR');
  let allowedUses = null;
  if (singleUse) allowedUses = 1;
  else if (maxUses !== undefined && maxUses !== null) {
    if (!Number.isInteger(maxUses) || maxUses < 1 || maxUses > 100_000) throw new AppError(400, 'maxUses no válido', 'VALIDATION_ERROR');
    allowedUses = maxUses;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  const now = new Date();
  const record = {
    id: crypto.randomUUID(),
    tokenHash: tokenHash(token),
    meetingId,
    room,
    role: normalizedRole,
    expiresAt: new Date(now.getTime() + ttl * 60_000).toISOString(),
    status: 'ACTIVE',
    maxUses: allowedUses,
    uses: 0,
    createdAt: now.toISOString(),
    createdBy,
    revokedAt: null,
    lastUsedAt: null,
  };
  await writeInvitation(record);
  return { token, invitation: publicInvitation(record) };
}

async function consumeInvitation(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 100) {
    throw new AppError(404, 'Invitación no válida', 'INVITATION_INVALID');
  }
  const hash = tokenHash(token);
  const previous = consumeLocks.get(hash) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  consumeLocks.set(hash, current);
  await previous;
  try {
    const record = await getByToken(token);
    if (!record) throw new AppError(404, 'Invitación no válida', 'INVITATION_INVALID');
    const status = deriveStatus(record);
    if (status !== 'ACTIVE') {
      const messages = {
        EXPIRED: 'La invitación expiró',
        REVOKED: 'La invitación fue revocada',
        USED: 'La invitación ya fue utilizada',
      };
      throw new AppError(410, messages[status] || 'La invitación no está activa', `INVITATION_${status}`);
    }
    const now = new Date().toISOString();
    const updated = {
      ...record,
      uses: record.uses + 1,
      lastUsedAt: now,
    };
    if (updated.maxUses !== null && updated.uses >= updated.maxUses) updated.status = 'USED';
    await writeInvitation(updated);
    return publicInvitation(updated);
  } finally {
    release();
    if (consumeLocks.get(hash) === current) consumeLocks.delete(hash);
  }
}

async function revokeInvitation(id, room) {
  let records;
  if (storageConfigured) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'invitations/' }));
    records = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else {
    records = await localStore.listJson('invitations');
  }
  const record = records.find((item) => item.id === id && (!room || item.room === room));
  if (!record) throw new AppError(404, 'Invitación no encontrada', 'NOT_FOUND');
  const updated = { ...record, status: 'REVOKED', revokedAt: new Date().toISOString() };
  await writeInvitation(updated);
  return publicInvitation(updated);
}

module.exports = {
  INVITATION_ROLES,
  consumeInvitation,
  createInvitation,
  deriveStatus,
  getByToken,
  listInvitations,
  publicInvitation,
  revokeInvitation,
  tokenHash,
};
