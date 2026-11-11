import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.PORT ?? 4000);
const ORIGIN = `http://localhost:${PORT}`;
const STRICT_ORIGIN = `http://localhost:${PORT + 1}`;

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
  // Both need PostgreSQL and Redis running (`npm run db:up`).
  webServer: [
    {
      // Main server: applies migrations, seeds the local accounts, and runs
      // with rate limits out of the way so tests can sign in freely.
      command:
        'npm run build && npx prisma migrate deploy && node dist/seed.js && npm run start:prod',
      url: `${ORIGIN}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        ENABLE_DEV_TOOLS: 'true',
        PORT: String(PORT),
        RATE_LIMIT_AUTH_PER_MINUTE: '100000',
        RATE_LIMIT_DEFAULT_PER_MINUTE: '100000',
        REFRESH_ROTATION_GRACE_SECONDS: '0',
        OTP_RESEND_COOLDOWN_SECONDS: '0',
        OTP_MAX_PER_HOUR: '100000',
      },
    },
    {
      // Second server with the real limits, for the rate-limit tests only.
      command: `until [ -f dist/main.js ] && curl -sf ${ORIGIN}/api/v1/health >/dev/null; do sleep 1; done; npm run start:prod`,
      url: `${STRICT_ORIGIN}/api/v1/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
      env: {
        NODE_ENV: 'test',
        ENABLE_DEV_TOOLS: 'true',
        PORT: String(PORT + 1),
      },
    },
  ],
});
