const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const db = require('./db');
const { decodeCursor, encodeCursor } = require('./pagination');
const { AppError } = require('./http-utils');

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
  'TRANSCRIPTION_CANCELLED', 'TRANSCRIPTION_DELETED', 'ROOM_OPEN_ATTEMPT',
  'TRANSCRIPTION_REQUESTED', 'TRANSCRIPTION_VALIDATION_FAILED', 'TRANSCRIPTION_STARTED',
  'TRANSCRIPTION_PROVIDER_SUBMITTED', 'TRANSCRIPTION_SPEAKER_RENAMED', 'TRANSCRIPTION_EXPORTED',
  'ROOM_CONNECTION_FAILED', 'ROOM_RETRY', 'ROOM_CONNECTED', 'ROOM_ENDED',
  'PARTICIPANT_JOINED', 'PARTICIPANT_LEFT', 'PARTICIPANT_RECONNECTED',
  'PARTICIPANT_BLOCKED', 'MICROPHONE_MUTED', 'SCREEN_SHARE_STARTED',
  'SCREEN_SHARE_STOPPED', 'ROOM_LOCKED', 'ROOM_UNLOCKED', 'QUESTION_CREATED',
  'QUESTION_EDITED', 'QUESTION_ANSWERED', 'QUESTION_DISMISSED',
  'MICROPHONE_REQUESTED', 'MICROPHONE_REQUEST_ACCEPTED', 'MICROPHONE_REQUEST_REJECTED',
  'MICROPHONE_REQUEST_FAILED', 'SPEAKING_RIGHT_GRANTED', 'SPEAKING_RIGHT_REVOKED', 'HAND_REJECTED',
  'PARTICIPANT_CONSENT_RECORDED', 'PARTICIPANT_ROLE_CHANGED',
  'MEDIA_PERMISSION_GRANTED', 'MEDIA_PERMISSION_REVOKED',
  'SERIES_CREATED', 'SERIES_UPDATED', 'SERIES_RESCHEDULED', 'SERIES_ACCESS_CREATED',
  'SERIES_ARCHIVED', 'SERIES_RESTORED',
  'SERIES_ACCESS_REVOKED', 'SERIES_ACCESS_REGENERATED', 'SPEAKER_REQUESTED',
  'SPEAKER_GRANTED', 'SPEAKER_REJECTED', 'SPEAKER_REVOKED', 'ATTENDANCE_UPDATED',
  'SERIES_SESSION_ENTERED',
]);

function stateInS3() {
  return storageConfigured && !localStore.usesPostgres();
}

function safeMetadata(metadata) {
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return {};
  const clean = {};
  const blocked = /password|secret|token|authorization|cookie/i;
  for (const [key, value] of Object.entries(metadata).slice(0, 30)) {
    if (blocked.test(key) || /^code$/i.test(key)) continue;
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
  if (stateInS3()) {
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

function validateFilter(value, field) {
  if (value === undefined || value === null || value === '') return null;
  const text = String(value);
  if (!/^[\w:./ -]{1,160}$/u.test(text)) throw new AppError(400, `Filtro ${field} no válido`, 'VALIDATION_ERROR');
  return text;
}

async function listPostgresEvents({ limit, action, actor, room, cursor } = {}) {
  const params = [];
  const where = [];
  const safeAction = validateFilter(action, 'action');
  const safeActor = validateFilter(actor, 'actor');
  const safeRoom = validateFilter(room, 'room');
  if (safeAction) { params.push(safeAction); where.push(`action = $${params.length}`); }
  if (safeActor) { params.push(safeActor); where.push(`actor = $${params.length}`); }
  if (safeRoom) { params.push(safeRoom); where.push(`room = $${params.length}`); }
  const decoded = decodeCursor(cursor);
  if (decoded) {
    if (!decoded.timestamp || !decoded.id) throw new AppError(400, 'Cursor de auditoría no válido', 'VALIDATION_ERROR');
    params.push(decoded.timestamp, decoded.id);
    where.push(`(timestamp, id) < ($${params.length - 1}::timestamptz, $${params.length})`);
  }
  params.push(limit + 1);
  const result = await db.query(
    `SELECT data FROM audit_events
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY timestamp DESC, id DESC
     LIMIT $${params.length}`,
    params
  );
  const rows = result.rows.map((row) => row.data);
  const items = rows.slice(0, limit);
  return {
    items,
    nextCursor: rows.length > limit && items.length ? encodeCursor({ timestamp: items.at(-1).timestamp, id: items.at(-1).id }) : null,
  };
}

async function listEvents({ limit = 200, action, actor, room, cursor, page = false } = {}) {
  const boundedLimit = Math.max(1, Math.min(1_000, Number(limit) || 200));
  if (!stateInS3() && localStore.usesPostgres()) {
    const result = await listPostgresEvents({ limit: boundedLimit, action, actor, room, cursor });
    return page ? result : result.items;
  }
  let items;
  if (stateInS3()) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'audit/', MaxKeys: Math.min(1_000, limit * 3) }));
    items = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else {
    items = await localStore.listJson('audit');
  }
  const filtered = items
    .filter((item) => !action || item.action === action)
    .filter((item) => !actor || item.actor === actor)
    .filter((item) => !room || item.room === room)
    .sort((a, b) => String(b.timestamp).localeCompare(String(a.timestamp)))
    .slice(0, boundedLimit);
  return page ? { items: filtered, nextCursor: null } : filtered;
}

module.exports = { ALLOWED_ACTIONS, listEvents, logEvent, safeMetadata };
