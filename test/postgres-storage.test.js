const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { validateRuntimeConfig } = require('../server/config');
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

test('legacy importer maps stable keys without exposing plaintext secrets', () => {
  assert.equal(importer.keyFor('users', { username: 'admin' }), 'admin');
  assert.equal(importer.keyFor('meetings', { room: 'sala-uno' }), 'sala-uno');
  assert.equal(importer.keyFor('invitations', { tokenHash: 'hash-only' }), 'hash-only');
  const source = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'db-import-legacy.js'), 'utf8');
  assert.doesNotMatch(source, /console\.log\(.*token/i);
  assert.doesNotMatch(source, /console\.log\(.*password/i);
});
