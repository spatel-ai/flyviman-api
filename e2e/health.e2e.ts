import { expect, test } from '@playwright/test';

test.describe('GET /health', () => {
  test('answers 200 in the success envelope', async ({ request }) => {
    const response = await request.get('health');

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data.status).toBe('ok');
    expect(['up', 'down']).toContain(body.data.checks.database);
    expect(typeof body.data.uptimeSeconds).toBe('number');
    expect(body.meta.requestId).toBeTruthy();
  });

  test('carries the Helmet security headers', async ({ request }) => {
    // Guards the Helmet import in app.setup.ts: a wrong unwrap would either
    // fail to start or start without these headers.
    const headers = (await request.get('health')).headers();
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['x-frame-options']).toBe('SAMEORIGIN');
    expect(headers['strict-transport-security']).toContain('max-age=');
    expect(headers['content-security-policy']).toContain("default-src 'self'");
    expect(headers['x-powered-by']).toBeUndefined();
  });

  test('echoes a caller-supplied request ID', async ({ request }) => {
    const response = await request.get('health', {
      headers: { 'X-Request-Id': 'e2e-request-123' },
    });

    expect(response.headers()['x-request-id']).toBe('e2e-request-123');
    expect((await response.json()).meta.requestId).toBe('e2e-request-123');
  });
});

test.describe('error envelope', () => {
  test('unknown routes answer 404 with a stable error code', async ({
    request,
  }) => {
    const response = await request.get('no-such-route');

    expect(response.status()).toBe(404);
    const body = await response.json();
    expect(body.error.code).toBe('NOT_FOUND');
    expect(body.error.requestId).toBeTruthy();
    expect(body.data).toBeUndefined();
  });
});

test.describe('API reference', () => {
  test('serves the OpenAPI document', async ({ request }) => {
    const response = await request.get('/api/docs-json');

    expect(response.status()).toBe(200);
    const document = await response.json();
    expect(document.info.title).toBe('Flyviman API');
    expect(document.paths['/api/v1/health']).toBeDefined();
  });
});
