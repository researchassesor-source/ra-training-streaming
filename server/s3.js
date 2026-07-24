const { S3Client } = require('@aws-sdk/client-s3');

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

module.exports = {
  s3,
  storageConfigured,
  bucket: process.env.RECORDING_S3_BUCKET,
};
