const { Pool } = require('pg');
const { config } = require('../config');

let pool;

function usingPostgres() {
  return config.dataBackend === 'postgres';
}

function connectionString({ direct = false } = {}) {
  return direct
    ? (process.env.DATABASE_URL_DIRECT || process.env.DATABASE_URL || '')
    : (process.env.DATABASE_URL || '');
}

function connectionOptions(url) {
  const options = { connectionString: url };
  try {
    const parsed = new URL(url);
    const sslMode = parsed.searchParams.get('sslmode');
    if (['require', 'verify-ca', 'verify-full'].includes(sslMode)) {
      parsed.searchParams.delete('sslmode');
      options.connectionString = parsed.toString();
      options.ssl = { rejectUnauthorized: true };
    }
  } catch {
    // Let pg surface malformed connection strings without logging their content.
  }
  return options;
}

function createPool({ direct = false } = {}) {
  const url = connectionString({ direct });
  if (!url) throw new Error(direct ? 'DATABASE_URL_DIRECT or DATABASE_URL is required for PostgreSQL administration.' : 'DATABASE_URL is required when DATA_BACKEND=postgres.');
  return new Pool({
    ...connectionOptions(url),
    max: config.databasePoolMax,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: config.databaseStatementTimeoutMs,
    application_name: 'ra-training-streaming',
  });
}

function getPool() {
  if (!usingPostgres()) throw new Error('PostgreSQL data backend is not enabled.');
  if (!pool) pool = createPool();
  return pool;
}

async function query(text, params = []) {
  return getPool().query(text, params);
}

async function transaction(callback) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => null);
    throw error;
  } finally {
    client.release();
  }
}

async function ping() {
  const result = await query('SELECT 1 AS ok');
  return result.rows[0]?.ok === 1;
}

async function closePool() {
  if (!pool) return;
  const current = pool;
  pool = null;
  await current.end();
}

module.exports = {
  closePool,
  connectionString,
  connectionOptions,
  createPool,
  getPool,
  ping,
  query,
  transaction,
  usingPostgres,
};
