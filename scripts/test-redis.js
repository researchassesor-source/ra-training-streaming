const { spawnSync } = require('node:child_process');

if (!process.env.TEST_REDIS_URL) {
  console.log('Redis integration tests: NOT RUN — TEST_REDIS_URL not available');
  process.exit(0);
}

const env = {
  ...process.env,
  NODE_ENV: 'test',
  APP_ENV: 'test',
  REDIS_URL: process.env.TEST_REDIS_URL,
};

const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', 'test/redis.integration.js'], {
  stdio: 'inherit',
  env,
  shell: false,
});

process.exit(result.status || 0);
