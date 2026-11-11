import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 4000);
const ORIGIN = `http://localhost:${PORT}`;

/**
 * API integration tests. They call the running API over HTTP through
 * Playwright's request client; no browser is involved.
 * Conventions: ../docs/testing-strategy.md
 */
export default defineConfig({
  testDir: './e2e',
  testMatch: '**/*.e2e.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    // Trailing slash matters: tests request relative paths such as `health`.
    baseURL: `${ORIGIN}/api/v1/`,
    extraHTTPHeaders: { Accept: 'application/json' },
  },
  webServer: {
    command: 'npm run build && npm run start:prod',
    url: `${ORIGIN}/api/v1/health`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
