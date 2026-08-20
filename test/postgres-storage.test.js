const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateRuntimeConfig } = require('../server/config');
const db = require('../server/db');
const postgresStore = require('../server/db/postgres-store');
const importer = require('../scripts/db-import-legacy');

test('PostgreSQL runtime configuration fails closed without DATABASE_URL', () => {
  const errors = validateRuntimeConfig({
    appEnv: 'production',
    dataBackend: 'postgres',
    databaseUrlConfigured: false,
    appName: 'R.A. Training Streaming',
    appTimeZone: 'America/Guayaquil',
    isProductionLike: false,
    isProduction: false,
    transcriptionEnabled: false,
  });
  assert.match(errors.join(' '), /DATABASE_URL is required/);
});

test('initial PostgreSQL migration defines relational tables, foreign keys and uniqueness guards', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'migrations', '001_initial_schema.sql'), 'utf8');
  for (const table of [
    'users',
    'meetings',
    'training_series',
    'invitations',
    'series_accesses',
    'room_configs',
    'room_participant_access',
    'attendance',
    'questions',
    'question_votes',
    'speaker_requests',
    'chat_pins',
    'audit_events',
    'transcriptions',
  ]) assert.match(sql, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  assert.match(sql, /REFERENCES training_series\(id\)/);
  assert.match(sql, /REFERENCES meetings\(id\)/);
  assert.match(sql, /series_accesses_one_active_general/);
  assert.match(sql, /series_accesses_one_active_individual/);
  assert.match(sql, /PRIMARY KEY \(question_id, participant_identity\)/);
});

test('distributed resilience migration defines durable webhook and idempotency state', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'migrations', '002_distributed_resilience.sql'), 'utf8');
  assert.match(sql, /CREATE TABLE IF NOT EXISTS livekit_webhook_events/);
  assert.match(sql, /event_id TEXT PRIMARY KEY/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS idempotency_keys/);
  assert.match(sql, /PRIMARY KEY \(scope, key\)/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_presence_event_at/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS last_presence_event_type/);
});

test('durable jobs migration defines worker queue and external session state', () => {
  const migration = fs.readFileSync(path.join(__dirname, '..', 'server', 'db', 'migrations', '003_durable_jobs_and_external_services.sql'), 'utf8');
  assert.match(migration, /CREATE TABLE IF NOT EXISTS background_jobs/);
  assert.match(migration, /FOR UPDATE SKIP LOCKED|background_jobs_claim_idx/);
  assert.match(migration, /background_jobs_active_dedupe_idx/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS worker_heartbeats/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS recording_egress_sessions/);
  assert.match(migration, /recording_egress_one_active_per_room_idx/);
  assert.match(migration, /CREATE TABLE IF NOT EXISTS facebook_live_sessions/);
  assert.match(migration, /facebook_live_one_active_per_room_idx/);
});

test('legacy importer maps stable keys without exposing plaintext secrets', () => {
  assert.equal(importer.keyFor('users', { username: 'admin' }), 'admin');
  assert.equal(importer.keyFor('meetings', { room: 'sala-uno' }), 'sala-uno');
  assert.equal(importer.keyFor('invitations', { tokenHash: 'hash-only' }), 'hash-only');
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'db-import-legacy.js'), 'utf8');
  assert.doesNotMatch(source, /console\.log\(.*token/i);
  assert.doesNotMatch(source, /console\.log\(.*password/i);
});

test('PostgreSQL id-backed records resolve legacy room-prefixed keys', () => {
  assert.equal(postgresStore.normalizedKey('questions', 'sala%20uno--question-123'), 'question-123');
  assert.equal(postgresStore.normalizedKey('questions', 'sala%20uno--ignored', { id: 'question-456' }), 'question-456');
  assert.equal(postgresStore.normalizedKey('chat-pins', 'sala%20uno--pin-123'), 'pin-123');
});

test('PostgreSQL list ordering uses the real timestamp column for audit events', () => {
  assert.equal(postgresStore.orderColumnFor('audit'), 'timestamp');
  assert.equal(postgresStore.orderColumnFor('questions'), 'created_at');
});

test('PostgreSQL SSL options make sslmode=require explicit without disabling verification', () => {
  const options = db.connectionOptions('postgres://user:pass@example.test/db?sslmode=require');
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.doesNotMatch(options.connectionString, /sslmode=/);
});
