// Example: 4173, unless PLAYWRIGHT_PORT overrides the smoke-test server port.
const PORT = Number(process.env.PLAYWRIGHT_PORT || 4173);

// Example: http://127.0.0.1:4173, or an externally managed server URL.
const baseURL = process.env.PLAYWRIGHT_BASE_URL || `http://127.0.0.1:${PORT}`;
const PYTHON = process.env.PYTHON || 'node scripts/run_python.mjs';

import { defineConfig, devices } from '@playwright/test';

// Shape: Playwright config for the no-bundler static viewer smoke tests.
const config = {
  testDir: './tests/browser',
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
};

if (!process.env.PLAYWRIGHT_BASE_URL) {
  config.webServer = {
    command: `${PYTHON} serve.py --port ${PORT}`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    timeout: 15_000,
    stdout: 'pipe',
    stderr: 'pipe',
  };
}

export default defineConfig(config);
