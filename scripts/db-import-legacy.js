require('dotenv').config({ quiet: true });
if (!process.env.DATA_BACKEND) process.env.DATA_BACKEND = 'postgres';
const { GetObjectCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
const localStore = require('../server/local-store');
const postgresStore = require('../server/db/postgres-store');
const db = require('../server/db');
const { s3, storageConfigured, bucket } = require('../server/s3');

const SECTIONS = [
  'users',
  'training-series',
  'meetings',
  'rooms',
  'invitations',
  'series-accesses',
  'attendance',
  'questions',
  'speaker-requests',
  'chat-pins',
  'transcriptions',
  'audit',
];

function parseArgs(argv) {
  return {
    dryRun: argv.includes('--dry-run'),
    source: (argv.find((arg) => arg.startsWith('--source=')) || '--source=auto').split('=')[1],
  };
}

function keyFor(section, record) {
  if (section === 'users') return record.username;
  if (section === 'meetings') return record.room;
  if (section === 'training-series') return record.id;
  if (section === 'invitations') return record.tokenHash;
  if (section === 'rooms') return record.room;
  if (section === 'questions' || section === 'speaker-requests' || section === 'chat-pins') return `${encodeURIComponent(record.room)}--${record.id}`;
  return record.id;
}

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]));
}

function equivalent(left, right) {
  return JSON.stringify(stable(left)) === JSON.stringify(stable(right));
}

async function listFromS3(section) {
  if (!storageConfigured) throw new Error('S3/R2 legacy source requested but recording storage is not configured.');
  const prefix = `${section}/`;
  const items = [];
  let ContinuationToken;
  do {
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken }));
    for (const object of listing.Contents || []) {
      if (!object.Key.endsWith('.json')) continue;
      const response = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: object.Key }));
      items.push(JSON.parse(await response.Body.transformToString()));
    }
    ContinuationToken = listing.NextContinuationToken;
  } while (ContinuationToken);
  return items;
}

async function listSource(section, source) {
  if (source === 's3' || source === 'r2') return listFromS3(section);
  if (source === 'local') return localStore.listLegacyJson(section);
  if (source === 'auto') {
    const local = await localStore.listLegacyJson(section);
    if (local.length || !storageConfigured) return local;
    return listFromS3(section);
  }
  throw new Error('Source must be auto, local, s3 or r2.');
}

async function importSection(section, source, { dryRun }) {
  const records = await listSource(section, source);
  const summary = { source: records.length, imported: 0, existing: 0, conflicts: 0, failed: 0 };
  for (const record of records) {
    try {
      const key = keyFor(section, record);
      if (!key) {
        summary.failed += 1;
        continue;
      }
      const existing = await postgresStore.readJson(section, key);
      if (existing) {
        if (equivalent(existing, record)) summary.existing += 1;
        else summary.conflicts += 1;
        continue;
      }
      if (!dryRun) await postgresStore.writeJson(section, key, record);
      summary.imported += 1;
    } catch {
      summary.failed += 1;
    }
  }
  return summary;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!process.env.DATABASE_URL && !process.env.DATABASE_URL_DIRECT) {
    throw new Error('DATABASE_URL or DATABASE_URL_DIRECT is required for legacy import.');
  }
  const summaries = {};
  await db.transaction(async () => {
    for (const section of SECTIONS) summaries[section] = await importSection(section, options.source, options);
    if (options.dryRun) throw Object.assign(new Error('DRY_RUN_ROLLBACK'), { dryRunRollback: true });
  }).catch((error) => {
    if (!error.dryRunRollback) throw error;
  });
  console.log(`Legacy import ${options.dryRun ? 'dry-run' : 'write'} summary`);
  for (const [section, summary] of Object.entries(summaries)) {
    console.log(`${section}: source=${summary.source} imported=${summary.imported} existing=${summary.existing} conflicts=${summary.conflicts} failed=${summary.failed}`);
  }
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || 'Legacy import failed');
    process.exit(1);
  }).finally(() => db.closePool());
}

module.exports = { importSection, keyFor, parseArgs };
