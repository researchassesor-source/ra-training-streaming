const { HeadBucketCommand, S3Client } = require('@aws-sdk/client-s3');
const { config } = require('./config');

const storageConfigured = Boolean(
  process.env.RECORDING_S3_ACCESS_KEY && process.env.RECORDING_S3_SECRET_KEY && process.env.RECORDING_S3_BUCKET
);

const s3 = storageConfigured
  ? new S3Client({
      region: process.env.RECORDING_S3_REGION || 'auto',
      endpoint: process.env.RECORDING_S3_ENDPOINT || undefined,
      forcePathStyle: false,
      credentials: {
        accessKeyId: process.env.RECORDING_S3_ACCESS_KEY,
        secretAccessKey: process.env.RECORDING_S3_SECRET_KEY,
      },
    })
  : null;

function createStorageStatusProbe({ client = s3, timeoutMs = 3_000, cacheMs = 30_000 } = {}) {
  let cached;
  let cachedAt = 0;
  return async function storageStatus({ fresh = false } = {}) {
    if (!storageConfigured || !client) return {
      configured: false,
      available: !config.isProductionLike,
      mode: 'filesystem',
      checkedAt: new Date().toISOString(),
    };
    if (!fresh && cached && Date.now() - cachedAt < cacheMs) return cached;
    let timer;
    try {
      await Promise.race([
        client.send(new HeadBucketCommand({ Bucket: process.env.RECORDING_S3_BUCKET })),
        new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error('Timeout'), { code: 'STORAGE_TIMEOUT' })), timeoutMs); }),
      ]);
      cached = { configured: true, available: true, mode: 's3', checkedAt: new Date().toISOString() };
    } catch (error) {
      cached = { configured: true, available: false, mode: 's3', checkedAt: new Date().toISOString(), errorCode: String(error.code || error.name || 'STORAGE_UNAVAILABLE').slice(0, 80) };
    } finally {
      clearTimeout(timer);
    }
    cachedAt = Date.now();
    return cached;
  };
}

const storageStatus = createStorageStatusProbe();

module.exports = {
  s3,
  storageConfigured,
  bucket: process.env.RECORDING_S3_BUCKET,
  createStorageStatusProbe,
  storageStatus,
};
