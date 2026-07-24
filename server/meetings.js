// Scheduled meeting metadata, stored as JSON in R2 (one object per room).
const { PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { s3, storageConfigured, bucket } = require('./s3');

function keyFor(room) {
  return `meetings/${encodeURIComponent(room)}.json`;
}

async function createMeeting({ room, title, scheduledAt, hostCode, viewerPassword, createdBy }) {
  const record = { room, title, scheduledAt, hostCode, viewerPassword, createdBy, createdAt: Date.now() };
  if (storageConfigured) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: keyFor(room),
        Body: JSON.stringify(record),
        ContentType: 'application/json',
      })
    );
  }
  return record;
}

async function listMeetings() {
  if (!storageConfigured) return [];
  const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: 'meetings/' }));
  const items = await Promise.all(
    (listing.Contents || []).map(async (obj) => {
      const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: obj.Key }));
      const body = await res.Body.transformToString();
      return JSON.parse(body);
    })
  );
  items.sort((a, b) => new Date(a.scheduledAt || 0) - new Date(b.scheduledAt || 0));
  return items;
}

async function getMeeting(room) {
  if (!storageConfigured) return undefined;
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: keyFor(room) }));
    return JSON.parse(await res.Body.transformToString());
  } catch {
    return undefined;
  }
}

async function updateMeeting(room, updates) {
  const existing = await getMeeting(room);
  if (!existing) throw new Error('Reunión no encontrada');
  const updated = { ...existing, ...updates };
  if (storageConfigured) {
    await s3.send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: keyFor(room),
        Body: JSON.stringify(updated),
        ContentType: 'application/json',
      })
    );
  }
  return updated;
}

async function deleteMeeting(room) {
  if (storageConfigured) {
    await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: keyFor(room) })).catch(() => {});
  }
}

module.exports = { createMeeting, listMeetings, getMeeting, updateMeeting, deleteMeeting };
