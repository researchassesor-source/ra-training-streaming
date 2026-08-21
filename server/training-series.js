const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const meetings = require('./meetings');
const { AppError, parseDate, parsePositiveInteger, sanitizeText, slugify } = require('./http-utils');
const { normalizeMeetingType } = require('./meeting-permissions');

const STATUSES = Object.freeze(['DRAFT', 'ACTIVE', 'COMPLETED', 'CANCELLED', 'ARCHIVED']);
const creationLocks = new Map();

function keyFor(id) { return `training-series/${encodeURIComponent(id)}.json`; }

function stateInS3() {
  return storageConfigured && !localStore.usesPostgres();
}

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function parseZonedDateTime(value, timeZone, field) {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(String(value || ''));
  if (!match) throw new AppError(400, `${field} debe incluir fecha y hora`, 'VALIDATION_ERROR');
  const targetParts = match.slice(1).map((part, index) => (index === 5 && part === undefined ? 0 : Number(part)));
  const target = Date.UTC(targetParts[0], targetParts[1] - 1, targetParts[2], targetParts[3], targetParts[4], targetParts[5]);
  const targetDate = new Date(target);
  if (targetDate.getUTCFullYear() !== targetParts[0] || targetDate.getUTCMonth() !== targetParts[1] - 1 || targetDate.getUTCDate() !== targetParts[2]
    || targetParts[3] > 23 || targetParts[4] > 59 || targetParts[5] > 59) {
    throw new AppError(400, `${field} no es una fecha v\u00e1lida`, 'VALIDATION_ERROR');
  }
  const formatter = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  let instant = target;
  let renderedParts = [];
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const rendered = Object.fromEntries(formatter.formatToParts(new Date(instant)).filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]));
    renderedParts = [rendered.year, rendered.month, rendered.day, rendered.hour, rendered.minute, rendered.second];
    const renderedAsUtc = Date.UTC(rendered.year, rendered.month - 1, rendered.day, rendered.hour, rendered.minute, rendered.second);
    const adjustment = target - renderedAsUtc;
    if (!adjustment) break;
    instant += adjustment;
  }
  if (!renderedParts.every((part, index) => part === targetParts[index])) {
    throw new AppError(400, `${field} no existe en la zona horaria seleccionada`, 'VALIDATION_ERROR');
  }
  return new Date(instant).toISOString();
}

function normalizeStoredSeries(stored) {
  const source = stored && typeof stored === 'object' ? stored : {};
  const type = normalizeMeetingType(source.meetingType || source.type);
  return {
    ...source,
    id: typeof source.id === 'string' && source.id ? source.id : `legacy-series-${crypto.createHash('sha256').update(JSON.stringify(source)).digest('hex').slice(0, 20)}`,
    title: typeof source.title === 'string' && source.title.trim() ? source.title : 'Capacitaci\u00f3n sin t\u00edtulo',
    description: typeof source.description === 'string' ? source.description : '',
    type,
    meetingType: type,
    trainerName: typeof source.trainerName === 'string' && source.trainerName.trim() ? source.trainerName : 'Capacitador por definir',
    trainerId: typeof source.trainerId === 'string' ? source.trainerId : '',
    timezone: typeof source.timezone === 'string' && source.timezone.trim() ? source.timezone : 'America/Guayaquil',
    earlyAccessMinutes: Number.isInteger(Number(source.earlyAccessMinutes)) && Number(source.earlyAccessMinutes) >= 0
      ? Number(source.earlyAccessMinutes) : 120,
    status: STATUSES.includes(String(source.status || '').toUpperCase()) ? String(source.status).toUpperCase() : 'ACTIVE',
    createdBy: typeof source.createdBy === 'string' ? source.createdBy : '',
    createdAt: validDate(source.createdAt) || new Date(0).toISOString(),
    updatedAt: validDate(source.updatedAt) || validDate(source.createdAt) || new Date(0).toISOString(),
  };
}

function normalizeSeriesInput(input, { partial = false } = {}) {
  const source = input && typeof input === 'object' ? input : {};
  const output = {};
  const setText = (name, options) => {
    if (!partial || source[name] !== undefined) output[name] = sanitizeText(source[name], { field: name, ...options });
  };
  setText('title', { min: 1, max: 140, required: !partial });
  setText('description', { max: 2_000 });
  if (!partial && source.trainerName === undefined) output.trainerName = 'Capacitador por definir';
  else setText('trainerName', { min: 2, max: 100, required: !partial });
  setText('trainerId', { max: 80 });
  if (!partial || source.type !== undefined || source.meetingType !== undefined) {
    output.type = normalizeMeetingType(source.meetingType || source.type);
    output.meetingType = output.type;
  }
  if (!partial || source.timezone !== undefined) {
    const timezone = String(source.timezone || 'America/Guayaquil').trim();
    try { new Intl.DateTimeFormat('es', { timeZone: timezone }).format(); } catch { throw new AppError(400, 'Zona horaria no v\u00e1lida', 'VALIDATION_ERROR'); }
    output.timezone = timezone;
  }
  if (!partial || source.earlyAccessMinutes !== undefined) {
    output.earlyAccessMinutes = parsePositiveInteger(source.earlyAccessMinutes, {
      field: 'earlyAccessMinutes', min: 0, max: 10_080, fallback: partial ? undefined : 120,
    });
  }
  if (!partial || source.status !== undefined) {
    const status = String(source.status || 'ACTIVE').toUpperCase();
    if (!STATUSES.includes(status)) throw new AppError(400, 'Estado de capacitaci\u00f3n no v\u00e1lido', 'VALIDATION_ERROR');
    output.status = status;
  }
  return Object.fromEntries(Object.entries(output).filter(([, value]) => value !== undefined));
}

async function writeSeries(record) {
  if (stateInS3()) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(record.id), Body: JSON.stringify(record), ContentType: 'application/json' }));
  } else await localStore.writeJson('training-series', record.id, record);
  return record;
}

async function getSeries(id) {
  const normalized = String(id || '');
  if (!normalized) return undefined;
  if (!stateInS3()) {
    const stored = await localStore.readJson('training-series', normalized);
    return stored ? normalizeStoredSeries(stored) : undefined;
  }
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(normalized) }));
    return normalizeStoredSeries(JSON.parse(await response.Body.transformToString()));
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function listSeries({ includeArchived = false } = {}) {
  let items;
  if (stateInS3()) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'training-series/' }));
    items = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else items = await localStore.listJson('training-series');
  return items
    .map(normalizeStoredSeries)
    .filter((item) => includeArchived || item.status !== 'ARCHIVED')
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

async function seriesSessions(seriesId, { includeDeleted = false } = {}) {
  return (await meetings.listMeetings({ includeDeleted }))
    .filter((meeting) => meeting.seriesId === seriesId)
    .sort((a, b) => Number(a.sessionNumber || 0) - Number(b.sessionNumber || 0) || String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')));
}

function resolveSeriesSession(series, sessions, now = new Date()) {
  const current = now instanceof Date ? now : new Date(now);
  const timestamp = Number.isNaN(current.getTime()) ? Date.now() : current.getTime();
  const ordered = [...(sessions || [])]
    .filter((meeting) => !meeting.deletedAt)
    .sort((a, b) => Number(a.sessionNumber || 0) - Number(b.sessionNumber || 0) || String(a.scheduledAt || '').localeCompare(String(b.scheduledAt || '')));
  const seriesStatus = String(series?.status || 'ACTIVE').toUpperCase();
  const completedCount = ordered.filter((meeting) => meeting.status === 'COMPLETED').length;
  if (['DRAFT', 'CANCELLED', 'ARCHIVED'].includes(seriesStatus)) {
    return {
      phase: 'UNAVAILABLE', meeting: null, completed: false, canPrepare: false, canEnter: false,
      opensAt: null, remainingMs: null, completedCount, totalSessions: ordered.length,
    };
  }
  if (seriesStatus === 'COMPLETED') {
    return {
      phase: 'COMPLETED', meeting: null, completed: true, canPrepare: false, canEnter: false,
      opensAt: null, remainingMs: null, completedCount, totalSessions: ordered.length,
    };
  }
  const valid = ordered.filter((meeting) => !['CANCELLED', 'ARCHIVED'].includes(meeting.status));
  const live = valid.find((meeting) => meeting.status === 'LIVE');
  const next = live || valid
    .filter((meeting) => meeting.status === 'SCHEDULED' && validDate(meeting.scheduledAt))
    .sort((a, b) => new Date(a.scheduledAt) - new Date(b.scheduledAt))[0] || null;
  const allFinished = ordered.length > 0 && !next && ordered.every((meeting) => ['COMPLETED', 'CANCELLED', 'ARCHIVED'].includes(meeting.status));
  let phase = 'UNAVAILABLE';
  let opensAt = null;
  let remainingMs = null;
  if (allFinished) phase = 'COMPLETED';
  else if (next?.status === 'LIVE') phase = 'LIVE';
  else if (next?.scheduledAt) {
    opensAt = new Date(new Date(next.scheduledAt).getTime() - Number(series?.earlyAccessMinutes || 0) * 60_000).toISOString();
    remainingMs = new Date(next.scheduledAt).getTime() - timestamp;
    phase = timestamp >= new Date(opensAt).getTime() ? 'WAITING' : 'UPCOMING';
  }
  return {
    phase,
    meeting: next,
    completed: phase === 'COMPLETED',
    canPrepare: ['WAITING', 'LIVE'].includes(phase),
    canEnter: phase === 'LIVE',
    opensAt,
    remainingMs,
    completedCount,
    totalSessions: ordered.length,
  };
}

async function withCreationLock(key, operation) {
  const previous = creationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  creationLocks.set(key, current);
  await previous;
  try { return await operation(); } finally { release(); if (creationLocks.get(key) === current) creationLocks.delete(key); }
}

async function createSeries(input) {
  const clean = normalizeSeriesInput(input);
  const suppliedSessions = Array.isArray(input.sessions) ? input.sessions : [];
  if (suppliedSessions.length < 1 || suppliedSessions.length > 50) throw new AppError(400, 'La capacitaci\u00f3n debe tener entre 1 y 50 sesiones', 'VALIDATION_ERROR');
  const id = crypto.randomUUID();
  const baseSlug = slugify(clean.title);
  const prepared = suppliedSessions.map((session, index) => ({
    scheduledAt: session.scheduledLocal
      ? parseZonedDateTime(session.scheduledLocal, clean.timezone, `sessions[${index}].scheduledLocal`)
      : parseDate(session.scheduledAt, { field: `sessions[${index}].scheduledAt` }),
    durationMinutes: parsePositiveInteger(session.durationMinutes, { field: `sessions[${index}].durationMinutes`, min: 1, max: 1_440, fallback: 60 }),
    room: slugify(session.room || `${baseSlug}-sesion-${index + 1}-${id.slice(0, 8)}`),
    sessionNumber: index + 1,
  }));
  if (new Set(prepared.map((session) => session.room)).size !== prepared.length) throw new AppError(409, 'Cada sesi\u00f3n debe tener una sala \u00fanica', 'DUPLICATE_ROOM');
  const createAll = async () => {
    for (const session of prepared) if (await meetings.getMeeting(session.room)) throw new AppError(409, `La sala ${session.room} ya existe`, 'DUPLICATE_ROOM');
    const createdMeetings = [];
    const now = new Date().toISOString();
    let record = null;
    try {
      if (localStore.usesPostgres()) record = await writeSeries({ id, ...clean, createdBy: String(input.createdBy || '').slice(0, 80), createdAt: now, updatedAt: now });
      for (const session of prepared) {
        createdMeetings.push(await meetings.createMeeting({
          title: `${clean.title} \u00b7 Sesi\u00f3n ${session.sessionNumber}`,
          description: clean.description,
          trainerName: clean.trainerName,
          trainerId: clean.trainerId,
          type: clean.type,
          room: session.room,
          scheduledAt: session.scheduledAt,
          durationMinutes: session.durationMinutes,
          status: 'SCHEDULED',
          capacity: input.capacity ?? 100,
          allowChat: input.allowChat ?? true,
          allowFiles: input.allowFiles ?? true,
          allowReactions: input.allowReactions ?? true,
          allowRaiseHand: input.allowRaiseHand ?? true,
          allowQuestions: input.allowQuestions ?? true,
          allowPanelistScreenShare: input.allowPanelistScreenShare ?? true,
          allowParticipantScreenShare: input.allowParticipantScreenShare ?? true,
          allowStudentScreenShare: input.allowStudentScreenShare ?? false,
          allowRecording: input.allowRecording ?? false,
          allowTranscription: input.allowTranscription ?? false,
          seriesId: id,
          sessionNumber: session.sessionNumber,
          createdBy: input.createdBy,
        }));
      }
      if (!record) record = await writeSeries({ id, ...clean, createdBy: String(input.createdBy || '').slice(0, 80), createdAt: now, updatedAt: now });
      return { series: record, sessions: createdMeetings };
    } catch (error) {
      await Promise.all(createdMeetings.map((meeting) => meetings.deleteMeeting(meeting.room).catch(() => null)));
      throw error;
    }
  };
  return withCreationLock(baseSlug, () => localStore.withTransaction(createAll));
}

async function updateSeries(id, input) {
  const existing = await getSeries(id);
  if (!existing) throw new AppError(404, 'Capacitaci\u00f3n no encontrada', 'NOT_FOUND');
  const clean = normalizeSeriesInput(input, { partial: true });
  return writeSeries({ ...existing, ...clean, id: existing.id, updatedAt: new Date().toISOString() });
}

async function archiveSeries(id, { archivedAt, sessionStates } = {}) {
  const existing = await getSeries(id);
  if (!existing) throw new AppError(404, 'Capacitaci\u00f3n no encontrada', 'NOT_FOUND');
  const now = archivedAt || new Date().toISOString();
  return writeSeries({
    ...existing,
    id: existing.id,
    status: 'ARCHIVED',
    archivedAt: existing.archivedAt || now,
    archivedSessionStates: sessionStates && typeof sessionStates === 'object' ? sessionStates : existing.archivedSessionStates || {},
    updatedAt: now,
  });
}

async function restoreSeries(id) {
  const existing = await getSeries(id);
  if (!existing) throw new AppError(404, 'Capacitaci\u00f3n no encontrada', 'NOT_FOUND');
  const now = new Date().toISOString();
  const { archivedSessionStates, ...rest } = existing;
  return writeSeries({
    ...rest,
    id: existing.id,
    status: 'ACTIVE',
    archivedAt: null,
    restoredAt: now,
    updatedAt: now,
  });
}

async function touchSeries(id) {
  const existing = await getSeries(id);
  return existing ? writeSeries({ ...existing, updatedAt: new Date().toISOString() }) : null;
}

module.exports = {
  STATUSES,
  archiveSeries,
  createSeries,
  getSeries,
  listSeries,
  normalizeStoredSeries,
  normalizeSeriesInput,
  resolveSeriesSession,
  restoreSeries,
  seriesSessions,
  touchSeries,
  updateSeries,
};
