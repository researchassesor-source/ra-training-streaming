const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const db = require('./db');
const postgresStore = require('./db/postgres-store');
const { config } = require('./config');
const { AppError } = require('./http-utils');
const {
  invitationRolesForType,
  legacyDefaultMeetingRole,
  legacyRoleForMeetingRole,
  normalizeMeetingRole,
  normalizeMeetingType,
} = require('./meeting-permissions');

const INVITATION_ROLES = new Set(['PANELIST', 'VIEWER']);
const consumeLocks = new Map();

function tokenHash(token) {
  return crypto.createHmac('sha256', config.invitationHashSecret).update(String(token)).digest('hex');
}

function legacyTokenHash(token) {
  return crypto.createHash('sha256').update(String(token)).digest('hex');
}

function tokenHashes(token) {
  return [...new Set([tokenHash(token), legacyTokenHash(token)])];
}

function keyForHash(hash) {
  return `invitations/${hash}.json`;
}

function stateInS3() {
  return storageConfigured && !localStore.usesPostgres();
}

async function writeInvitation(record) {
  if (stateInS3()) {
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
  for (const hash of tokenHashes(token)) {
    if (!stateInS3()) {
      const record = await localStore.readJson('invitations', hash);
      if (record) return record;
      continue;
    }
    try {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyForHash(hash) }));
      return JSON.parse(await response.Body.transformToString());
    } catch (error) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
    }
  }
  return undefined;
}

async function listInvitations({ room } = {}) {
  let items;
  if (stateInS3()) {
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
  const meetingType = normalizeMeetingType(record.meetingType || 'WEBINAR');
  const meetingRole = record.meetingRole
    ? normalizeMeetingRole(meetingType, record.meetingRole, record.role)
    : legacyDefaultMeetingRole(meetingType, record.role);
  return {
    id: record.id,
    meetingId: record.meetingId,
    room: record.room,
    role: record.role,
    meetingType,
    meetingRole,
    legacyAccess: typeof record.legacyAccess === 'boolean' ? record.legacyAccess : !record.meetingRole,
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

async function createInvitation({ meetingId, room, role, meetingType, meetingRole, expiresInMinutes, singleUse = false, maxUses, createdBy }) {
  const hasMeetingProfile = Boolean(meetingType || meetingRole);
  const normalizedType = normalizeMeetingType(meetingType || 'WEBINAR');
  const requestedRole = String(meetingRole || role || '').toUpperCase();
  let normalizedMeetingRole;
  let normalizedRole;
  if (hasMeetingProfile) {
    const legacyAliases = new Set(['ADMIN', 'ORGANIZER', 'PANELIST', 'VIEWER']);
    normalizedMeetingRole = legacyAliases.has(requestedRole)
      ? legacyDefaultMeetingRole(normalizedType, requestedRole)
      : requestedRole;
    if (!invitationRolesForType(normalizedType).includes(normalizedMeetingRole)) {
      throw new AppError(400, `El rol no es válido para una reunión ${normalizedType}`, 'VALIDATION_ERROR');
    }
    normalizedRole = legacyRoleForMeetingRole(normalizedType, normalizedMeetingRole, role);
  } else {
    normalizedRole = String(role || '').toUpperCase();
    if (!INVITATION_ROLES.has(normalizedRole)) throw new AppError(400, 'El rol de invitación debe ser PANELIST o VIEWER', 'VALIDATION_ERROR');
    normalizedMeetingRole = legacyDefaultMeetingRole(normalizedType, normalizedRole);
  }
  if (typeof singleUse !== 'boolean') throw new AppError(400, 'singleUse debe ser booleano', 'VALIDATION_ERROR');
  const ttl = Number.isInteger(expiresInMinutes) ? expiresInMinutes : config.invitationTtlMinutes;
  if (ttl < 5 || ttl > 43_200) throw new AppError(400, 'La expiración debe estar entre 5 y 43200 minutos', 'VALIDATION_ERROR');
  let allowedUses = null;
  const privileged = ['HOST', 'TEACHER', 'COHOST'].includes(normalizedMeetingRole);
  if (singleUse || privileged) allowedUses = 1;
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
    meetingType: normalizedType,
    meetingRole: normalizedMeetingRole,
    legacyAccess: !hasMeetingProfile,
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
  if (localStore.usesPostgres()) return consumeInvitationPostgres(token);
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

async function consumeInvitationPostgres(token) {
  const hashes = tokenHashes(token);
  return db.transaction(async (client) => {
    const result = await client.query('SELECT data FROM invitations WHERE token_hash = ANY($1::text[]) FOR UPDATE', [hashes]);
    const record = result.rows[0]?.data;
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
    const updated = { ...record, uses: record.uses + 1, lastUsedAt: now };
    if (updated.maxUses !== null && updated.uses >= updated.maxUses) updated.status = 'USED';
    await postgresStore.writeJson('invitations', updated.tokenHash, updated, client);
    return publicInvitation(updated);
  });
}

async function peekInvitation(token) {
  if (typeof token !== 'string' || token.length < 40 || token.length > 100) {
    throw new AppError(404, 'Invitación no válida', 'INVITATION_INVALID');
  }
  const record = await getByToken(token);
  if (!record) throw new AppError(404, 'Invitación no válida', 'INVITATION_INVALID');
  const status = deriveStatus(record);
  if (status !== 'ACTIVE') {
    const messages = { EXPIRED: 'La invitación expiró', REVOKED: 'La invitación fue revocada', USED: 'La invitación ya fue utilizada' };
    throw new AppError(410, messages[status] || 'La invitación no está activa', `INVITATION_${status}`);
  }
  return publicInvitation(record);
}

async function revokeInvitation(id, room) {
  let records;
  if (stateInS3()) {
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
  legacyTokenHash,
  peekInvitation,
  publicInvitation,
  revokeInvitation,
  tokenHash,
};
