import {
  type APIRequestContext,
  expect,
  type PlaywrightWorkerArgs,
  test,
} from '@playwright/test';
import { ACCOUNTS } from './support/accounts.js';
import { latestLinkToken, PASSWORD, uniqueEmail } from './support/data.js';
import { csrfHeaders, signIn } from './support/session.js';

type Playwright = PlaywrightWorkerArgs['playwright'];

/**
 * Invites an internal account as the super administrator in `admin`, accepts
 * the invitation and signs it in on a context of its own. Never uses a
 * seeded account, so other files keep their roles.
 */
async function staffMember(
  admin: APIRequestContext,
  playwright: Playwright,
  baseURL: string | undefined,
  role: 'OPS' | 'FINANCE_ADMIN' | 'SUPER_ADMIN',
): Promise<{ id: string; email: string; context: APIRequestContext }> {
  const email = uniqueEmail('role');
  const created = await admin.post('admin/staff', {
    headers: await csrfHeaders(admin),
    data: { email, role },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()).data as { id: string };
  const context = await playwright.request.newContext({ baseURL });
  const token = await latestLinkToken(context, email);
  expect(
    (
      await context.post('auth/password/reset', {
        data: { token, password: PASSWORD },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await context.post('auth/login', { data: { email, password: PASSWORD } })
    ).status(),
  ).toBe(200);
  return { id, email, context };
}

async function adminUserId(
  request: APIRequestContext,
  email: string,
): Promise<string> {
  const response = await request.get('admin/users', { params: { q: email } });
  const [user] = (await response.json()).data as { id: string }[];
  return user.id;
}

test.describe('PATCH /admin/users/:id/role', () => {
  test('a super administrator changes a staff role: audited, and every sign-in of the account ends', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await signIn(request, 'superAdmin');
    const staff = await staffMember(request, playwright, baseURL, 'OPS');
    expect((await staff.context.get('admin/users')).status()).toBe(200);

    const reason = 'Moved to the finance team.';
    const response = await request.patch(`admin/users/${staff.id}/role`, {
      headers: await csrfHeaders(request),
      data: { role: 'FINANCE_ADMIN', reason },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).data).toMatchObject({
      id: staff.id,
      role: 'FINANCE_ADMIN',
    });

    // The old sign-in is over, refresh token included.
    expect((await staff.context.get('me')).status()).toBe(401);
    expect(
      (
        await staff.context.post('auth/refresh', {
          headers: await csrfHeaders(staff.context),
        })
      ).status(),
    ).toBe(401);

    // Signing in again gives the new role and its access.
    const again = await staff.context.post('auth/login', {
      headers: await csrfHeaders(staff.context),
      data: { email: staff.email, password: PASSWORD },
    });
    expect((await again.json()).data.role).toBe('FINANCE_ADMIN');
    expect((await staff.context.get('admin/users')).status()).toBe(403);

    const audit = await request.get('admin/audit-logs', {
      params: {
        entityType: 'User',
        entityId: staff.id,
        action: 'user.role_change',
      },
    });
    expect((await audit.json()).data).toEqual([
      expect.objectContaining({
        before: { role: 'OPS' },
        after: { role: 'FINANCE_ADMIN' },
        reason,
      }),
    ]);
    await staff.context.dispose();
  });

  test('a super administrator can be demoted while another stays active', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await signIn(request, 'superAdmin');
    const staff = await staffMember(
      request,
      playwright,
      baseURL,
      'SUPER_ADMIN',
    );
    const response = await request.patch(`admin/users/${staff.id}/role`, {
      headers: await csrfHeaders(request),
      data: { role: 'OPS', reason: 'No longer administers accounts.' },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).data.role).toBe('OPS');
    await staff.context.dispose();
  });

  test('refuses your own account, non-staff accounts, an unchanged role, a missing reason and unknown users', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await signIn(request, 'superAdmin');
    const headers = await csrfHeaders(request);
    const change = (id: string, data: Record<string, unknown>) =>
      request.patch(`admin/users/${id}/role`, { headers, data });
    const reason = 'Checking the rules.';

    const self = await change(
      await adminUserId(request, ACCOUNTS.superAdmin.email),
      { role: 'OPS', reason },
    );
    expect(self.status()).toBe(409);
    expect((await self.json()).error.code).toBe('USER_INVALID_TRANSITION');

    const customer = await change(
      await adminUserId(request, ACCOUNTS.customer.email),
      { role: 'OPS', reason },
    );
    expect(customer.status()).toBe(409);
    expect((await customer.json()).error.code).toBe('USER_INVALID_TRANSITION');

    const staff = await staffMember(request, playwright, baseURL, 'OPS');
    const same = await change(staff.id, { role: 'OPS', reason });
    expect(same.status()).toBe(409);
    // A refused change leaves the sign-in alone.
    expect((await staff.context.get('me')).status()).toBe(200);

    for (const data of [
      { role: 'FINANCE_ADMIN' },
      { role: 'FINANCE_ADMIN', reason: 'x' },
      { role: 'CUSTOMER', reason },
      { role: 'OPERATOR_ADMIN', reason },
    ]) {
      const invalid = await change(staff.id, data);
      expect(invalid.status(), JSON.stringify(data)).toBe(400);
    }

    expect(
      (
        await change('00000000-0000-4000-8000-000000000000', {
          role: 'OPS',
          reason,
        })
      ).status(),
    ).toBe(404);
    await staff.context.dispose();
  });

  test('is for super administrators only', async ({ request }) => {
    const id = '00000000-0000-4000-8000-000000000000';
    const data = { role: 'OPS', reason: 'Not allowed.' };
    expect(
      (await request.patch(`admin/users/${id}/role`, { data })).status(),
    ).toBe(401);
    for (const account of ['ops', 'finance', 'operatorAdmin'] as const) {
      await signIn(request, account);
      const response = await request.patch(`admin/users/${id}/role`, {
        headers: await csrfHeaders(request),
        data,
      });
      expect(response.status(), account).toBe(403);
    }
  });
});

test.describe('GET /admin/roles', () => {
  test('gives the super administrator the enforced role matrix and staff capabilities', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const response = await request.get('admin/roles');
    expect(response.status()).toBe(200);
    const { roles, routes, capabilities } = (await response.json()).data;

    expect(roles.map((r: { role: string }) => r.role)).toEqual([
      'CUSTOMER',
      'OPERATOR_ADMIN',
      'OPERATOR_STAFF',
      'OPS',
      'FINANCE_ADMIN',
      'SUPER_ADMIN',
    ]);
    // The same metadata the guards enforce.
    expect(routes).toEqual(
      expect.arrayContaining([
        {
          method: 'PATCH',
          path: '/admin/users/:id/role',
          summary: "Change an internal account's role",
          public: false,
          roles: ['SUPER_ADMIN'],
        },
        expect.objectContaining({
          method: 'GET',
          path: '/admin/users',
          roles: ['OPS', 'SUPER_ADMIN'],
        }),
        expect.objectContaining({
          method: 'POST',
          path: '/auth/login',
          public: true,
          roles: [],
        }),
      ]),
    );
    expect(
      capabilities.map((c: { capability: string }) => c.capability),
    ).toEqual([
      'MANAGE_AIRCRAFT',
      'MANAGE_AVAILABILITY',
      'MANAGE_EMPTY_LEGS',
      'MANAGE_BOOKINGS',
    ]);
    for (const capability of capabilities) {
      expect(capability.description.length).toBeGreaterThan(10);
    }
  });

  test('is closed to every other role', async ({ request }) => {
    expect((await request.get('admin/roles')).status()).toBe(401);
    for (const account of [
      'ops',
      'finance',
      'operatorAdmin',
      'customer',
    ] as const) {
      await signIn(request, account);
      expect((await request.get('admin/roles')).status(), account).toBe(403);
    }
  });
});
