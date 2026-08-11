const { GetObjectCommand, ListObjectsV2Command, PutObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');
const localStore = require('./local-store');

function idFor(seriesId, meetingId, participantKey) { return `${seriesId}--${meetingId}--${participantKey}`; }
function keyFor(id) { return `attendance/${encodeURIComponent(id)}.json`; }
async function write(record) {
  if (storageConfigured) await s3.send(new PutObjectCommand({ Bucket: bucket, Key: keyFor(record.id), Body: JSON.stringify(record), ContentType: 'application/json' }));
  else await localStore.writeJson('attendance', record.id, record);
  return record;
}
async function read(id) {
  if (!storageConfigured) return localStore.readJson('attendance', id);
  try { const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(id) })); return JSON.parse(await response.Body.transformToString()); }
  catch (error) { if (error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return undefined; throw error; }
}
async function joined({ seriesId, meetingId, sessionNumber, participantKey, participantIdentity, participantName }) {
  if (!seriesId || !participantKey) return null;
  const id = idFor(seriesId, meetingId, participantKey); const existing = await read(id); const now = new Date().toISOString();
  return write({
    id, seriesId, meetingId, sessionNumber, participantKey, participantIdentity, participantName,
    firstJoinedAt: existing?.firstJoinedAt || now, lastJoinedAt: now, lastLeftAt: existing?.lastLeftAt || null,
    activeSince: existing?.activeSince || now, accumulatedMs: Number(existing?.accumulatedMs || 0), joinCount: Number(existing?.joinCount || 0) + (existing?.activeSince ? 0 : 1), updatedAt: now,
  });
}
async function left({ seriesId, meetingId, participantKey }) {
  if (!seriesId || !participantKey) return null;
  const id = idFor(seriesId, meetingId, participantKey); const existing = await read(id); if (!existing) return null;
  const now = new Date(); const activeStart = existing.activeSince ? new Date(existing.activeSince).getTime() : null;
  const elapsed = Number.isFinite(activeStart) ? Math.max(0, now.getTime() - activeStart) : 0;
  return write({ ...existing, lastLeftAt: now.toISOString(), activeSince: null, accumulatedMs: Number(existing.accumulatedMs || 0) + elapsed, updatedAt: now.toISOString() });
}
async function listSeriesAttendance(seriesId) {
  let items;
  if (storageConfigured) {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'attendance/' }));
    items = await Promise.all((listing.Contents || []).map(async (object) => { const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key })); return JSON.parse(await response.Body.transformToString()); }));
  } else items = await localStore.listJson('attendance');
  return items.filter((item) => item.seriesId === seriesId).sort((a, b) => String(a.participantName).localeCompare(String(b.participantName)) || Number(a.sessionNumber) - Number(b.sessionNumber));
}
module.exports = { joined, left, listSeriesAttendance };
