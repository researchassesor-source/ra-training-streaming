const crypto = require('crypto');
const { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { AppError, sanitizeText } = require('./http-utils');

const STATUSES = Object.freeze([
  'NOT_AVAILABLE', 'READY', 'QUEUED', 'PROCESSING_AUDIO', 'IDENTIFYING_PARTICIPANTS',
  'GENERATING_TRANSCRIPT', 'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED',
]);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED']);
const COMPLETE_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS']);
const EXPORT_FORMATS = new Set(['txt', 'json', 'vtt', 'srt']);

function keyFor(id) { return `transcriptions/${encodeURIComponent(id)}.json`; }

async function writeTranscript(record) {
  const safe = { ...record, updatedAt: new Date().toISOString() };
  if (storageConfigured) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(safe.id), Body: JSON.stringify(safe), ContentType: 'application/json' }));
  } else await localStore.writeJson('transcriptions', safe.id, safe);
  return safe;
}

async function getTranscript(id) {
  const normalized = String(id || '');
  if (!normalized) return undefined;
  if (!storageConfigured) return localStore.readJson('transcriptions', normalized);
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(normalized) }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function listTranscripts({ meetingId } = {}) {
  let records;
  if (storageConfigured) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'transcriptions/' }));
    records = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else records = await localStore.listJson('transcriptions');
  return records
    .filter((record) => !meetingId || record.meetingId === meetingId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function safeLanguage(value, fallback = 'es') {
  const language = String(value || fallback).trim();
  return /^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(language) ? language : fallback;
}

function participantDirectory(recording) {
  const identities = new Map();
  const tracks = new Map();
  for (const participant of recording?.participants || []) {
    if (!participant?.identity) continue;
    identities.set(String(participant.identity), sanitizeText(participant.name || participant.identity, { field: 'participantName', max: 100 }) || String(participant.identity));
  }
  for (const track of recording?.tracks || []) {
    if (!track?.participantIdentity) continue;
    const identity = String(track.participantIdentity);
    const participantName = track.participantName
      ? sanitizeText(track.participantName, { field: 'participantName', max: 100 })
      : identities.get(identity) || identity;
    identities.set(identity, participantName);
    if (track.trackSid) tracks.set(String(track.trackSid), { participantIdentity: identity, participantName });
  }
  return { identities, tracks };
}

function sanitizeTranscriptResult(result, recording = {}) {
  const directory = participantDirectory(recording);
  const unknownNames = new Map();
  let unknownCount = 0;
  const segments = (Array.isArray(result?.segments) ? result.segments : []).map((segment, index) => {
    const startMs = Math.max(0, Math.trunc(Number(segment.startMs) || 0));
    const endMs = Math.max(startMs, Math.trunc(Number(segment.endMs) || startMs));
    const trackSid = segment.trackSid ? sanitizeText(segment.trackSid, { field: 'trackSid', max: 160 }) : null;
    const trackParticipant = trackSid ? directory.tracks.get(trackSid) : null;
    const participantIdentity = segment.participantIdentity
      ? sanitizeText(segment.participantIdentity, { field: 'participantIdentity', max: 160 })
      : trackParticipant?.participantIdentity || null;
    let participantName = participantIdentity ? directory.identities.get(participantIdentity) : trackParticipant?.participantName || null;
    if (!participantName && segment.participantName) participantName = sanitizeText(segment.participantName, { field: 'participantName', max: 100 });
    if (!participantName) {
      const providerSpeaker = segment.speaker ? sanitizeText(segment.speaker, { field: 'speaker', max: 100 }) : '';
      const key = participantIdentity || providerSpeaker || `index-${index}`;
      if (!unknownNames.has(key)) {
        unknownCount += 1;
        unknownNames.set(key, `Participante sin identificar ${unknownCount}`);
      }
      participantName = unknownNames.get(key);
    }
    const confidenceNumber = Number(segment.confidence);
    return {
      id: typeof segment.id === 'string' && segment.id ? segment.id : crypto.randomUUID(),
      startMs,
      endMs,
      participantIdentity,
      participantName,
      confidence: Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : null,
      text: sanitizeText(segment.text, { field: 'text', max: 20_000 }),
      edited: Boolean(segment.edited),
      editedBy: segment.editedBy ? sanitizeText(segment.editedBy, { field: 'editedBy', max: 80 }) : null,
      editedAt: typeof segment.editedAt === 'string' ? segment.editedAt : null,
    };
  }).filter((segment) => segment.text).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const speakerMap = new Map();
  for (const segment of segments) {
    const key = segment.participantIdentity || segment.participantName;
    if (!speakerMap.has(key)) speakerMap.set(key, { participantIdentity: segment.participantIdentity, participantName: segment.participantName });
  }
  return {
    language: safeLanguage(result?.language),
    durationSeconds: Math.max(0, Math.trunc(Number(result?.durationSeconds) || (segments.at(-1)?.endMs || 0) / 1000)),
    speakers: [...speakerMap.values()],
    segments,
    warnings: (Array.isArray(result?.warnings) ? result.warnings : []).slice(0, 20).map((warning) => sanitizeText(warning, { field: 'warning', max: 300 })).filter(Boolean),
  };
}

function publicTranscript(record) {
  if (!record) return record;
  const { providerJobId, ...publicRecord } = record;
  return publicRecord;
}

async function createTranscript({ meeting, recording, requestedBy, language, provider }) {
  if (!provider?.isConfigured()) throw new AppError(503, 'La transcripción no está configurada en este entorno', 'TRANSCRIPTION_NOT_CONFIGURED');
  if (!meeting.allowTranscription) throw new AppError(409, 'La transcripción no está permitida en esta reunión', 'TRANSCRIPTION_DISABLED');
  if (meeting.status !== 'COMPLETED') throw new AppError(409, 'La reunión debe estar completada antes de transcribirla', 'MEETING_NOT_COMPLETED');
  if (!recording?.id || recording.status !== 'READY') throw new AppError(409, 'La grabación todavía no está lista', 'RECORDING_NOT_READY');
  const existing = (await listTranscripts({ meetingId: meeting.id })).find((item) => item.recordingId === recording.id && !['FAILED', 'CANCELLED'].includes(item.status));
  if (existing) throw new AppError(409, 'Ya existe una transcripción activa para esta grabación', 'TRANSCRIPTION_EXISTS');
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const retentionDays = Math.max(1, Math.min(3_650, Number(meeting.transcriptionRetentionDays) || 90));
  const providerJob = await provider.createJob({ recording, meeting, language: safeLanguage(language, meeting.transcriptionLanguage) });
  return writeTranscript({
    id,
    meetingId: meeting.id,
    recordingId: recording.id,
    status: STATUSES.includes(providerJob.status) ? providerJob.status : 'QUEUED',
    language: safeLanguage(language, meeting.transcriptionLanguage),
    provider: sanitizeText(provider.constructor.name.replace(/TranscriptionProvider$/, '').toLowerCase() || 'unknown', { field: 'provider', max: 60 }),
    providerJobId: sanitizeText(providerJob.providerJobId, { field: 'providerJobId', min: 3, max: 200, required: true }),
    requestedBy: sanitizeText(requestedBy, { field: 'requestedBy', max: 80 }),
    requestedAt: now,
    retentionUntil: new Date(Date.now() + retentionDays * 86_400_000).toISOString(),
    startedAt: null,
    completedAt: null,
    failedAt: null,
    errorCode: null,
    errorMessageSafe: null,
    durationSeconds: 0,
    progress: Math.max(0, Math.min(100, Number(providerJob.progress) || 0)),
    speakers: [],
    segments: [],
    warnings: [],
    revision: 1,
    editedBy: null,
    editedAt: null,
    createdAt: now,
    updatedAt: now,
  });
}

async function refreshTranscript(record, provider, recording) {
  if (!record || TERMINAL_STATUSES.has(record.status)) return record;
  let providerState;
  try {
    providerState = await provider.getJobStatus(record.providerJobId);
  } catch (error) {
    return writeTranscript({ ...record, status: 'FAILED', failedAt: new Date().toISOString(), errorCode: error.code || 'PROVIDER_STATUS_FAILED', errorMessageSafe: 'No fue posible consultar el estado del proveedor.', progress: 0 });
  }
  const status = STATUSES.includes(providerState.status) ? providerState.status : 'FAILED';
  const now = new Date().toISOString();
  const patch = {
    ...record,
    status,
    progress: Math.max(0, Math.min(100, Number(providerState.progress) || 0)),
    startedAt: record.startedAt || (status !== 'QUEUED' ? now : null),
  };
  if (status === 'FAILED') {
    patch.failedAt = now;
    patch.errorCode = sanitizeText(providerState.errorCode || 'PROVIDER_FAILED', { field: 'errorCode', max: 80 });
    patch.errorMessageSafe = sanitizeText(providerState.errorMessageSafe || 'El proveedor no pudo completar la transcripción.', { field: 'errorMessageSafe', max: 300 });
  }
  if (status === 'CANCELLED') patch.progress = 0;
  if (COMPLETE_STATUSES.has(status)) {
    try {
      const result = sanitizeTranscriptResult(await provider.getTranscript(record.providerJobId), recording);
      if (!result.segments.length) throw new Error('empty transcript');
      Object.assign(patch, result, { completedAt: now, progress: 100 });
      if (result.warnings.length && status === 'COMPLETED') patch.status = 'COMPLETED_WITH_WARNINGS';
    } catch {
      Object.assign(patch, { status: 'FAILED', failedAt: now, errorCode: 'TRANSCRIPT_RESULT_MISSING', errorMessageSafe: 'El proveedor terminó sin devolver texto utilizable.', progress: 0 });
    }
  }
  return writeTranscript(patch);
}

async function cancelTranscript(record, provider) {
  if (TERMINAL_STATUSES.has(record.status)) throw new AppError(409, 'La transcripción ya terminó y no puede cancelarse', 'TRANSCRIPTION_TERMINAL');
  await provider.cancelJob(record.providerJobId);
  return writeTranscript({ ...record, status: 'CANCELLED', progress: 0 });
}

async function retryTranscript(record, { meeting, recording, requestedBy, provider }) {
  if (!['FAILED', 'CANCELLED', 'COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(record.status)) throw new AppError(409, 'La transcripción todavía está en proceso', 'TRANSCRIPTION_NOT_RETRYABLE');
  const providerJob = await provider.createJob({ recording, meeting, language: record.language });
  return writeTranscript({
    ...record,
    status: STATUSES.includes(providerJob.status) ? providerJob.status : 'QUEUED',
    providerJobId: sanitizeText(providerJob.providerJobId, { field: 'providerJobId', min: 3, max: 200, required: true }), requestedBy,
    requestedAt: new Date().toISOString(), startedAt: null, completedAt: null, failedAt: null,
    errorCode: null, errorMessageSafe: null, progress: Math.max(0, Math.min(100, Number(providerJob.progress) || 0)), speakers: [], segments: [], warnings: [],
    revision: Number(record.revision || 0) + 1, editedBy: null, editedAt: null,
  });
}

async function editTranscript(record, { segments, language, revision, editedBy }) {
  if (!COMPLETE_STATUSES.has(record.status)) throw new AppError(409, 'La transcripción debe estar completada para editarla', 'TRANSCRIPTION_NOT_EDITABLE');
  if (Number(revision) !== Number(record.revision)) throw new AppError(409, 'La transcripción cambió en otra sesión. Recárgala antes de guardar.', 'REVISION_CONFLICT');
  const now = new Date().toISOString();
  const previousById = new Map((record.segments || []).map((segment) => [segment.id, segment]));
  const result = sanitizeTranscriptResult({
    language: language || record.language,
    durationSeconds: record.durationSeconds,
    segments: (segments || []).map((segment) => {
      const previous = previousById.get(segment.id);
      const changed = !previous || segment.text !== previous.text || segment.participantName !== previous.participantName;
      return {
        ...segment,
        edited: Boolean(previous?.edited || changed),
        editedBy: changed ? editedBy : previous?.editedBy,
        editedAt: changed ? now : previous?.editedAt,
      };
    }),
  });
  if (!result.segments.length) throw new AppError(400, 'La transcripción debe conservar al menos un segmento', 'VALIDATION_ERROR');
  return writeTranscript({ ...record, ...result, revision: Number(record.revision) + 1, editedBy, editedAt: now });
}

async function deleteTranscript(record) {
  if (storageConfigured) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(record.id) }));
  else await localStore.deleteJson('transcriptions', record.id);
}

function timestamp(ms, separator = '.') {
  const total = Math.max(0, Math.trunc(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function exportTranscript(record, format) {
  const normalized = String(format || '').toLowerCase();
  if (!EXPORT_FORMATS.has(normalized)) throw new AppError(400, 'Formato de exportación no válido', 'VALIDATION_ERROR');
  if (!COMPLETE_STATUSES.has(record.status)) throw new AppError(409, 'La transcripción todavía no está lista para exportar', 'TRANSCRIPTION_NOT_READY');
  if (normalized === 'json') return { contentType: 'application/json; charset=utf-8', extension: 'json', body: JSON.stringify(publicTranscript(record), null, 2) };
  if (normalized === 'txt') {
    const body = record.segments.map((segment) => `${timestamp(segment.startMs)} — ${segment.participantName}\n${segment.text}`).join('\n\n');
    return { contentType: 'text/plain; charset=utf-8', extension: 'txt', body };
  }
  const separator = normalized === 'srt' ? ',' : '.';
  const cues = record.segments.map((segment, index) => `${normalized === 'srt' ? `${index + 1}\n` : ''}${timestamp(segment.startMs, separator)} --> ${timestamp(segment.endMs, separator)}\n${segment.participantName}: ${segment.text}`).join('\n\n');
  return { contentType: normalized === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8', extension: normalized, body: normalized === 'vtt' ? `WEBVTT\n\n${cues}\n` : `${cues}\n` };
}

module.exports = {
  COMPLETE_STATUSES,
  EXPORT_FORMATS,
  STATUSES,
  TERMINAL_STATUSES,
  cancelTranscript,
  createTranscript,
  deleteTranscript,
  editTranscript,
  exportTranscript,
  getTranscript,
  listTranscripts,
  publicTranscript,
  refreshTranscript,
  retryTranscript,
  sanitizeTranscriptResult,
};
