const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { AppError, sanitizeText } = require('./http-utils');

const STATUSES = new Set(['PENDING', 'ANSWERED_LIVE', 'ANSWERED_WRITTEN', 'DISMISSED']);
const locks = new Map();

function storageId(room, id) {
  return `${encodeURIComponent(room)}--${id}`;
}

function s3Key(room, id) {
  return `questions/${encodeURIComponent(room)}/${id}.json`;
}

function stateInS3() {
  return storageConfigured && !localStore.usesPostgres();
}

async function write(record) {
  if (stateInS3()) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: s3Key(record.room, record.id), Body: JSON.stringify(record), ContentType: 'application/json' }));
  } else {
    await localStore.writeJson('questions', storageId(record.room, record.id), record);
  }
  return record;
}

async function get(room, id) {
  if (!stateInS3()) return localStore.readJson('questions', storageId(room, id));
  try {
    const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: s3Key(room, id) }));
    return JSON.parse(await response.Body.transformToString());
  } catch (error) {
    if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined;
    throw error;
  }
}

async function list(room) {
  let items;
  if (stateInS3()) {
    const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `questions/${encodeURIComponent(room)}/` }));
    items = await Promise.all((response.Contents || []).map(async ({ Key }) => {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
      return JSON.parse(await result.Body.transformToString());
    }));
  } else {
    items = (await localStore.listJson('questions')).filter((item) => item.room === room);
  }
  return items.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.voters.length - a.voters.length || String(a.createdAt).localeCompare(String(b.createdAt)));
}

function publicQuestion(record, viewerIdentity) {
  return {
    id: record.id,
    text: record.text,
    status: record.status,
    answer: record.answer || '',
    authorName: record.authorName,
    authorRole: record.authorRole,
    isOwn: record.authorIdentity === viewerIdentity,
    voteCount: record.voters.length,
    voted: record.voters.includes(viewerIdentity),
    pinned: Boolean(record.pinned),
    answeredBy: record.answeredBy || null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function create({ room, meetingId, text, authorIdentity, authorName, authorRole }) {
  const now = new Date().toISOString();
  return write({
    id: crypto.randomUUID(), room, meetingId,
    text: sanitizeText(text, { field: 'Pregunta', min: 3, max: 600, required: true }),
    status: 'PENDING', answer: '', authorIdentity,
    authorName: String(authorName || 'Participante').slice(0, 80), authorRole,
    voters: [], pinned: false, answeredBy: null, createdAt: now, updatedAt: now,
  });
}

async function withLock(key, operation) {
  const previous = locks.get(key) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  locks.set(key, current);
  await previous;
  try { return await localStore.withTransaction(operation); } finally {
    release();
    if (locks.get(key) === current) locks.delete(key);
  }
}

async function toggleVote(room, id, identity) {
  return withLock(`${room}:${id}`, async () => {
    const record = await get(room, id);
    if (!record || record.status === 'DISMISSED') throw new AppError(404, 'Pregunta no encontrada', 'NOT_FOUND');
    const voters = new Set(record.voters || []);
    if (voters.has(identity)) voters.delete(identity); else voters.add(identity);
    return write({ ...record, voters: [...voters], updatedAt: new Date().toISOString() });
  });
}

async function update(room, id, changes, actor) {
  return withLock(`${room}:${id}`, async () => {
    const record = await get(room, id);
    if (!record) throw new AppError(404, 'Pregunta no encontrada', 'NOT_FOUND');
    const moderator = ['ADMIN', 'ORGANIZER', 'PANELIST'].includes(actor.role);
    const ownPendingEdit = actor.identity === record.authorIdentity && record.status === 'PENDING' && changes.text !== undefined;
    if (!['text', 'status', 'answer', 'pinned'].some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
      throw new AppError(400, 'No se recibió ningún cambio válido', 'VALIDATION_ERROR');
    }
    if (changes.text !== undefined && !ownPendingEdit) throw new AppError(403, 'Solo el autor puede editar una pregunta pendiente', 'ROOM_FORBIDDEN');
    if (!moderator && !ownPendingEdit) throw new AppError(403, 'No puedes modificar esta pregunta', 'ROOM_FORBIDDEN');
    const next = { ...record };
    if (changes.text !== undefined) next.text = sanitizeText(changes.text, { field: 'Pregunta', min: 3, max: 600, required: true });
    if (changes.status !== undefined) {
      const status = String(changes.status).toUpperCase();
      if (!moderator) throw new AppError(403, 'No puedes moderar preguntas', 'ROOM_FORBIDDEN');
      if (!STATUSES.has(status)) throw new AppError(400, 'Estado de pregunta no válido', 'VALIDATION_ERROR');
      next.status = status;
      if (status.startsWith('ANSWERED')) next.answeredBy = actor.name;
    }
    if (changes.answer !== undefined) {
      if (!moderator) throw new AppError(403, 'No puedes responder preguntas', 'ROOM_FORBIDDEN');
      next.answer = sanitizeText(changes.answer, { field: 'Respuesta', min: 0, max: 1_200 });
      if (next.answer) { next.status = 'ANSWERED_WRITTEN'; next.answeredBy = actor.name; }
    }
    if (changes.pinned !== undefined) {
      if (!moderator) throw new AppError(403, 'No puedes destacar preguntas', 'ROOM_FORBIDDEN');
      next.pinned = changes.pinned === true;
    }
    next.updatedAt = new Date().toISOString();
    return write(next);
  });
}

async function remove(room, id, actor) {
  const record = await get(room, id);
  if (!record) throw new AppError(404, 'Pregunta no encontrada', 'NOT_FOUND');
  const moderator = ['ADMIN', 'ORGANIZER'].includes(actor.role);
  if (!moderator && !(record.authorIdentity === actor.identity && record.status === 'PENDING')) {
    throw new AppError(403, 'No puedes eliminar esta pregunta', 'ROOM_FORBIDDEN');
  }
  if (stateInS3()) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key(room, id) }));
  else await localStore.deleteJson('questions', storageId(room, id));
  return record;
}

module.exports = { STATUSES, create, get, list, publicQuestion, remove, toggleVote, update };
