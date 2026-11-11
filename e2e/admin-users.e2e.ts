import { expect, test } from '@playwright/test';
import { ACCOUNTS } from './support/accounts.js';
import {
  latestLinkToken,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
} from './support/data.js';
import { csrfHeaders, signIn } from './support/session.js';

test.describe('GET /admin/users', () => {
  test('operations staff search users and never receive a password hash', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const response = await request.get('admin/users', {
      params: { q: ACCOUNTS.customer.email, role: 'CUSTOMER' },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual([
      expect.objectContaining({
        email: ACCOUNTS.customer.email,
        role: 'CUSTOMER',
        status: 'ACTIVE',
      }),
    ]);
    expect(JSON.stringify(body)).not.toMatch(/passwordHash|argon2/);

    const detail = await request.get(`admin/users/${body.data[0].id}`);
    expect(detail.status()).toBe(200);
    expect((await detail.json()).data.email).toBe(ACCOUNTS.customer.email);
  });

  test('is closed to customers, operators and finance', async ({ request }) => {
    expect((await request.get('admin/users')).status()).toBe(401);
    for (const account of ['customer', 'operatorAdmin'] as const) {
      await signIn(request, account);
      expect((await request.get('admin/users')).status()).toBe(403);
    }
  });

  test('answers 404 for an unknown user', async ({ request }) => {
    await signIn(request, 'ops');
    const response = await request.get(
      'admin/users/00000000-0000-4000-8000-000000000000',
    );
    expect(response.status()).toBe(404);
  });
});

test.describe('PATCH /admin/users/:id/status', () => {
  test('a super administrator suspends a user, who is refused at once, then reinstates them', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const customer = await playwright.request.newContext({ baseURL });
    const { id } = await registerCustomer(customer);
    expect((await customer.get('me')).status()).toBe(200);

    await signIn(request, 'superAdmin');
    const headers = await csrfHeaders(request);

    const suspend = await request.patch(`admin/users/${id}/status`, {
      headers,
      data: {
        status: 'SUSPENDED',
        reason: 'Chargeback fraud under investigation.',
      },
    });
    expect(suspend.status()).toBe(200);
    expect((await suspend.json()).data.status).toBe('SUSPENDED');

    // The existing session stops working immediately.
    expect((await customer.get('me')).status()).toBe(401);

    const audit = await request.get('admin/audit-logs', {
      params: { entityType: 'User', entityId: id, action: 'user.suspend' },
    });
    expect((await audit.json()).data[0]).toMatchObject({
      actorRole: 'SUPER_ADMIN',
      before: { status: 'ACTIVE' },
      after: { status: 'SUSPENDED' },
      reason: 'Chargeback fraud under investigation.',
    });

    const twice = await request.patch(`admin/users/${id}/status`, {
      headers,
      data: { status: 'SUSPENDED', reason: 'Again.' },
    });
    expect(twice.status()).toBe(409);
    expect((await twice.json()).error.code).toBe('USER_INVALID_TRANSITION');

    const reinstate = await request.patch(`admin/users/${id}/status`, {
      headers,
      data: { status: 'ACTIVE', reason: 'Investigation closed.' },
    });
    expect((await reinstate.json()).data.status).toBe('ACTIVE');
    await customer.dispose();
  });

  test('needs a reason and an allowed status', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const customer = await playwright.request.newContext({ baseURL });
    const { id } = await registerCustomer(customer);
    await customer.dispose();

    await signIn(request, 'superAdmin');
    const headers = await csrfHeaders(request);
    for (const data of [
      { status: 'SUSPENDED' },
      { status: 'PENDING_VERIFICATION', reason: 'Because.' },
    ]) {
      const response = await request.patch(`admin/users/${id}/status`, {
        headers,
        data,
      });
      expect(response.status()).toBe(400);
    }
  });

  test('a super administrator cannot suspend themselves', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const me = (await (await request.get('me')).json()).data;
    const response = await request.patch(`admin/users/${me.id}/status`, {
      headers: await csrfHeaders(request),
      data: { status: 'SUSPENDED', reason: 'Testing.' },
    });
    expect(response.status()).toBe(409);
  });

  test('operations staff can read users but not change their status', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const list = await (
      await request.get('admin/users', {
        params: { q: ACCOUNTS.customer.email },
      })
    ).json();
    const response = await request.patch(
      `admin/users/${list.data[0].id}/status`,
      {
        headers: await csrfHeaders(request),
        data: { status: 'SUSPENDED', reason: 'Not allowed.' },
      },
    );
    expect(response.status()).toBe(403);
  });
});

test.describe('POST /admin/staff', () => {
  test('creates an internal account that is active once the invitation is accepted', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await signIn(request, 'superAdmin');
    const email = uniqueEmail('staff');
    const created = await request.post('admin/staff', {
      headers: await csrfHeaders(request),
      data: { email, role: 'FINANCE_ADMIN' },
    });
    expect(created.status()).toBe(201);
    expect((await created.json()).data).toMatchObject({
      email,
      role: 'FINANCE_ADMIN',
      status: 'PENDING_VERIFICATION',
    });

    const invitee = await playwright.request.newContext({ baseURL });
    const token = await latestLinkToken(invitee, email);
    const accept = await invitee.post('auth/password/reset', {
      data: { token, password: PASSWORD },
    });
    expect(accept.status()).toBe(204);

    const login = await invitee.post('auth/login', {
      data: { email, password: PASSWORD },
    });
    expect(login.status()).toBe(200);
    expect((await login.json()).data).toMatchObject({
      role: 'FINANCE_ADMIN',
      status: 'ACTIVE',
    });
    // Finance can read operators but not users.
    expect((await invitee.get('admin/operators')).status()).toBe(200);
    expect((await invitee.get('admin/users')).status()).toBe(403);
    await invitee.dispose();
  });

  test('a second invitation replaces a lost one and applies the new role', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await signIn(request, 'superAdmin');
    const headers = await csrfHeaders(request);
    const email = uniqueEmail('staff');
    await request.post('admin/staff', {
      headers,
      data: { email, role: 'OPS' },
    });

    const again = await request.post('admin/staff', {
      headers,
      data: { email, role: 'FINANCE_ADMIN' },
    });
    expect(again.status()).toBe(201);
    expect((await again.json()).data).toMatchObject({
      role: 'FINANCE_ADMIN',
      status: 'PENDING_VERIFICATION',
    });

    const invitee = await playwright.request.newContext({ baseURL });
    const token = await latestLinkToken(invitee, email);
    expect(
      (
        await invitee.post('auth/password/reset', {
          data: { token, password: PASSWORD },
        })
      ).status(),
    ).toBe(204);
    const login = await invitee.post('auth/login', {
      data: { email, password: PASSWORD },
    });
    expect((await login.json()).data.role).toBe('FINANCE_ADMIN');

    // Once accepted, the email is simply in use.
    const late = await request.post('admin/staff', {
      headers,
      data: { email, role: 'OPS' },
    });
    expect(late.status()).toBe(409);
    await invitee.dispose();
  });

  test('refuses an email that is already in use and a role that is not internal', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const headers = await csrfHeaders(request);

    const duplicate = await request.post('admin/staff', {
      headers,
      data: { email: ACCOUNTS.ops.email, role: 'OPS' },
    });
    expect(duplicate.status()).toBe(409);
    expect((await duplicate.json()).error.code).toBe('USER_ALREADY_EXISTS');

    const customerRole = await request.post('admin/staff', {
      headers,
      data: { email: uniqueEmail(), role: 'CUSTOMER' },
    });
    expect(customerRole.status()).toBe(400);
  });

  test('is for super administrators only', async ({ request }) => {
    await signIn(request, 'ops');
    const response = await request.post('admin/staff', {
      headers: await csrfHeaders(request),
      data: { email: uniqueEmail(), role: 'OPS' },
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('FORBIDDEN');
  });
});
