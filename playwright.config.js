import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  timeout: 45_000,
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:8799',
    viewport: { width: 1440, height: 1000 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  webServer: {
    command: 'node e2e/serve.js',
    url: 'http://127.0.0.1:8799/api/health',
    reuseExistingServer: false,
    timeout: 60_000,
    env: {
      PORT: '8799',
      DB_PATH: '/tmp/signal-loop-e2e.db',
    },
  },
});
