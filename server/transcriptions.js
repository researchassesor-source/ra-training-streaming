const crypto = require('node:crypto');
const { DeleteObjectCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const backgroundJobs = require('./background-jobs');
const db = require('./db');
const { config } = require('./config');
const { AppError, sanitizeText } = require('./http-utils');

const STATUSES = Object.freeze([
  'NOT_AVAILABLE', 'READY', 'PENDING', 'VALIDATING', 'FETCHING_RECORDING', 'SUBMITTING', 'PROCESSING',
  'QUEUED', 'PROCESSING_AUDIO', 'IDENTIFYING_PARTICIPANTS', 'GENERATING_TRANSCRIPT',
  'COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED',
]);
const TERMINAL_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS', 'FAILED', 'CANCELLED']);
const COMPLETE_STATUSES = new Set(['COMPLETED', 'COMPLETED_WITH_WARNINGS']);
const EXPORT_FORMATS = new Set(['txt', 'json', 'vtt', 'srt']);
const creationLocks = new Map();

function keyFor(id) { return `transcriptions/${encodeURIComponent(id)}.json`; }
function stateInS3() { return storageConfigured && !localStore.usesPostgres(); }

function stableLegacySpeakerId(segment, index) {
  if (segment?.speakerId) return String(segment.speakerId);
  if (segment?.participantIdentity) return `participant-${String(segment.participantIdentity)}`;
  const number = String(segment?.participantName || segment?.speakerLabel || '').match(/(\d+)$/)?.[1];
  return number ? `speaker-${Math.max(0, Number(number) - 1)}` : `legacy-speaker-${index + 1}`;
}

function normalizeStoredTranscript(record) {
  if (!record || typeof record !== 'object') return record;
  const segments = (Array.isArray(record.segments) ? record.segments : []).map((segment, index) => ({
    ...segment,
    speakerId: stableLegacySpeakerId(segment, index),
    speakerLabel: segment.speakerLabel || segment.participantName || `Hablante ${index + 1}`,
    words: Array.isArray(segment.words) ? segment.words : [],
  }));
  let speakers = Array.isArray(record.speakers) ? record.speakers.map((speaker, index) => ({
    ...speaker,
    speakerId: speaker.speakerId || stableLegacySpeakerId(speaker, index),
    speakerLabel: speaker.speakerLabel || speaker.participantName || `Hablante ${index + 1}`,
  })) : [];
  if (!speakers.length && segments.length) {
    const seen = new Map();
    for (const segment of segments) {
      if (!seen.has(segment.speakerId)) seen.set(segment.speakerId, {
        speakerId: segment.speakerId,
        speakerLabel: segment.speakerLabel,
        participantIdentity: segment.participantIdentity || null,
        participantName: segment.participantName || segment.speakerLabel,
      });
    }
    speakers = [...seen.values()];
  }
  return {
    schemaVersion: Number(record.schemaVersion) || 1,
    words: Array.isArray(record.words) ? record.words : [],
    confidence: Number.isFinite(Number(record.confidence)) ? Number(record.confidence) : null,
    text: typeof record.text === 'string' ? record.text : segments.map((segment) => segment.text || '').join(' ').trim(),
    providerMetadata: record.providerMetadata && typeof record.providerMetadata === 'object' ? record.providerMetadata : {},
    providerRequestId: record.providerRequestId || null,
    providerSubmittedAt: record.providerSubmittedAt || null,
    ...record,
    segments,
    speakers,
  };
}

async function writeTranscript(record) {
  const safe = normalizeStoredTranscript({ ...record, schemaVersion: 2, updatedAt: new Date().toISOString() });
  if (stateInS3()) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(safe.id), Body: JSON.stringify(safe), ContentType: 'application/json' }));
  } else await localStore.writeJson('transcriptions', safe.id, safe);
  return safe;
}

async function getTranscript(id) {
  const normalized = String(id || '');
  if (!normalized) return undefined;
  if (!stateInS3()) return normalizeStoredTranscript(await localStore.readJson('transcriptions', normalized));
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(normalized) }));
    return normalizeStoredTranscript(JSON.parse(await response.Body.transformToString()));
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function listTranscripts({ meetingId } = {}) {
  let records;
  if (stateInS3()) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'transcriptions/' }));
    records = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return normalizeStoredTranscript(JSON.parse(await response.Body.transformToString()));
    }));
  } else records = (await localStore.listJson('transcriptions')).map(normalizeStoredTranscript);
  return records
    .filter((record) => !meetingId || record.meetingId === meetingId)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
}

function transcriptSummary(record) {
  if (!record) return record;
  const publicRecord = publicTranscript(record);
  const { segments, words, providerMetadata, ...summary } = publicRecord;
  return {
    ...summary,
    segmentCount: Array.isArray(segments) ? segments.length : Number(record.segmentCount || 0),
    wordCount: Array.isArray(words) ? words.length : Number(record.wordCount || 0),
    hasContent: Boolean((Array.isArray(segments) && segments.length) || record.hasContent),
    providerMetadata: undefined,
  };
}

async function listTranscriptSummaries({ meetingId, limit = 100 } = {}) {
  const boundedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  if (!stateInS3() && localStore.usesPostgres()) {
    const params = [];
    let where = '';
    if (meetingId) {
      params.push(meetingId);
      where = `WHERE meeting_id = $${params.length}`;
    }
    params.push(boundedLimit);
    const result = await db.query(
      `SELECT data
       FROM transcriptions
       ${where}
       ORDER BY created_at DESC NULLS LAST, id DESC
       LIMIT $${params.length}`,
      params
    );
    return result.rows.map((row) => transcriptSummary(normalizeStoredTranscript(row.data)));
  }
  return (await listTranscripts({ meetingId })).slice(0, boundedLimit).map(transcriptSummary);
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

function milliseconds(valueMs, valueSeconds, fallback = 0) {
  if (Number.isFinite(Number(valueMs))) return Math.max(0, Math.trunc(Number(valueMs)));
  if (Number.isFinite(Number(valueSeconds))) return Math.max(0, Math.round(Number(valueSeconds) * 1_000));
  return fallback;
}

function sanitizeWord(word, fallbackSpeakerId = null) {
  const text = sanitizeText(word?.word || word?.punctuatedWord || '', { field: 'word', max: 500 });
  if (!text) return null;
  const startMs = milliseconds(word.startMs, word.start);
  const endMs = Math.max(startMs, milliseconds(word.endMs, word.end, startMs));
  const confidence = Number(word.confidence);
  return {
    word: text,
    punctuatedWord: sanitizeText(word.punctuatedWord || text, { field: 'punctuatedWord', max: 500 }),
    startMs,
    endMs,
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    speakerId: word.speakerId ? sanitizeText(word.speakerId, { field: 'speakerId', max: 100 }) : fallbackSpeakerId,
  };
}

function providerMetadata(result) {
  const source = result?.rawMetadata && typeof result.rawMetadata === 'object' ? result.rawMetadata : {};
  return {
    requestId: source.requestId ? sanitizeText(source.requestId, { field: 'requestId', max: 160 }) : null,
    model: source.model ? sanitizeText(source.model, { field: 'model', max: 120 }) : null,
    createdAt: source.createdAt ? sanitizeText(source.createdAt, { field: 'createdAt', max: 80 }) : null,
  };
}

function sanitizeTranscriptResult(result, recording = {}) {
  const directory = participantDirectory(recording);
  const unknownNames = new Map();
  let unknownCount = 0;
  const segments = (Array.isArray(result?.segments) ? result.segments : []).map((segment, index) => {
    const startMs = milliseconds(segment.startMs, segment.start);
    const endMs = Math.max(startMs, milliseconds(segment.endMs, segment.end, startMs));
    const trackSid = segment.trackSid ? sanitizeText(segment.trackSid, { field: 'trackSid', max: 160 }) : null;
    const trackParticipant = trackSid ? directory.tracks.get(trackSid) : null;
    const participantIdentity = segment.participantIdentity
      ? sanitizeText(segment.participantIdentity, { field: 'participantIdentity', max: 160 })
      : trackParticipant?.participantIdentity || null;
    const providerSpeaker = segment.speakerId || segment.speaker
      ? sanitizeText(segment.speakerId || segment.speaker, { field: 'speakerId', max: 100 })
      : null;
    const speakerKey = participantIdentity || providerSpeaker || `segment-${index}`;
    const speakerId = providerSpeaker || (participantIdentity ? `participant-${participantIdentity}` : `speaker-${index}`);
    let participantName = participantIdentity ? directory.identities.get(participantIdentity) : trackParticipant?.participantName || null;
    if (!participantName && segment.participantName) participantName = sanitizeText(segment.participantName, { field: 'participantName', max: 100 });
    let speakerLabel = segment.speakerLabel ? sanitizeText(segment.speakerLabel, { field: 'speakerLabel', max: 100 }) : null;
    if (!participantName) {
      if (!unknownNames.has(speakerKey)) {
        unknownCount += 1;
        unknownNames.set(speakerKey, speakerLabel || `Hablante ${unknownCount}`);
      }
      participantName = unknownNames.get(speakerKey);
    }
    if (!speakerLabel) speakerLabel = participantName;
    const confidenceNumber = Number(segment.confidence);
    const words = (Array.isArray(segment.words) ? segment.words : []).map((word) => sanitizeWord(word, speakerId)).filter(Boolean);
    return {
      id: typeof segment.id === 'string' && segment.id ? sanitizeText(segment.id, { field: 'segmentId', max: 160 }) : crypto.randomUUID(),
      speakerId,
      speakerLabel,
      startMs,
      endMs,
      participantIdentity,
      participantName,
      trackSid,
      confidence: Number.isFinite(confidenceNumber) ? Math.max(0, Math.min(1, confidenceNumber)) : null,
      text: sanitizeText(segment.text, { field: 'text', max: 20_000 }),
      words,
      edited: Boolean(segment.edited),
      editedBy: segment.editedBy ? sanitizeText(segment.editedBy, { field: 'editedBy', max: 80 }) : null,
      editedAt: typeof segment.editedAt === 'string' ? segment.editedAt : null,
    };
  }).filter((segment) => segment.text).sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const speakerMap = new Map();
  for (const segment of segments) {
    const key = segment.speakerId || segment.participantIdentity || segment.participantName;
    if (!speakerMap.has(key)) speakerMap.set(key, {
      speakerId: segment.speakerId,
      speakerLabel: segment.speakerLabel,
      participantIdentity: segment.participantIdentity,
      participantName: segment.participantName,
    });
  }
  const words = (Array.isArray(result?.words) ? result.words : segments.flatMap((segment) => segment.words)).map((word) => sanitizeWord(word)).filter(Boolean);
  const confidence = Number(result?.confidence);
  const metadata = providerMetadata(result);
  return {
    provider: result?.provider ? sanitizeText(result.provider, { field: 'provider', max: 60 }) : undefined,
    providerRequestId: result?.providerRequestId ? sanitizeText(result.providerRequestId, { field: 'providerRequestId', max: 160 }) : metadata.requestId,
    providerMetadata: metadata,
    language: safeLanguage(result?.language),
    durationSeconds: Math.max(0, Number(result?.durationSeconds) || (segments.at(-1)?.endMs || 0) / 1_000),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : null,
    text: sanitizeText(result?.text || segments.map((segment) => segment.text).join(' '), { field: 'transcriptText', max: 2_000_000 }),
    speakers: [...speakerMap.values()],
    segments,
    words,
    warnings: (Array.isArray(result?.warnings) ? result.warnings : []).slice(0, 20).map((warning) => sanitizeText(warning, { field: 'warning', max: 300 })).filter(Boolean),
  };
}

function publicTranscript(record) {
  if (!record) return record;
  const { providerJobId, ...publicRecord } = normalizeStoredTranscript(record);
  return publicRecord;
}

function transcriptionDedupeKey(recordingId, language) {
  return `transcription:${String(recordingId || '').slice(0, 180)}:${safeLanguage(language)}`;
}

async function withCreationLock(key, action) {
  const previous = creationLocks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  const queued = previous.then(() => current);
  creationLocks.set(key, queued);
  await previous;
  try {
    return await action();
  } finally {
    release();
    if (creationLocks.get(key) === queued) creationLocks.delete(key);
  }
}

async function createTranscript({ meeting, recording, requestedBy, language, provider }) {
  const lockKey = `${meeting?.id || 'missing'}:${recording?.id || 'missing'}`;
  return withCreationLock(lockKey, async () => {
    if (provider?.unsupported) throw new AppError(503, 'El proveedor de transcripci\u00f3n seleccionado no es compatible', 'TRANSCRIPTION_PROVIDER_UNSUPPORTED');
    if (!provider?.isConfigured()) throw new AppError(503, 'La transcripci\u00f3n no est\u00e1 configurada en este entorno', 'TRANSCRIPTION_PROVIDER_NOT_CONFIGURED');
    if (!meeting?.allowTranscription) throw new AppError(409, 'La transcripci\u00f3n no est\u00e1 permitida en esta reuni\u00f3n', 'TRANSCRIPTION_DISABLED');
    if (meeting.status !== 'COMPLETED') throw new AppError(409, 'La reuni\u00f3n debe estar completada antes de transcribirla', 'MEETING_NOT_COMPLETED');
    if (!recording?.id) throw new AppError(404, 'La grabaci\u00f3n no existe', 'TRANSCRIPTION_RECORDING_NOT_FOUND');
    if (recording.status !== 'READY' || recording.available === false) throw new AppError(409, 'La grabaci\u00f3n todav\u00eda no est\u00e1 lista', 'TRANSCRIPTION_RECORDING_NOT_READY');
    if (Number(recording.durationSeconds || 0) > config.transcriptionMaxDurationMinutes * 60) throw new AppError(413, 'La grabaci\u00f3n supera la duraci\u00f3n m\u00e1xima permitida', 'TRANSCRIPTION_RECORDING_TOO_LONG');
    if (Number(recording.size || 0) > config.transcriptionMaxAudioBytes) throw new AppError(413, 'La grabaci\u00f3n supera el tama\u00f1o permitido', 'TRANSCRIPTION_RECORDING_TOO_LARGE');
    const existing = (await listTranscripts({ meetingId: meeting.id })).find((item) => item.recordingId === recording.id && !['FAILED', 'CANCELLED'].includes(item.status));
    if (existing) {
      const completed = COMPLETE_STATUSES.has(existing.status);
      throw new AppError(409, completed ? 'La grabaci\u00f3n ya tiene una transcripci\u00f3n completada' : 'Ya existe una transcripci\u00f3n activa para esta grabaci\u00f3n', completed ? 'TRANSCRIPTION_ALREADY_COMPLETED' : 'TRANSCRIPTION_ALREADY_RUNNING');
    }
    const now = new Date().toISOString();
    const id = crypto.randomUUID();
    const retentionDays = Math.max(1, Math.min(3_650, Number(meeting.transcriptionRetentionDays) || config.transcriptionRetentionDays));
    const safeTranscriptLanguage = safeLanguage(language, meeting.transcriptionLanguage || config.transcriptionLanguage);
    if (localStore.usesPostgres()) {
      return localStore.withTransaction(async () => {
        const providerName = sanitizeText(provider.providerName || provider.constructor.name.replace(/TranscriptionProvider$/, '').toLowerCase() || 'unknown', { field: 'provider', max: 60 });
        const transcript = await writeTranscript({
          schemaVersion: 2,
          id,
          meetingId: meeting.id,
          meetingRoom: meeting.room || null,
          meetingTitle: sanitizeText(meeting.title || 'Reuni\u00f3n sin t\u00edtulo', { field: 'meetingTitle', max: 160 }),
          meetingScheduledAt: meeting.scheduledAt || null,
          recordingId: recording.id,
          status: 'QUEUED',
          language: safeTranscriptLanguage,
          provider: providerName,
          providerJobId: `durable-${id}`,
          providerRequestId: null,
          providerMetadata: {},
          requestedBy: sanitizeText(requestedBy, { field: 'requestedBy', max: 80 }),
          requestedAt: now,
          retentionUntil: new Date(new Date(now).getTime() + retentionDays * 86_400_000).toISOString(),
          startedAt: null,
          providerSubmittedAt: null,
          completedAt: null,
          failedAt: null,
          cancelledAt: null,
          retainedDeletedAt: null,
          errorCode: null,
          errorMessageSafe: null,
          durationSeconds: 0,
          confidence: null,
          text: '',
          progress: 0,
          speakers: [],
          segments: [],
          words: [],
          warnings: [],
          revision: 1,
          editedBy: null,
          editedAt: null,
          createdAt: now,
          updatedAt: now,
        });
        await backgroundJobs.enqueue({
          type: 'TRANSCRIPTION_PROCESS',
          dedupeKey: transcriptionDedupeKey(recording.id, safeTranscriptLanguage),
          priority: 50,
          maxAttempts: Math.max(1, config.transcriptionRetryMax + 2),
          payload: { transcriptionId: id, meetingId: meeting.id, meetingRoom: meeting.room, recordingId: recording.id },
        });
        return transcript;
      });
    }
    const providerJob = await provider.createJob({ recording, meeting, language: safeTranscriptLanguage });
    return writeTranscript({
      schemaVersion: 2,
      id,
      meetingId: meeting.id,
      meetingTitle: sanitizeText(meeting.title || 'Reuni\u00f3n sin t\u00edtulo', { field: 'meetingTitle', max: 160 }),
      meetingScheduledAt: meeting.scheduledAt || null,
      recordingId: recording.id,
      status: STATUSES.includes(providerJob.status) ? providerJob.status : 'PENDING',
      language: safeTranscriptLanguage,
      provider: sanitizeText(provider.providerName || provider.constructor.name.replace(/TranscriptionProvider$/, '').toLowerCase() || 'unknown', { field: 'provider', max: 60 }),
      providerJobId: sanitizeText(providerJob.providerJobId, { field: 'providerJobId', min: 3, max: 200, required: true }),
      providerRequestId: null,
      providerMetadata: {},
      requestedBy: sanitizeText(requestedBy, { field: 'requestedBy', max: 80 }),
      requestedAt: now,
      retentionUntil: new Date(new Date(now).getTime() + retentionDays * 86_400_000).toISOString(),
      startedAt: null,
      providerSubmittedAt: null,
      completedAt: null,
      failedAt: null,
      cancelledAt: null,
      errorCode: null,
      errorMessageSafe: null,
      durationSeconds: 0,
      confidence: null,
      text: '',
      progress: Math.max(0, Math.min(100, Number(providerJob.progress) || 0)),
      speakers: [],
      segments: [],
      words: [],
      warnings: [],
      revision: 1,
      editedBy: null,
      editedAt: null,
      createdAt: now,
      updatedAt: now,
    });
  });
}

async function refreshTranscript(record, provider, recording) {
  if (!record || TERMINAL_STATUSES.has(record.status)) return record;
  if (localStore.usesPostgres() && String(record.providerJobId || '').startsWith('durable-')) return record;
  let providerState;
  try {
    providerState = await provider.getJobStatus(record.providerJobId);
  } catch (error) {
    return writeTranscript({
      ...record,
      status: 'FAILED',
      failedAt: new Date().toISOString(),
      errorCode: sanitizeText(error.code || 'PROVIDER_STATUS_FAILED', { field: 'errorCode', max: 100 }),
      errorMessageSafe: sanitizeText(error.message || 'No fue posible consultar el estado del proveedor.', { field: 'errorMessageSafe', max: 300 }),
      progress: 0,
    });
  }
  const status = STATUSES.includes(providerState.status) ? providerState.status : 'FAILED';
  const now = new Date().toISOString();
  const started = !['PENDING', 'QUEUED'].includes(status);
  const submitted = ['SUBMITTING', 'PROCESSING', 'GENERATING_TRANSCRIPT', 'COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(status) || providerState.submittedAt;
  const patch = {
    ...record,
    status,
    progress: Math.max(0, Math.min(100, Number(providerState.progress) || 0)),
    startedAt: record.startedAt || (started ? now : null),
    providerSubmittedAt: record.providerSubmittedAt || (submitted ? providerState.submittedAt || now : null),
    providerRequestId: providerState.providerRequestId || record.providerRequestId || null,
  };
  if (status === 'FAILED') {
    patch.failedAt = now;
    patch.errorCode = sanitizeText(providerState.errorCode || 'PROVIDER_FAILED', { field: 'errorCode', max: 100 });
    patch.errorMessageSafe = sanitizeText(providerState.errorMessageSafe || 'El proveedor no pudo completar la transcripci\u00f3n.', { field: 'errorMessageSafe', max: 300 });
  }
  if (status === 'CANCELLED') {
    patch.cancelledAt = record.cancelledAt || now;
    patch.progress = 0;
  }
  if (COMPLETE_STATUSES.has(status)) {
    try {
      const result = sanitizeTranscriptResult(await provider.getTranscript(record.providerJobId), recording);
      if (!result.segments.length) throw new AppError(502, 'El proveedor termin\u00f3 sin devolver texto utilizable.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
      Object.assign(patch, result, { completedAt: now, progress: 100, errorCode: null, errorMessageSafe: null });
      if (result.warnings.length && status === 'COMPLETED') patch.status = 'COMPLETED_WITH_WARNINGS';
    } catch (error) {
      Object.assign(patch, {
        status: 'FAILED',
        failedAt: now,
        errorCode: sanitizeText(error.code || 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE', { field: 'errorCode', max: 100 }),
        errorMessageSafe: sanitizeText(error.message || 'El proveedor termin\u00f3 sin devolver texto utilizable.', { field: 'errorMessageSafe', max: 300 }),
        progress: 0,
      });
    }
  }
  return writeTranscript(patch);
}

async function cancelTranscript(record, provider, recording = {}) {
  if (TERMINAL_STATUSES.has(record.status)) throw new AppError(409, 'La transcripci\u00f3n ya termin\u00f3 y no puede cancelarse', 'TRANSCRIPTION_ALREADY_COMPLETED');
  if (localStore.usesPostgres() && String(record.providerJobId || '').startsWith('durable-')) {
    return localStore.withTransaction(async () => {
      await backgroundJobs.cancelByDedupe(transcriptionDedupeKey(record.recordingId, record.language));
      return writeTranscript({ ...record, status: 'CANCELLED', cancelledAt: new Date().toISOString(), errorCode: null, errorMessageSafe: null, progress: 0 });
    });
  }
  const result = await provider.cancelJob(record.providerJobId);
  if (COMPLETE_STATUSES.has(result?.status)) return refreshTranscript(record, provider, recording);
  if (result?.status === 'FAILED') return writeTranscript({
    ...record,
    status: 'FAILED',
    failedAt: new Date().toISOString(),
    errorCode: result.errorCode || 'PROVIDER_FAILED',
    errorMessageSafe: result.errorMessageSafe || 'El proveedor no pudo completar la transcripci\u00f3n.',
    progress: 0,
  });
  return writeTranscript({ ...record, status: 'CANCELLED', cancelledAt: new Date().toISOString(), errorCode: null, errorMessageSafe: null, progress: 0 });
}

async function retryTranscript(record, { meeting, recording, requestedBy, provider }) {
  if (!['FAILED', 'CANCELLED', 'COMPLETED', 'COMPLETED_WITH_WARNINGS'].includes(record.status)) throw new AppError(409, 'La transcripci\u00f3n todav\u00eda est\u00e1 en proceso', 'TRANSCRIPTION_ALREADY_RUNNING');
  if (localStore.usesPostgres() && String(record.providerJobId || '').startsWith('durable-')) {
    return localStore.withTransaction(async () => {
      const updated = await writeTranscript({
        ...record,
        status: 'QUEUED',
        providerRequestId: null,
        providerMetadata: {},
        requestedBy,
        requestedAt: new Date().toISOString(),
        startedAt: null,
        providerSubmittedAt: null,
        completedAt: null,
        failedAt: null,
        cancelledAt: null,
        retainedDeletedAt: null,
        errorCode: null,
        errorMessageSafe: null,
        progress: 0,
        confidence: null,
        text: '',
        speakers: [],
        segments: [],
        words: [],
        warnings: [],
        revision: Number(record.revision || 0) + 1,
        editedBy: null,
        editedAt: null,
      });
      await backgroundJobs.enqueue({
        type: 'TRANSCRIPTION_PROCESS',
        dedupeKey: transcriptionDedupeKey(recording.id, record.language),
        priority: 50,
        maxAttempts: Math.max(1, config.transcriptionRetryMax + 2),
        payload: { transcriptionId: record.id, meetingId: meeting.id, meetingRoom: meeting.room, recordingId: recording.id },
      });
      return updated;
    });
  }
  const providerJob = await provider.createJob({ recording, meeting, language: record.language });
  return writeTranscript({
    ...record,
    status: STATUSES.includes(providerJob.status) ? providerJob.status : 'PENDING',
    providerJobId: sanitizeText(providerJob.providerJobId, { field: 'providerJobId', min: 3, max: 200, required: true }),
    providerRequestId: null,
    providerMetadata: {},
    requestedBy,
    requestedAt: new Date().toISOString(),
    startedAt: null,
    providerSubmittedAt: null,
    completedAt: null,
    failedAt: null,
    cancelledAt: null,
    errorCode: null,
    errorMessageSafe: null,
    progress: Math.max(0, Math.min(100, Number(providerJob.progress) || 0)),
    confidence: null,
    text: '',
    speakers: [],
    segments: [],
    words: [],
    warnings: [],
    revision: Number(record.revision || 0) + 1,
    editedBy: null,
    editedAt: null,
  });
}

async function editTranscript(record, { segments, language, revision, editedBy }) {
  if (!COMPLETE_STATUSES.has(record.status)) throw new AppError(409, 'La transcripci\u00f3n debe estar completada para editarla', 'TRANSCRIPTION_NOT_EDITABLE');
  if (Number(revision) !== Number(record.revision)) throw new AppError(409, 'La transcripci\u00f3n cambi\u00f3 en otra sesi\u00f3n. Rec\u00e1rgala antes de guardar.', 'REVISION_CONFLICT');
  const now = new Date().toISOString();
  const previousById = new Map((record.segments || []).map((segment) => [segment.id, segment]));
  const result = sanitizeTranscriptResult({
    provider: record.provider,
    providerRequestId: record.providerRequestId,
    rawMetadata: record.providerMetadata,
    language: language || record.language,
    durationSeconds: record.durationSeconds,
    confidence: record.confidence,
    words: record.words,
    segments: (segments || []).map((segment) => {
      const previous = previousById.get(segment.id);
      const changed = !previous || segment.text !== previous.text || segment.participantName !== previous.participantName;
      return {
        ...previous,
        ...segment,
        edited: Boolean(previous?.edited || changed),
        editedBy: changed ? editedBy : previous?.editedBy,
        editedAt: changed ? now : previous?.editedAt,
      };
    }),
  });
  if (!result.segments.length) throw new AppError(400, 'La transcripci\u00f3n debe conservar al menos un segmento', 'VALIDATION_ERROR');
  return writeTranscript({ ...record, ...result, revision: Number(record.revision) + 1, editedBy, editedAt: now });
}

async function renameSpeaker(record, { speakerId, participantName, revision, editedBy }) {
  if (!COMPLETE_STATUSES.has(record.status)) throw new AppError(409, 'La transcripci\u00f3n debe estar completada para renombrar hablantes', 'TRANSCRIPTION_NOT_EDITABLE');
  if (Number(revision) !== Number(record.revision)) throw new AppError(409, 'La transcripci\u00f3n cambi\u00f3 en otra sesi\u00f3n. Rec\u00e1rgala antes de guardar.', 'REVISION_CONFLICT');
  const safeSpeakerId = sanitizeText(speakerId, { field: 'speakerId', min: 1, max: 100, required: true });
  const safeName = sanitizeText(participantName, { field: 'participantName', min: 1, max: 100, required: true });
  if (!(record.segments || []).some((segment) => segment.speakerId === safeSpeakerId)) throw new AppError(404, 'Hablante no encontrado', 'NOT_FOUND');
  const now = new Date().toISOString();
  const segments = record.segments.map((segment) => segment.speakerId === safeSpeakerId
    ? { ...segment, participantName: safeName, edited: true, editedBy, editedAt: now }
    : segment);
  const speakers = record.speakers.map((speaker) => speaker.speakerId === safeSpeakerId ? { ...speaker, participantName: safeName } : speaker);
  return writeTranscript({ ...record, segments, speakers, revision: Number(record.revision) + 1, editedBy, editedAt: now });
}

async function deleteTranscript(record) {
  if (stateInS3()) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(record.id) }));
  else await localStore.deleteJson('transcriptions', record.id);
}

async function processTranscriptionJob({ transcriptionId, provider, recordingResolver, meetings }) {
  const record = await getTranscript(transcriptionId);
  if (!record) throw new AppError(404, 'Transcripci\u00f3n no encontrada.', 'TRANSCRIPTION_NOT_FOUND');
  if (record.status === 'CANCELLED') return { skipped: true, status: 'CANCELLED' };
  if (COMPLETE_STATUSES.has(record.status)) return { skipped: true, status: record.status };
  if (!provider?.isConfigured()) throw new AppError(503, 'La transcripci\u00f3n no est\u00e1 configurada en este entorno', 'TRANSCRIPTION_PROVIDER_NOT_CONFIGURED');
  const meetingRoom = record.meetingRoom || record.room;
  const meeting = meetingRoom && meetings?.getMeeting ? await meetings.getMeeting(meetingRoom) : null;
  if (!meeting) throw new AppError(404, 'Reuni\u00f3n no encontrada.', 'MEETING_NOT_FOUND');
  const recording = await recordingResolver(record.recordingId, meeting);
  if (!recording) throw new AppError(404, 'La reuni\u00f3n no tiene una grabaci\u00f3n disponible', 'TRANSCRIPTION_RECORDING_NOT_FOUND');
  const now = new Date().toISOString();
  let current = await writeTranscript({
    ...record,
    status: 'PROCESSING',
    progress: Math.max(Number(record.progress || 0), 5),
    startedAt: record.startedAt || now,
    providerSubmittedAt: record.providerSubmittedAt || now,
    errorCode: null,
    errorMessageSafe: null,
  });
  const isCancelled = async () => (await getTranscript(record.id))?.status === 'CANCELLED';
  const result = await provider.transcribe({
    recording,
    meeting,
    language: record.language,
    isCancelled,
    onStage: async (status, providerJob) => {
      if (await isCancelled()) throw new AppError(409, 'La transcripci\u00f3n fue cancelada.', 'TRANSCRIPTION_CANCELLED');
      const progress = Math.max(0, Math.min(100, Number(providerJob?.progress) || Number(current.progress) || 0));
      current = await writeTranscript({ ...current, status: STATUSES.includes(status) ? status : 'PROCESSING', progress, providerSubmittedAt: current.providerSubmittedAt || new Date().toISOString() });
    },
  });
  if (await isCancelled()) return { skipped: true, status: 'CANCELLED' };
  const sanitized = sanitizeTranscriptResult(result, recording);
  if (!sanitized.segments.length) throw new AppError(502, 'El proveedor termin\u00f3 sin devolver texto utilizable.', 'TRANSCRIPTION_DEEPGRAM_INVALID_RESPONSE');
  const completedAt = new Date().toISOString();
  const stored = await writeTranscript({
    ...current,
    ...sanitized,
    status: sanitized.warnings.length || result.status === 'COMPLETED_WITH_WARNINGS' ? 'COMPLETED_WITH_WARNINGS' : 'COMPLETED',
    providerJobId: result.providerJobId || current.providerJobId,
    providerRequestId: result.providerRequestId || sanitized.providerRequestId || current.providerRequestId || null,
    providerSubmittedAt: current.providerSubmittedAt || completedAt,
    completedAt,
    failedAt: null,
    cancelledAt: null,
    errorCode: null,
    errorMessageSafe: null,
    progress: 100,
  });
  if (stored.retentionUntil) {
    await backgroundJobs.enqueue({
      type: 'TRANSCRIPTION_RETENTION_DELETE',
      dedupeKey: `retention:${stored.id}`,
      priority: -50,
      maxAttempts: 3,
      availableAt: stored.retentionUntil,
      payload: { transcriptionId: stored.id },
    });
  }
  return stored;
}

async function applyRetention(record) {
  if (!record) throw new AppError(404, 'Transcripci\u00f3n no encontrada.', 'TRANSCRIPTION_NOT_FOUND');
  if (!record.retentionUntil || new Date(record.retentionUntil).getTime() > Date.now()) return { skipped: true, status: record.status };
  if (record.retainedDeletedAt) return record;
  return writeTranscript({
    ...record,
    text: '',
    segments: [],
    words: [],
    speakers: [],
    providerMetadata: {},
    providerRequestId: null,
    retainedDeletedAt: new Date().toISOString(),
    retentionStatus: 'DELETED',
  });
}

function timestamp(ms, separator = '.') {
  const total = Math.max(0, Math.trunc(ms));
  const hours = Math.floor(total / 3_600_000);
  const minutes = Math.floor((total % 3_600_000) / 60_000);
  const seconds = Math.floor((total % 60_000) / 1_000);
  const millis = total % 1_000;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}${separator}${String(millis).padStart(3, '0')}`;
}

function cueText(value) {
  return String(value || '').replace(/-->/g, '\u2192').replace(/\r/g, '').trim();
}

function parseTimestamp(value) {
  const match = String(value).match(/^(\d{2,}):(\d{2}):(\d{2})[.,](\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3_600_000 + Number(match[2]) * 60_000 + Number(match[3]) * 1_000 + Number(match[4]);
}

function validateVtt(body) {
  if (!String(body).startsWith('WEBVTT\n\n')) return false;
  const cues = String(body).trim().split(/\n\n/).slice(1);
  let previousEndMs = -1;
  return cues.length > 0 && cues.every((cue) => {
    const line = cue.split('\n')[0];
    const [start, end] = line.split(' --> ');
    const startMs = parseTimestamp(start);
    const endMs = parseTimestamp(end);
    const valid = startMs !== null && endMs !== null && endMs > startMs && startMs >= previousEndMs;
    previousEndMs = endMs ?? previousEndMs;
    return valid;
  });
}

function validateSrt(body) {
  const cues = String(body).trim().split(/\n\n/);
  let previousEndMs = -1;
  return cues.length > 0 && cues.every((cue, index) => {
    const lines = cue.split('\n');
    const [start, end] = String(lines[1] || '').split(' --> ');
    const startMs = parseTimestamp(start);
    const endMs = parseTimestamp(end);
    const valid = lines[0] === String(index + 1) && startMs !== null && endMs !== null && endMs > startMs && startMs >= previousEndMs && lines.slice(2).join('\n').trim().length > 0;
    previousEndMs = endMs ?? previousEndMs;
    return valid;
  });
}

function exportTranscript(record, format) {
  const normalized = String(format || '').toLowerCase();
  if (!EXPORT_FORMATS.has(normalized)) throw new AppError(400, 'Formato de exportaci\u00f3n no v\u00e1lido', 'VALIDATION_ERROR');
  if (!COMPLETE_STATUSES.has(record.status)) throw new AppError(409, 'La transcripci\u00f3n todav\u00eda no est\u00e1 lista para exportar', 'TRANSCRIPTION_NOT_READY');
  if (normalized === 'json') return { contentType: 'application/json; charset=utf-8', extension: 'json', body: JSON.stringify(publicTranscript(record), null, 2) };
  if (normalized === 'txt') {
    const date = record.meetingScheduledAt && !Number.isNaN(new Date(record.meetingScheduledAt).getTime()) ? new Date(record.meetingScheduledAt).toLocaleString('es-EC') : 'Fecha no disponible';
    const header = [`R.A. Training Streaming`, `Reuni\u00f3n: ${record.meetingTitle || record.meetingId || 'Sin t\u00edtulo'}`, `Fecha: ${date}`, `Idioma: ${record.language || 'es'}`, `Proveedor: ${record.provider === 'deepgram' ? 'Deepgram' : record.provider || 'No especificado'}`].join('\n');
    const content = record.segments.map((segment) => `${timestamp(segment.startMs)} \u2014 ${cueText(segment.participantName)}\n${cueText(segment.text)}`).join('\n\n');
    return { contentType: 'text/plain; charset=utf-8', extension: 'txt', body: `${header}\n\n${content}\n` };
  }
  const separator = normalized === 'srt' ? ',' : '.';
  let previousEndMs = 0;
  const cues = record.segments.map((segment, index) => {
    const startMs = Math.max(previousEndMs, Number(segment.startMs) || 0);
    const endMs = Math.max(startMs + 1, Number(segment.endMs) || startMs + 1);
    previousEndMs = endMs;
    return `${normalized === 'srt' ? `${index + 1}\n` : ''}${timestamp(startMs, separator)} --> ${timestamp(endMs, separator)}\n${cueText(segment.participantName)}: ${cueText(segment.text)}`;
  }).join('\n\n');
  const body = normalized === 'vtt' ? `WEBVTT\n\n${cues}\n` : `${cues}\n`;
  const valid = normalized === 'vtt' ? validateVtt(body) : validateSrt(body);
  if (!valid) throw new AppError(500, 'No fue posible generar una exportaci\u00f3n v\u00e1lida', 'TRANSCRIPTION_EXPORT_INVALID');
  return { contentType: normalized === 'vtt' ? 'text/vtt; charset=utf-8' : 'application/x-subrip; charset=utf-8', extension: normalized, body };
}

module.exports = {
  COMPLETE_STATUSES,
  EXPORT_FORMATS,
  STATUSES,
  TERMINAL_STATUSES,
  applyRetention,
  cancelTranscript,
  createTranscript,
  deleteTranscript,
  editTranscript,
  exportTranscript,
  getTranscript,
  listTranscripts,
  listTranscriptSummaries,
  normalizeStoredTranscript,
  processTranscriptionJob,
  publicTranscript,
  refreshTranscript,
  renameSpeaker,
  retryTranscript,
  sanitizeTranscriptResult,
  transcriptSummary,
  validateSrt,
  validateVtt,
};
