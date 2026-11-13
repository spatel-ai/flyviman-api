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

  test('does not publish the interactive API reference', async ({
    request,
  }) => {
    expect((await request.get(`${POC_ORIGIN}/api/docs-json`)).status()).toBe(
      404,
    );
    expect((await request.get(`${POC_ORIGIN}/api/docs`)).status()).toBe(404);
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
    // Accepted: the sink provider took the message without delivering it,
    // and nothing in the answer carries the code.
    expect(register.status()).toBe(202);
    // A leaked code would be a value of its own, quoted or not; digits inside
    // the verification id (a UUID) are not a code.
    const body = JSON.stringify(await register.json());
    expect(body).not.toMatch(/"\d{6}"|:\d{6}[,}]/);
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
