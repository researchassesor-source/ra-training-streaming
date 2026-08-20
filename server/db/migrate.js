const fs = require('fs/promises');
const path = require('path');
const { createPool } = require('./index');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');
const LOCK_KEY = 72638421;

async function listMigrationFiles() {
  const files = await fs.readdir(MIGRATIONS_DIR);
  return files.filter((name) => /^\d+_.+\.sql$/i.test(name)).sort();
}

async function ensureMigrationTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(client) {
  await ensureMigrationTable(client);
  const result = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(result.rows.map((row) => row.version));
}

function migrationVersion(file) {
  return file.split('_')[0];
}

async function withMigrationClient(callback) {
  const pool = createPool({ direct: true });
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK_KEY]);
    return await callback(client);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => null);
    client.release();
    await pool.end();
  }
}

async function migrate({ quiet = false } = {}) {
  return withMigrationClient(async (client) => {
    const files = await listMigrationFiles();
    const applied = await appliedVersions(client);
    const executed = [];
    for (const file of files) {
      const version = migrationVersion(file);
      if (applied.has(version)) continue;
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query(
          'INSERT INTO schema_migrations (version, name) VALUES ($1, $2)',
          [version, file]
        );
        await client.query('COMMIT');
        executed.push(file);
        if (!quiet) console.log(`Applied migration ${file}`);
      } catch (error) {
        await client.query('ROLLBACK').catch(() => null);
        throw error;
      }
    }
    if (!quiet && executed.length === 0) console.log('No pending migrations');
    return { executed, total: files.length };
  });
}

async function status() {
  return withMigrationClient(async (client) => {
    const files = await listMigrationFiles();
    const applied = await appliedVersions(client);
    const items = files.map((file) => ({ version: migrationVersion(file), name: file, applied: applied.has(migrationVersion(file)) }));
    return { items, pending: items.filter((item) => !item.applied).length };
  });
}

async function main() {
  const command = process.argv[2] || 'migrate';
  if (command === 'status') {
    const result = await status();
    for (const item of result.items) console.log(`${item.applied ? 'applied' : 'pending'} ${item.name}`);
    console.log(`Pending migrations: ${result.pending}`);
    return;
  }
  if (command !== 'migrate') throw new Error('Usage: node server/db/migrate.js [migrate|status]');
  await migrate();
}

if (require.main === module) {
  main().catch((error) => {
    console.error(error.message || 'Database migration failed');
    process.exit(1);
  });
}

module.exports = { migrate, status };
