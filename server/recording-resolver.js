const { GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { s3, storageConfigured, bucket } = require('./s3');
const { config } = require('./config');
const { sanitizeText } = require('./http-utils');

function safeRecordingKey(recordingId, meeting) {
  const key = sanitizeText(recordingId, { field: 'recordingId', min: 10, max: 512, required: true });
  if (!/^recordings\/[a-z0-9-]{3,80}\/.+\.mp4$/i.test(key) || key.includes('..') || key.split('/')[1] !== meeting.room) return null;
  return key;
}

async function resolveRecording(recordingId, meeting, { client = s3 } = {}) {
  if (!storageConfigured || !client) return null;
  const key = safeRecordingKey(recordingId, meeting);
  if (!key) return null;
  try {
    const head = await client.send(new HeadObjectCommand({ Bucket: bucket, Key: key }));
    let metadata = {};
    const metadataKey = key.replace(/\.mp4$/i, '.metadata.json');
    try {
      const response = await client.send(new GetObjectCommand({ Bucket: bucket, Key: metadataKey }));
      metadata = JSON.parse(await response.Body.transformToString());
    } catch (error) {
      if (error.name !== 'NoSuchKey' && error.$metadata?.httpStatusCode !== 404) throw error;
    }
    return {
      id: key,
      key,
      source: 's3',
      meetingId: meeting.id,
      room: meeting.room,
      status: 'READY',
      available: true,
      objectKey: key,
      url: await getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: config.transcriptionPresignedUrlTtlSeconds }),
      size: Number(head.ContentLength || 0),
      contentType: head.ContentType || 'video/mp4',
      participants: Array.isArray(metadata.participants) ? metadata.participants : [],
      tracks: Array.isArray(metadata.tracks) ? metadata.tracks : [],
      durationSeconds: Number(metadata.durationSeconds || head.Metadata?.durationSeconds || head.Metadata?.durationseconds || 0) || 0,
      createdAt: head.LastModified ? head.LastModified.toISOString() : null,
    };
  } catch (error) {
    if (error.name === 'NotFound' || error.name === 'NoSuchKey' || error.$metadata?.httpStatusCode === 404) return null;
    throw error;
  }
}

module.exports = { resolveRecording, safeRecordingKey };
