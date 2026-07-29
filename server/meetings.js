const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const {
  AppError,
  parseBoolean,
  parseDate,
  parsePositiveInteger,
  sanitizeText,
  slugify,
} = require('./http-utils');

const TYPES = Object.freeze(['WEBINAR', 'SESSION', 'CLASS']);
const STATUSES = Object.freeze(['DRAFT', 'SCHEDULED', 'LIVE', 'COMPLETED', 'CANCELLED', 'ARCHIVED']);
const ACCESS_MODES = Object.freeze(['INVITATION', 'AUTHENTICATED', 'CLOSED']);

function keyFor(room) {
  return `meetings/${encodeURIComponent(room)}.json`;
}

async function writeMeeting(record) {
  if (storageConfigured) {
    await s3.send(new PutObjectCommand({
      Bucket: bucket,
      Key: keyFor(record.room),
      Body: JSON.stringify(record),
      ContentType: 'application/json',
    }));
  } else {
    await localStore.writeJson('meetings', record.room, record);
  }
  return record;
}

async function getMeeting(room) {
  const normalized = String(room || '');
  if (!normalized) return undefined;
  if (!storageConfigured) return localStore.readJson('meetings', normalized);
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(normalized) }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function listMeetings({ includeDeleted = false } = {}) {
  let items;
  if (storageConfigured) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'meetings/' }));
    items = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else {
    items = await localStore.listJson('meetings');
  }
  return items
    .filter((meeting) => includeDeleted || !meeting.deletedAt)
    .sort((a, b) => String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')));
}

function enumValue(value, allowed, field, fallback) {
  const normalized = String(value || fallback).toUpperCase();
  if (!allowed.includes(normalized)) throw new AppError(400, `${field} no válido`, 'VALIDATION_ERROR');
  return normalized;
}

function normalizeMeetingInput(input, { partial = false } = {}) {
  const output = {};
  const setText = (name, options) => {
    if (!partial || input[name] !== undefined) output[name] = sanitizeText(input[name], { field: name, ...options });
  };
  setText('title', { min: 1, max: 140, required: !partial });
  setText('description', { max: 2_000 });
  setText('trainerName', { min: 2, max: 100, required: !partial });
  setText('trainerId', { max: 80 });

  if (!partial || input.room !== undefined) output.room = slugify(input.room || input.title);
  if (!partial || input.scheduledAt !== undefined) output.scheduledAt = parseDate(input.scheduledAt, { field: 'scheduledAt', nullable: true });
  if (!partial || input.durationMinutes !== undefined) {
    output.durationMinutes = parsePositiveInteger(input.durationMinutes, {
      field: 'durationMinutes', min: 1, max: 1_440, fallback: partial ? undefined : 60,
    });
  }
  if (!partial || input.capacity !== undefined) {
    output.capacity = parsePositiveInteger(input.capacity, {
      field: 'capacity', min: 0, max: 100_000, fallback: partial ? undefined : 500,
    });
  }
  if (!partial || input.type !== undefined) output.type = enumValue(input.type, TYPES, 'type', 'WEBINAR');
  if (!partial || input.status !== undefined) output.status = enumValue(input.status, STATUSES, 'status', input.scheduledAt ? 'SCHEDULED' : 'DRAFT');
  if (!partial || input.viewerAccessMode !== undefined) output.viewerAccessMode = enumValue(input.viewerAccessMode, ACCESS_MODES, 'viewerAccessMode', 'INVITATION');
  if (!partial || input.panelistAccessMode !== undefined) output.panelistAccessMode = enumValue(input.panelistAccessMode, ACCESS_MODES, 'panelistAccessMode', 'INVITATION');

  const booleanDefaults = {
    allowChat: true,
    allowFiles: true,
    allowReactions: true,
    allowRaiseHand: true,
    allowRecording: true,
    recordingConsentRequired: true,
  };
  for (const [name, fallback] of Object.entries(booleanDefaults)) {
    if (!partial || input[name] !== undefined) output[name] = parseBoolean(input[name], fallback);
  }
  return Object.fromEntries(Object.entries(output).filter(([, value]) => value !== undefined));
}

function calculateEndsAt(scheduledAt, durationMinutes) {
  if (!scheduledAt || !durationMinutes) return null;
  return new Date(new Date(scheduledAt).getTime() + durationMinutes * 60_000).toISOString();
}

async function createMeeting(input) {
  const clean = normalizeMeetingInput(input);
  if (await getMeeting(clean.room)) throw new AppError(409, 'Ya existe una reunión con ese slug de sala', 'DUPLICATE_ROOM');
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    ...clean,
    endsAt: calculateEndsAt(clean.scheduledAt, clean.durationMinutes),
    createdBy: String(input.createdBy || '').slice(0, 80),
    createdAt: now,
    updatedAt: now,
    cancelledAt: null,
    deletedAt: null,
    startedAt: null,
    completedAt: null,
  };
  return writeMeeting(record);
}

async function updateMeeting(room, updates) {
  const existing = await getMeeting(room);
  if (!existing) throw new AppError(404, 'Reunión no encontrada', 'NOT_FOUND');
  if (existing.deletedAt) throw new AppError(409, 'Restaura la reunión antes de editarla', 'MEETING_DELETED');
  const clean = normalizeMeetingInput(updates, { partial: true });
  if (clean.room && clean.room !== existing.room) throw new AppError(400, 'El slug de sala no se puede cambiar', 'ROOM_IMMUTABLE');
  delete clean.room;
  const updated = {
    ...existing,
    ...clean,
    room: existing.room,
    updatedAt: new Date().toISOString(),
  };
  updated.endsAt = calculateEndsAt(updated.scheduledAt, updated.durationMinutes);
  return writeMeeting(updated);
}

async function transitionMeeting(room, action, data = {}) {
  const existing = await getMeeting(room);
  if (!existing) throw new AppError(404, 'Reunión no encontrada', 'NOT_FOUND');
  const now = new Date().toISOString();
  const transitions = {
    cancel: { status: 'CANCELLED', cancelledAt: now },
    archive: { status: 'ARCHIVED' },
    restore: { status: existing.scheduledAt ? 'SCHEDULED' : 'DRAFT', deletedAt: null, cancelledAt: null },
    start: { status: 'LIVE', startedAt: existing.startedAt || now },
    complete: { status: 'COMPLETED', completedAt: now },
    delete: { status: 'ARCHIVED', deletedAt: now },
  };
  if (action === 'reschedule') {
    const scheduledAt = parseDate(data.scheduledAt, { field: 'scheduledAt' });
    const durationMinutes = data.durationMinutes === undefined
      ? existing.durationMinutes
      : parsePositiveInteger(data.durationMinutes, { field: 'durationMinutes', min: 1, max: 1_440 });
    return writeMeeting({
      ...existing,
      scheduledAt,
      durationMinutes,
      endsAt: calculateEndsAt(scheduledAt, durationMinutes),
      status: 'SCHEDULED',
      cancelledAt: null,
      updatedAt: now,
    });
  }
  if (!transitions[action]) throw new AppError(400, 'Acción de reunión no válida', 'VALIDATION_ERROR');
  if (existing.deletedAt && action !== 'restore') throw new AppError(409, 'La reunión está eliminada', 'MEETING_DELETED');
  return writeMeeting({ ...existing, ...transitions[action], updatedAt: now });
}

async function duplicateMeeting(room, overrides = {}, createdBy) {
  const source = await getMeeting(room);
  if (!source) throw new AppError(404, 'Reunión no encontrada', 'NOT_FOUND');
  const copyRoom = slugify(overrides.room || `${source.room}-copia-${Date.now().toString(36)}`);
  return createMeeting({
    ...source,
    ...overrides,
    room: copyRoom,
    title: overrides.title || `${source.title} (copia)`,
    status: overrides.scheduledAt ? 'SCHEDULED' : 'DRAFT',
    createdBy,
  });
}

async function deleteMeeting(room) {
  return transitionMeeting(room, 'delete');
}

module.exports = {
  ACCESS_MODES,
  STATUSES,
  TYPES,
  calculateEndsAt,
  createMeeting,
  deleteMeeting,
  duplicateMeeting,
  getMeeting,
  listMeetings,
  normalizeMeetingInput,
  transitionMeeting,
  updateMeeting,
};
