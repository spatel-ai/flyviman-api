import { expect, test } from '@playwright/test';
import { POC_ORIGIN } from '../playwright.config.js';

/**
 * The API as a proof-of-concept host runs it (D-064): it starts in
 * production with no development tools, discards messages, and keeps files
 * on its own disk behind signed links.
 */
test.describe('proof-of-concept host', () => {
  test.use({ baseURL: `${POC_ORIGIN}/api/v1/` });

  test('starts in production and answers health', async ({ request }) => {
    const health = await request.get('health');
    expect(health.status()).toBe(200);
    expect((await health.json()).data.status).toBe('ok');
  });

  test('never exposes the development outbox', async ({ request }) => {
    const outbox = await request.get('dev/outbox', {
      params: { to: 'anyone@example.com' },
    });
    expect(outbox.status()).toBe(404);
  });

  test('accepts a registration but delivers and exposes no code', async ({
    request,
  }) => {
    const register = await request.post('auth/register', {
      headers: { Origin: 'https://flyviman-web.example.com' },
      data: {
        firstName: 'Asha',
        lastName: 'Rao',
        email: `poc-${Date.now()}@example.com`,
        password: 'correct horse battery staple',
        acceptTerms: true,
      },
    });
    // The request is accepted (or refused for CSRF/rate limits), never 500:
    // the sink provider took the message.
    expect(register.status()).toBeLessThan(500);
    expect(JSON.stringify(await register.json())).not.toMatch(/\b\d{6}\b/);
  });

  test('serves the local store only through valid signed links', async ({
    request,
  }) => {
    // The route is open (not 404), and a forged ticket is refused.
    const forged = await request.get('dev/storage/forged.ticket');
    expect(forged.status()).not.toBe(404);
    expect(forged.status()).toBeGreaterThanOrEqual(400);
    expect(forged.status()).toBeLessThan(500);
  });
});
