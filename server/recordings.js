const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const db = require('./db');
const { s3, bucket } = require('./s3');
const { config } = require('./config');
const { AppError, sanitizeText } = require('./http-utils');
const { decodeCursor, encodeCursor } = require('./pagination');

function validateRecordingKey(value) {
  const key = sanitizeText(value, { field: 'key', min: 10, max: 512, required: true });
  if (!/^recordings\/[a-z0-9-]{3,80}\/.+\.mp4$/i.test(key) || key.includes('..')) {
    throw new AppError(400, 'Clave de grabación no válida', 'VALIDATION_ERROR');
  }
  return key;
}

function objectKeyFromSession(row) {
  return row.output_object_key || row.metadata?.outputObjectKey || row.metadata?.filepath || null;
}

async function listPostgresRecordings({ room = null, limit = 50, cursor = null } = {}) {
  const params = [];
  const where = ["r.output_object_key IS NOT NULL", "r.status IN ('READY', 'PROCESSING', 'RECORDING', 'STOPPING')"];
  if (room) {
    params.push(room);
    where.push(`r.room = $${params.length}`);
  }
  const decoded = decodeCursor(cursor);
  if (decoded) {
    if (!decoded.updatedAt || !decoded.id) throw new AppError(400, 'Cursor de grabaciones no válido', 'VALIDATION_ERROR');
    params.push(decoded.updatedAt, decoded.id);
    where.push(`(r.updated_at, r.id) < ($${params.length - 1}::timestamptz, $${params.length}::uuid)`);
  }
  params.push(limit + 1);
  const result = await db.query(
    `SELECT
       r.id, r.meeting_id, r.room, r.status, r.output_object_key, r.metadata, r.updated_at, r.created_at,
       m.data AS meeting_data,
       t.data AS transcript_data
     FROM recording_egress_sessions r
     LEFT JOIN meetings m ON m.id = r.meeting_id
     LEFT JOIN LATERAL (
       SELECT data
       FROM transcriptions
       WHERE recording_id = r.output_object_key
       ORDER BY created_at DESC NULLS LAST
       LIMIT 1
     ) t ON true
     WHERE ${where.join(' AND ')}
     ORDER BY r.updated_at DESC NULLS LAST, r.id DESC
     LIMIT $${params.length}`,
    params
  );
  const rows = result.rows;
  const items = rows.slice(0, limit).map((row) => {
    const meeting = row.meeting_data || {};
    const transcript = row.transcript_data || null;
    const key = objectKeyFromSession(row);
    return {
      id: key,
      key,
      room: row.room,
      meetingId: row.meeting_id,
      title: meeting.title || row.room,
      trainerName: meeting.trainerName || 'Capacitador por definir',
      size: Number(row.metadata?.size || 0),
      lastModified: row.updated_at || row.created_at,
      status: row.status === 'READY' ? 'READY' : 'PROCESSING',
      source: row.metadata?.source || 'ROOM_COMPOSITE',
      participants: Array.isArray(row.metadata?.participants) ? row.metadata.participants : [],
      tracks: Array.isArray(row.metadata?.tracks) ? row.metadata.tracks : [],
      transcript,
      transcriptionAllowed: Boolean(meeting.allowTranscription && meeting.status === 'COMPLETED'),
      meeting,
    };
  });
  return {
    items,
    nextCursor: rows.length > limit && rows[limit - 1] ? encodeCursor({ updatedAt: rows[limit - 1].updated_at, id: rows[limit - 1].id }) : null,
  };
}

async function listS3Recordings({ room = null, limit = 50, continuationToken = null } = {}) {
  const prefix = room ? `recordings/${room}/` : 'recordings/';
  const response = await s3.send(new ListObjectsV2Command({
    Bucket: bucket,
    Prefix: prefix,
    MaxKeys: Math.min(1_000, limit),
    ContinuationToken: continuationToken || undefined,
  }));
  return {
    objects: (response.Contents || []).filter((object) => object.Key.endsWith('.mp4')),
    nextCursor: response.NextContinuationToken || null,
  };
}

async function signedRecordingUrl(key) {
  const safeKey = validateRecordingKey(key);
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: safeKey }), { expiresIn: config.transcriptionPresignedUrlTtlSeconds });
}

module.exports = { listPostgresRecordings, listS3Recordings, signedRecordingUrl, validateRecordingKey };
