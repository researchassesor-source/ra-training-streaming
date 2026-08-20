const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { config } = require('./config');
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
const LEGACY_DEFAULTS = Object.freeze({
  description: '',
  trainerName: 'Capacitador por definir',
  durationMinutes: 60,
  type: 'WEBINAR',
  status: 'SCHEDULED',
  capacity: 100,
  allowChat: true,
  allowFiles: true,
  allowReactions: true,
  allowRaiseHand: true,
  allowQuestions: true,
  allowPanelistScreenShare: true,
  allowParticipantScreenShare: true,
  allowStudentScreenShare: false,
  allowRecording: false,
  recordingConsentRequired: false,
  allowTranscription: false,
  transcriptionConsentRequired: false,
  transcriptionLanguage: /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(config.transcriptionLanguage) ? config.transcriptionLanguage : 'es',
  transcriptionRetentionDays: config.transcriptionRetentionDays,
  allowPanelistTranscriptAccess: false,
  deletedAt: null,
  cancelledAt: null,
  archivedAt: null,
  livekitConfirmedAt: null,
  rolePolicyVersion: 1,
});

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
  if (!storageConfigured) {
    const stored = await localStore.readJson('meetings', normalized);
    return stored ? normalizeStoredMeeting(stored) : undefined;
  }
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(normalized) }));
    return normalizeStoredMeeting(JSON.parse(await response.Body.transformToString()));
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
    .map(normalizeStoredMeeting)
    .filter((meeting) => includeDeleted || !meeting.deletedAt)
    .sort((a, b) => String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')));
}

function validStoredDate(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  return Number.isNaN(new Date(value).getTime()) ? null : value;
}

function normalizeStoredMeeting(stored) {
  const source = stored && typeof stored === 'object' ? stored : {};
  const durationMinutes = Number.isInteger(Number(source.durationMinutes)) && Number(source.durationMinutes) > 0
    ? Number(source.durationMinutes)
    : LEGACY_DEFAULTS.durationMinutes;
  const capacity = Number.isInteger(Number(source.capacity)) && Number(source.capacity) >= 0
    ? Number(source.capacity)
    : LEGACY_DEFAULTS.capacity;
  const scheduledAt = validStoredDate(source.scheduledAt);
  const room = typeof source.room === 'string' && source.room.trim()
    ? source.room
    : `reunion-legada-${crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 12)}`;
  const normalized = {
    ...source,
    id: typeof source.id === 'string' && source.id ? source.id : `legacy-${crypto.createHash('sha256').update(room).digest('hex').slice(0, 24)}`,
    room,
    title: typeof source.title === 'string' && source.title.trim() ? source.title : 'Reunión sin título',
    description: typeof source.description === 'string' ? source.description : LEGACY_DEFAULTS.description,
    trainerName: typeof source.trainerName === 'string' && source.trainerName.trim() ? source.trainerName : LEGACY_DEFAULTS.trainerName,
    durationMinutes,
    capacity,
    scheduledAt,
    type: TYPES.includes(String(source.meetingType || source.type || '').toUpperCase()) ? String(source.meetingType || source.type).toUpperCase() : LEGACY_DEFAULTS.type,
    status: STATUSES.includes(String(source.status || '').toUpperCase()) ? String(source.status).toUpperCase() : LEGACY_DEFAULTS.status,
  };
  normalized.meetingType = normalized.type;
  normalized.seriesId = typeof source.seriesId === 'string' && source.seriesId.trim() ? source.seriesId : null;
  normalized.sessionNumber = Number.isInteger(Number(source.sessionNumber)) && Number(source.sessionNumber) > 0 ? Number(source.sessionNumber) : null;
  normalized.rolePolicyVersion = Number(source.rolePolicyVersion) >= 2 ? 2 : LEGACY_DEFAULTS.rolePolicyVersion;
  for (const name of ['allowChat', 'allowFiles', 'allowReactions', 'allowRaiseHand', 'allowQuestions', 'allowPanelistScreenShare', 'allowParticipantScreenShare', 'allowStudentScreenShare', 'allowRecording', 'recordingConsentRequired', 'allowTranscription', 'transcriptionConsentRequired', 'allowPanelistTranscriptAccess']) {
    normalized[name] = typeof source[name] === 'boolean' ? source[name] : LEGACY_DEFAULTS[name];
  }
  normalized.transcriptionLanguage = typeof source.transcriptionLanguage === 'string' && /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(source.transcriptionLanguage)
    ? source.transcriptionLanguage
    : LEGACY_DEFAULTS.transcriptionLanguage;
  normalized.transcriptionRetentionDays = Number.isInteger(Number(source.transcriptionRetentionDays)) && Number(source.transcriptionRetentionDays) > 0
    ? Number(source.transcriptionRetentionDays)
    : LEGACY_DEFAULTS.transcriptionRetentionDays;
  for (const name of ['deletedAt', 'cancelledAt', 'archivedAt', 'livekitConfirmedAt']) normalized[name] = validStoredDate(source[name]);
  normalized.endsAt = validStoredDate(source.endsAt) || calculateEndsAt(scheduledAt, durationMinutes);
  return normalized;
}

function enumValue(value, allowed, field, fallback) {
  const normalized = String(value || fallback).toUpperCase();
  if (!allowed.includes(normalized)) throw new AppError(400, `${field} no válido`, 'VALIDATION_ERROR');
  return normalized;
}

function normalizeMeetingInput(input, { partial = false } = {}) {
  const output = {};
  if (partial && Object.prototype.hasOwnProperty.call(input, 'status')) {
    throw new AppError(400, 'El estado de la reunión debe modificarse mediante una acción de lifecycle específica', 'MEETING_STATUS_IMMUTABLE');
  }
  const setText = (name, options) => {
    if (!partial || input[name] !== undefined) output[name] = sanitizeText(input[name], { field: name, ...options });
  };
  setText('title', { min: 1, max: 140, required: !partial });
  setText('description', { max: 2_000 });
  if (!partial && input.trainerName === undefined) output.trainerName = LEGACY_DEFAULTS.trainerName;
  else setText('trainerName', { min: 2, max: 100, required: !partial });
  setText('trainerId', { max: 80 });
  if (!partial || input.seriesId !== undefined) {
    output.seriesId = input.seriesId ? sanitizeText(input.seriesId, { field: 'seriesId', min: 36, max: 80, required: true }) : null;
  }
  if (!partial || input.sessionNumber !== undefined) {
    output.sessionNumber = input.sessionNumber === null || input.sessionNumber === ''
      ? null
      : parsePositiveInteger(input.sessionNumber, { field: 'sessionNumber', min: 1, max: 1_000, fallback: partial ? undefined : null });
  }

  if (!partial || input.room !== undefined) output.room = slugify(input.room || input.title);
  if (!partial || input.scheduledAt !== undefined) output.scheduledAt = parseDate(input.scheduledAt, { field: 'scheduledAt', nullable: true });
  if (!partial || input.durationMinutes !== undefined) {
    output.durationMinutes = parsePositiveInteger(input.durationMinutes, {
      field: 'durationMinutes', min: 1, max: 1_440, fallback: partial ? undefined : 60,
    });
  }
  if (!partial || input.capacity !== undefined) {
    output.capacity = parsePositiveInteger(input.capacity, {
      field: 'capacity', min: 0, max: 100_000, fallback: partial ? undefined : LEGACY_DEFAULTS.capacity,
    });
  }
  if (!partial || input.type !== undefined || input.meetingType !== undefined) {
    output.type = enumValue(input.meetingType || input.type, TYPES, 'type', 'WEBINAR');
    output.meetingType = output.type;
  }
  if (!partial || input.status !== undefined) output.status = enumValue(input.status, STATUSES, 'status', input.scheduledAt ? 'SCHEDULED' : 'DRAFT');
  if (!partial || input.viewerAccessMode !== undefined) output.viewerAccessMode = enumValue(input.viewerAccessMode, ACCESS_MODES, 'viewerAccessMode', 'INVITATION');
  if (!partial || input.panelistAccessMode !== undefined) output.panelistAccessMode = enumValue(input.panelistAccessMode, ACCESS_MODES, 'panelistAccessMode', 'INVITATION');

  const booleanDefaults = {
    allowChat: true,
    allowFiles: true,
    allowReactions: true,
    allowRaiseHand: true,
    allowQuestions: true,
    allowPanelistScreenShare: true,
    allowParticipantScreenShare: true,
    allowStudentScreenShare: false,
    allowRecording: false,
    recordingConsentRequired: false,
    allowTranscription: false,
    transcriptionConsentRequired: false,
    allowPanelistTranscriptAccess: false,
  };
  for (const [name, fallback] of Object.entries(booleanDefaults)) {
    if (!partial || input[name] !== undefined) output[name] = parseBoolean(input[name], fallback);
  }
  if (!partial || input.transcriptionLanguage !== undefined) {
    const language = String(input.transcriptionLanguage || LEGACY_DEFAULTS.transcriptionLanguage).trim();
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language)) throw new AppError(400, 'Idioma de transcripción no válido', 'VALIDATION_ERROR');
    output.transcriptionLanguage = language;
  }
  if (!partial || input.transcriptionRetentionDays !== undefined) {
    output.transcriptionRetentionDays = parsePositiveInteger(input.transcriptionRetentionDays, {
      field: 'transcriptionRetentionDays', min: 1, max: 3_650, fallback: partial ? undefined : LEGACY_DEFAULTS.transcriptionRetentionDays,
    });
  }
  return Object.fromEntries(Object.entries(output).filter(([, value]) => value !== undefined));
}

function calculateEndsAt(scheduledAt, durationMinutes) {
  if (!scheduledAt || !durationMinutes) return null;
  const start = new Date(scheduledAt).getTime();
  if (!Number.isFinite(start)) return null;
  return new Date(start + durationMinutes * 60_000).toISOString();
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
    archivedAt: null,
    startedAt: null,
    completedAt: null,
    livekitConfirmedAt: null,
    rolePolicyVersion: 2,
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
    archive: { status: 'ARCHIVED', archivedAt: now },
    restore: { status: existing.scheduledAt ? 'SCHEDULED' : 'DRAFT', deletedAt: null, cancelledAt: null, archivedAt: null },
    start: { status: 'LIVE', startedAt: existing.startedAt || now, livekitConfirmedAt: validStoredDate(data.livekitConfirmedAt) || now },
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
    seriesId: Object.prototype.hasOwnProperty.call(overrides, 'seriesId') ? overrides.seriesId : null,
    sessionNumber: Object.prototype.hasOwnProperty.call(overrides, 'sessionNumber') ? overrides.sessionNumber : null,
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
  LEGACY_DEFAULTS,
  STATUSES,
  TYPES,
  calculateEndsAt,
  createMeeting,
  deleteMeeting,
  duplicateMeeting,
  getMeeting,
  listMeetings,
  normalizeStoredMeeting,
  normalizeMeetingInput,
  transitionMeeting,
  updateMeeting,
};
