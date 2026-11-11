import { expect, test } from '@playwright/test';
import { signIn } from './support/session.js';

test.describe('GET /admin/audit-logs', () => {
  test('refuses a caller who is not signed in', async ({ request }) => {
    const response = await request.get('admin/audit-logs');
    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
  });

  for (const account of ['customer', 'operatorAdmin'] as const) {
    test(`refuses the ${account} role`, async ({ request }) => {
      await signIn(request, account);
      const response = await request.get('admin/audit-logs');
      expect(response.status()).toBe(403);
      expect((await response.json()).error.code).toBe('FORBIDDEN');
    });
  }

  test('lists records newest first, with paging, for operations staff', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const response = await request.get('admin/audit-logs', {
      params: { pageSize: 5 },
    });
    expect(response.status()).toBe(200);

    const body = await response.json();
    expect(body.meta).toMatchObject({ page: 1, pageSize: 5 });
    expect(body.meta.total).toBeGreaterThan(0);
    expect(body.data.length).toBeLessThanOrEqual(5);
    const times = body.data.map((row: { createdAt: string }) => row.createdAt);
    expect(times).toEqual(
      [...times].sort((a: string, b: string) => b.localeCompare(a)),
    );
  });

  test('filters by action', async ({ request }) => {
    await signIn(request, 'ops');
    const response = await request.get('admin/audit-logs', {
      params: { action: 'auth.login' },
    });
    const body = await response.json();
    expect(body.data.length).toBeGreaterThan(0);
    for (const row of body.data) expect(row.action).toBe('auth.login');
  });

  test('rejects a page size above the maximum', async ({ request }) => {
    await signIn(request, 'ops');
    const response = await request.get('admin/audit-logs', {
      params: { pageSize: 500 },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });
});
