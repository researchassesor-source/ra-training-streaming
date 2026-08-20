const { spawnSync } = require('node:child_process');

if (!process.env.TEST_DATABASE_URL) {
  console.log('PostgreSQL integration tests: NOT RUN — no PostgreSQL test connection available');
  process.exit(0);
}

const env = {
  ...process.env,
  NODE_ENV: 'test',
  APP_ENV: 'test',
  DATA_BACKEND: 'postgres',
  DATABASE_URL: process.env.TEST_DATABASE_URL,
  DATABASE_URL_DIRECT: process.env.TEST_DATABASE_URL_DIRECT || process.env.TEST_DATABASE_URL,
  REDIS_URL: '',
  TEST_REDIS_URL: '',
  SESSION_SECRET: process.env.SESSION_SECRET || 'test-session-secret-with-more-than-32-characters',
  INVITATION_HASH_SECRET: process.env.INVITATION_HASH_SECRET || 'test-invitation-secret-with-more-than-32-characters',
};

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/postgres.integration.js'], {
  stdio: 'inherit',
  env,
  shell: false,
});

process.exit(result.status || 0);
