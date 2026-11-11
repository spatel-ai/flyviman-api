import { expect, test } from '@playwright/test';
import { uniqueEmail } from './support/data.js';
import { ACCOUNTS } from './support/accounts.js';
import { cookie, csrfHeaders, signIn } from './support/session.js';

test.describe('POST /auth/login', () => {
  test('signs in and sets the three session cookies', async ({ request }) => {
    const { email, password } = ACCOUNTS.superAdmin;
    const response = await request.post('auth/login', {
      data: { email, password },
    });

    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data).toEqual({
      id: expect.any(String),
      email,
      phone: null,
      role: 'SUPER_ADMIN',
      status: 'ACTIVE',
    });

    const { cookies } = await request.storageState();
    const byName = Object.fromEntries(cookies.map((c) => [c.name, c]));
    expect(byName.access_token).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
    });
    expect(byName.refresh_token).toMatchObject({
      httpOnly: true,
      sameSite: 'Lax',
    });
    // Readable on purpose: the web client copies it into X-CSRF-Token.
    expect(byName.csrf_token).toMatchObject({
      httpOnly: false,
      sameSite: 'Lax',
    });
  });

  test('accepts the email in any letter case', async ({ request }) => {
    const { email, password } = ACCOUNTS.customer;
    const response = await request.post('auth/login', {
      data: { email: email.toUpperCase(), password },
    });
    expect(response.status()).toBe(200);
  });

  test('gives the same answer for a wrong password and an unknown email', async ({
    request,
  }) => {
    const wrongPassword = await request.post('auth/login', {
      data: { email: ACCOUNTS.customer.email, password: 'not-the-password' },
    });
    const unknownEmail = await request.post('auth/login', {
      data: { email: uniqueEmail('nobody'), password: 'not-the-password' },
    });

    for (const response of [wrongPassword, unknownEmail]) {
      expect(response.status()).toBe(401);
      expect((await response.json()).error.code).toBe(
        'AUTH_INVALID_CREDENTIALS',
      );
    }
    expect((await wrongPassword.json()).error.message).toBe(
      (await unknownEmail.json()).error.message,
    );
    expect(await cookie(request, 'access_token')).toBeUndefined();
  });

  test('refuses a suspended account', async ({ request }) => {
    const { email, password } = ACCOUNTS.suspended;
    const response = await request.post('auth/login', {
      data: { email, password },
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('AUTH_ACCOUNT_SUSPENDED');
  });

  test('rejects a malformed request', async ({ request }) => {
    const response = await request.post('auth/login', {
      data: { email: 'not-an-email' },
    });
    expect(response.status()).toBe(400);
    const body = await response.json();
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.details.map((d: { field: string }) => d.field)).toEqual(
      expect.arrayContaining(['email', 'password']),
    );
  });

  test('writes an audit record for the sign-in', async ({ request }) => {
    await signIn(request, 'superAdmin');
    const me = await (await request.get('me')).json();

    const response = await request.get('admin/audit-logs', {
      params: { action: 'auth.login', actorId: me.data.id, pageSize: 1 },
    });
    const body = await response.json();
    expect(body.data[0]).toMatchObject({
      action: 'auth.login',
      actorId: me.data.id,
      actorRole: 'SUPER_ADMIN',
      entityType: 'User',
      entityId: me.data.id,
    });
    expect(body.data[0].requestId).toBeTruthy();
  });
});

test.describe('GET /me', () => {
  test('refuses a caller who is not signed in', async ({ request }) => {
    const response = await request.get('me');
    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
  });

  test('refuses a forged access token', async ({ playwright, baseURL }) => {
    const forged = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: { Cookie: 'access_token=eyJhbGciOiJub25lIn0.e30.' },
    });
    const response = await forged.get('me');
    expect(response.status()).toBe(401);
    await forged.dispose();
  });

  test('returns the signed-in user without any secret', async ({ request }) => {
    await signIn(request, 'customer');
    const response = await request.get('me');
    expect(response.status()).toBe(200);
    const body = await response.json();
    expect(body.data).toMatchObject({
      email: ACCOUNTS.customer.email,
      role: 'CUSTOMER',
    });
    expect(JSON.stringify(body)).not.toContain('passwordHash');
  });
});

test.describe('CSRF protection', () => {
  test('refuses a state-changing request without the CSRF header', async ({
    request,
  }) => {
    await signIn(request, 'customer');
    const response = await request.post('auth/logout');
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('CSRF_TOKEN_INVALID');
    // The session is untouched.
    expect((await request.get('me')).status()).toBe(200);
  });

  test('refuses a CSRF header that does not match the cookie', async ({
    request,
  }) => {
    await signIn(request, 'customer');
    const response = await request.post('auth/logout', {
      headers: { 'X-CSRF-Token': 'guessed' },
    });
    expect(response.status()).toBe(403);
  });
});

test.describe('POST /auth/logout', () => {
  test('ends the session and clears the cookies', async ({ request }) => {
    await signIn(request, 'customer');
    const accessToken = await cookie(request, 'access_token');

    const response = await request.post('auth/logout', {
      headers: await csrfHeaders(request),
    });
    expect(response.status()).toBe(204);
    expect(await cookie(request, 'access_token')).toBeUndefined();
    expect(await cookie(request, 'refresh_token')).toBeUndefined();

    // The old access token no longer works even though it has not expired.
    const replay = await request.get('me', {
      headers: { Cookie: `access_token=${accessToken}` },
    });
    expect(replay.status()).toBe(401);
  });

  test('works after the access token has expired, using the refresh cookie', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await signIn(request, 'customer');
    const refresh = await cookie(request, 'refresh_token');
    const csrf = (await cookie(request, 'csrf_token')) ?? '';

    // What a browser sends once the 15-minute access cookie is gone.
    const idle = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        Cookie: `refresh_token=${refresh}; csrf_token=${csrf}`,
        'X-CSRF-Token': csrf,
      },
    });
    expect((await idle.post('auth/logout')).status()).toBe(204);

    // The sign-in is over: the refresh token can no longer be exchanged.
    expect((await idle.post('auth/refresh')).status()).toBe(401);
    expect((await request.get('me')).status()).toBe(401);
    await idle.dispose();
  });

  test('answers 204 for a caller who is not signed in', async ({ request }) => {
    const response = await request.post('auth/logout');
    expect(response.status()).toBe(204);
  });
});

test.describe('POST /auth/refresh', () => {
  test('replaces the tokens and keeps the user signed in', async ({
    request,
  }) => {
    await signIn(request, 'customer');
    const before = await cookie(request, 'refresh_token');

    const response = await request.post('auth/refresh', {
      headers: await csrfHeaders(request),
    });
    expect(response.status()).toBe(204);
    expect(await cookie(request, 'refresh_token')).not.toBe(before);
    expect((await request.get('me')).status()).toBe(200);
  });

  test('refuses a caller with no refresh cookie', async ({ request }) => {
    const response = await request.post('auth/refresh');
    expect(response.status()).toBe(401);
    expect((await response.json()).error.code).toBe('UNAUTHENTICATED');
  });

  test('ends the whole sign-in when a used refresh token is presented again', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await signIn(request, 'customer');
    const used = await cookie(request, 'refresh_token');
    const csrf = await cookie(request, 'csrf_token');
    await request.post('auth/refresh', { headers: await csrfHeaders(request) });
    expect((await request.get('me')).status()).toBe(200);

    // Someone replays the token that was already exchanged.
    const thief = await playwright.request.newContext({
      baseURL,
      extraHTTPHeaders: {
        Cookie: `refresh_token=${used}; csrf_token=${csrf}`,
        'X-CSRF-Token': csrf ?? '',
      },
    });
    const replay = await thief.post('auth/refresh');
    expect(replay.status()).toBe(401);
    await thief.dispose();

    // The legitimate holder is signed out too.
    expect((await request.get('me')).status()).toBe(401);
  });
});
