const crypto = require('crypto');
const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');
const { AppError } = require('./http-utils');

const STATUSES = new Set(['PENDING', 'GRANTED', 'REJECTED', 'REVOKED']);
const locks = new Map();
function storageKey(room, id) { return `${encodeURIComponent(room)}--${id}`; }
function s3Key(room, id) { return `speaker-requests/${encodeURIComponent(room)}/${id}.json`; }

async function writeRequest(record) {
  if (storageConfigured) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: s3Key(record.room, record.id), Body: JSON.stringify(record), ContentType: 'application/json' }));
  else await localStore.writeJson('speaker-requests', storageKey(record.room, record.id), record);
  return record;
}

async function listRequests(room, { activeOnly = false } = {}) {
  let items;
  if (storageConfigured) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `speaker-requests/${encodeURIComponent(room)}/` }));
    items = await Promise.all((listing.Contents || []).map(async (object) => {
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      return JSON.parse(await response.Body.transformToString());
    }));
  } else items = (await localStore.listJson('speaker-requests')).filter((item) => item.room === room);
  return items.filter((item) => !activeOnly || ['PENDING', 'GRANTED'].includes(item.status)).sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
}

async function withLock(key, operation) {
  const previous = locks.get(key) || Promise.resolve(); let release;
  const current = new Promise((resolve) => { release = resolve; }); locks.set(key, current); await previous;
  try { return await operation(); } finally { release(); if (locks.get(key) === current) locks.delete(key); }
}

async function requestSpeaker({ meetingId, room, participantIdentity, participantName }) {
  return withLock(`${room}:${participantIdentity}`, async () => {
    const existing = (await listRequests(room, { activeOnly: true })).find((item) => item.participantIdentity === participantIdentity);
    if (existing) return existing;
    const record = {
      id: crypto.randomUUID(), meetingId, room, participantIdentity,
      participantName: String(participantName || 'Participante').slice(0, 80), requestedAt: new Date().toISOString(),
      status: 'PENDING', resolvedAt: null, resolvedBy: null,
    };
    return writeRequest(record);
  });
}

async function resolveSpeaker(room, participantIdentity, status, actor) {
  if (!STATUSES.has(status) || status === 'PENDING') throw new AppError(400, 'Estado de solicitud no v\u00e1lido', 'VALIDATION_ERROR');
  return withLock(`${room}:${participantIdentity}`, async () => {
    const existing = (await listRequests(room, { activeOnly: true })).find((item) => item.participantIdentity === participantIdentity);
    if (!existing) return null;
    return writeRequest({ ...existing, status, resolvedAt: new Date().toISOString(), resolvedBy: String(actor || '').slice(0, 100) });
  });
}

module.exports = { listRequests, requestSpeaker, resolveSpeaker };
