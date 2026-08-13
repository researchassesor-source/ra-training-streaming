const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { AppError, sanitizeText } = require('./http-utils');

function storageId(room, id) {
  return `${encodeURIComponent(room)}--${id}`;
}

function s3Key(room, id) {
  return `chat-pins/${encodeURIComponent(room)}/${id}.json`;
}

async function write(record) {
  if (storageConfigured) {
    await s3.send(new PutObjectCommand({ Bucket: bucket, Key: s3Key(record.room, record.id), Body: JSON.stringify(record), ContentType: 'application/json' }));
  } else {
    await localStore.writeJson('chat-pins', storageId(record.room, record.id), record);
  }
  return record;
}

async function get(room, id) {
  if (!storageConfigured) return localStore.readJson('chat-pins', storageId(room, id));
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
  if (storageConfigured) {
    const response = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `chat-pins/${encodeURIComponent(room)}/` }));
    items = await Promise.all((response.Contents || []).map(async ({ Key }) => {
      const result = await s3.send(new GetObjectCommand({ Bucket: bucket, Key }));
      return JSON.parse(await result.Body.transformToString());
    }));
  } else {
    items = (await localStore.listJson('chat-pins')).filter((item) => item.room === room);
  }
  return items.sort((a, b) => String(a.pinnedAt).localeCompare(String(b.pinnedAt)));
}

function publicPin(record) {
  return {
    id: record.id,
    text: record.text,
    authorName: record.authorName,
    authorRole: record.authorRole,
    sourceSentAt: record.sourceSentAt || null,
    pinnedBy: record.pinnedBy,
    pinnedAt: record.pinnedAt,
  };
}

function normalizeOptionalDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function create({ room, meetingId, text, authorName, authorRole, sourceSentAt, pinnedBy }) {
  const now = new Date().toISOString();
  const record = {
    id: crypto.randomUUID(),
    room,
    meetingId,
    text: sanitizeText(text, { field: 'Mensaje fijado', min: 1, max: 2_000, required: true }),
    authorName: sanitizeText(authorName || 'Participante', { field: 'Autor', min: 1, max: 80, required: true }),
    authorRole: sanitizeText(authorRole || 'ATTENDEE', { field: 'Rol', min: 1, max: 40, required: true }).toUpperCase(),
    sourceSentAt: normalizeOptionalDate(sourceSentAt),
    pinnedBy: sanitizeText(pinnedBy || 'Organizador', { field: 'Fijado por', min: 1, max: 80, required: true }),
    pinnedAt: now,
  };
  return write(record);
}

async function remove(room, id) {
  const record = await get(room, id);
  if (!record) throw new AppError(404, 'Mensaje fijado no encontrado', 'NOT_FOUND');
  if (storageConfigured) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: s3Key(room, id) }));
  else await localStore.deleteJson('chat-pins', storageId(room, id));
  return record;
}

module.exports = { create, get, list, publicPin, remove };
