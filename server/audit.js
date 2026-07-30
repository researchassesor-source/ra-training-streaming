const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');

const ALLOWED_ACTIONS = new Set([
  'AUTH_LOGIN', 'AUTH_LOGIN_FAILED', 'AUTH_LOGOUT', 'USER_CREATED', 'USER_UPDATED',
  'USER_ROLE_CHANGED', 'USER_DEACTIVATED', 'USER_PASSWORD_RESET', 'USER_SESSIONS_REVOKED',
  'USER_DELETED', 'MEETING_CREATED', 'MEETING_UPDATED', 'MEETING_RESCHEDULED',
  'MEETING_CANCELLED', 'MEETING_ARCHIVED', 'MEETING_RESTORED', 'MEETING_STARTED',
  'MEETING_ENDED', 'MEETING_DELETED', 'INVITATION_CREATED', 'INVITATION_REDEEMED',
  'INVITATION_REVOKED', 'RECORDING_STARTED', 'RECORDING_STOPPED', 'RECORDING_DOWNLOADED',
  'PARTICIPANT_PROMOTED', 'PARTICIPANT_DEMOTED', 'PARTICIPANT_REMOVED', 'CHAT_FILE_UPLOADED',
  'RECORDING_DELETED', 'RECORDING_FAILED', 'TRANSCRIPTION_CREATED', 'TRANSCRIPTION_COMPLETED',
  'TRANSCRIPTION_FAILED', 'TRANSCRIPTION_EDITED', 'TRANSCRIPTION_RETRIED',
  'TRANSCRIPTION_CANCELLED', 'TRANSCRIPTION_DELETED',
]);

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const clean = {};
  const blocked = /password|secret|token|code|authorization|cookie/i;
  for (const [key, value] of Object.entries(metadata).slice(0, 30)) {
    if (blocked.test(key)) continue;
    if (['string', 'number', 'boolean'].includes(typeof value) || value === null) {
      clean[key] = typeof value === 'string' ? value.slice(0, 500) : value;
    }
  }
  return clean;
}

async function logEvent({ actor = 'system', action, target = null, room = null, metadata = {}, ip = '', userAgent = '' }) {
  if (!ALLOWED_ACTIONS.has(action)) throw new Error(`Acción de auditoría no permitida: ${action}`);
  const timestamp = new Date().toISOString();
  const id = `${Date.now()}-${crypto.randomUUID()}`;
  const record = {
    id,
    timestamp,
    actor: String(actor || 'system').slice(0, 100),
    action,
    target: target ? String(target).slice(0, 160) : null,
    room: room ? String(room).slice(0, 100) : null,
    metadata: safeMetadata(metadata),
    ip: String(ip || '').slice(0, 80),
    userAgent: String(userAgent || '').slice(0, 300),
  };
  if (storageConfigured) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: `audit/${id}.json`,
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  } else {
    await localStore.writeJson('audit', id, record);
  }
  return record;
}

async function listEvents({ limit = 200, action, actor, room } = {}) {
  let items;
  if (storageConfigured) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'audit/', MaxKeys: Math.min(1_000, limit * 3) }));
    items = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else {
    items = await localStore.listJson('audit');
  }
  return items
    .filter((item) => !action || item.action === action)
    .filter((item) => !actor || item.actor === actor)
    .filter((item) => !room || item.room === room)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, Math.max(1, Math.min(1_000, limit)));
}

module.exports = { ALLOWED_ACTIONS, listEvents, logEvent, safeMetadata };
