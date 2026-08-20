const { defineConfig, devices } = require('@playwright/test');

const port = Number(process.env.E2E_PORT || 3321);
const baseURL = `http://127.0.0.1:${port}`;

module.exports = defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
  webServer: {
    command: `node scripts/e2e-server.js`,
    url: `${baseURL}/live`,
    timeout: 20_000,
    reuseExistingServer: !process.env.CI,
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'test',
      APP_ENV: 'test',
    },
  },
  projects: [
    {
      name: 'chromium-desktop',
      testMatch: /smoke\.spec\.js/,
      use: { ...devices['Desktop Chrome'], viewport: { width: 1366, height: 768 } },
    },
    {
      name: 'chromium-mobile',
      testMatch: /mobile\.spec\.js/,
      use: { ...devices['Pixel 5'], viewport: { width: 390, height: 844 } },
    },
  ],
});
