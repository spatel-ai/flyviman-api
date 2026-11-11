import { APIRequestContext, expect, test } from '@playwright/test';
import { ACCOUNTS } from './support/accounts.js';
import {
  latestCode,
  latestLinkToken,
  outbox,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
  uniquePhone,
  verify,
} from './support/data.js';
import { cookie, csrfHeaders, signIn } from './support/session.js';

/** Starts an email registration and returns its verification ID. */
async function startRegistration(
  request: APIRequestContext,
  email: string,
  overrides: object = {},
): Promise<string> {
  const response = await request.post('auth/register', {
    data: {
      firstName: 'Asha',
      lastName: 'Rao',
      email,
      password: PASSWORD,
      acceptTerms: true,
      ...overrides,
    },
  });
  expect(response.status()).toBe(202);
  return (await response.json()).data.verificationId;
}

/** A six-digit code that is not `code`. */
function wrongCode(code: string): string {
  return code === '000000' ? '000001' : '000000';
}

test.describe('POST /auth/register', () => {
  test('registers by email, and the account exists only after the code is verified', async ({
    request,
  }) => {
    const email = uniqueEmail();
    const response = await request.post('auth/register', {
      data: {
        firstName: 'Asha',
        lastName: 'Rao',
        email,
        password: PASSWORD,
        acceptTerms: true,
      },
    });
    expect(response.status()).toBe(202);
    const sent = (await response.json()).data;
    expect(sent).toEqual({
      verificationId: expect.stringMatching(/^[\w-]{20,}$/),
      channel: 'EMAIL',
      destination: `${email[0]}***@flyviman.test`,
      expiresInSeconds: 300,
    });

    // Not usable yet.
    const early = await request.post('auth/login', {
      data: { email, password: PASSWORD },
    });
    expect(early.status()).toBe(401);
    expect(await cookie(request, 'access_token')).toBeUndefined();

    const user = await verify(request, sent.verificationId, email);
    expect(user).toMatchObject({ email, role: 'CUSTOMER', status: 'ACTIVE' });

    const me = await (await request.get('me')).json();
    expect(me.data.profile).toMatchObject({
      firstName: 'Asha',
      lastName: 'Rao',
    });

    // A welcome was sent once the account was active.
    const subjects = (await outbox(request, email)).map((m) => m.subject);
    expect(subjects).toContain('Welcome to Flyviman');
  });

  test('registers by mobile number and signs in with the code', async ({
    request,
  }) => {
    const phone = uniquePhone();
    const response = await request.post('auth/register', {
      data: { firstName: 'Ravi', lastName: 'Menon', phone, acceptTerms: true },
    });
    expect(response.status()).toBe(202);
    const sent = (await response.json()).data;
    expect(sent.channel).toBe('SMS');

    const user = await verify(
      request,
      sent.verificationId,
      phone,
      'auth/otp/verify',
    );
    expect(user).toMatchObject({ phone, email: null, status: 'ACTIVE' });
  });

  test('answers the same for an address that is already registered, and sends nothing', async ({
    request,
  }) => {
    const { email } = ACCOUNTS.customer;
    const before = (await outbox(request, email)).length;
    const response = await request.post('auth/register', {
      data: {
        firstName: 'Someone',
        lastName: 'Else',
        email,
        password: PASSWORD,
        acceptTerms: true,
      },
    });
    expect(response.status()).toBe(202);
    const sent = (await response.json()).data;
    expect(sent).toMatchObject({
      channel: 'EMAIL',
      verificationId: expect.any(String),
    });
    expect((await outbox(request, email)).length).toBe(before);

    // Guessing at that attempt looks like any other wrong code.
    const guess = await request.post('auth/email/verify', {
      data: { verificationId: sent.verificationId, code: '123456' },
    });
    expect((await guess.json()).error.code).toBe('AUTH_OTP_INVALID');

    // The existing account's password is untouched.
    await signIn(request, 'customer');
  });

  test('someone else registering the same address cannot plant their password', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const email = uniqueEmail();
    // The owner starts registering, then an attacker registers the same
    // address with their own password before the owner has verified.
    const ownerAttempt = await startRegistration(request, email);
    const ownerCode = await latestCode(request, email);

    const attacker = await playwright.request.newContext({ baseURL });
    const attackerAttempt = await startRegistration(attacker, email, {
      firstName: 'Mallory',
      password: 'an attacker chose this',
    });
    const attackerCode = await latestCode(attacker, email);

    // The attacker's code (which only the owner's inbox received) does not
    // complete the owner's attempt, and the owner's does not complete theirs.
    if (attackerCode !== ownerCode) {
      const crossed = await request.post('auth/email/verify', {
        data: { verificationId: ownerAttempt, code: attackerCode },
      });
      expect((await crossed.json()).error.code).toBe('AUTH_OTP_INVALID');
    }

    const verified = await request.post('auth/email/verify', {
      data: { verificationId: ownerAttempt, code: ownerCode },
    });
    expect(verified.status()).toBe(200);
    expect(
      (await (await request.get('me')).json()).data.profile.firstName,
    ).toBe('Asha');

    // The account has the owner's password, not the attacker's.
    expect(
      (
        await attacker.post('auth/login', {
          data: { email, password: 'an attacker chose this' },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await attacker.post('auth/login', {
          data: { email, password: PASSWORD },
        })
      ).status(),
    ).toBe(200);

    // The attacker's attempt can no longer create anything, even with its code.
    const late = await playwright.request.newContext({ baseURL });
    const completed = await late.post('auth/email/verify', {
      data: { verificationId: attackerAttempt, code: attackerCode },
    });
    expect(completed.status()).toBe(400);
    expect((await completed.json()).error.code).toBe('AUTH_OTP_EXPIRED');
    await late.dispose();
    await attacker.dispose();
  });

  test.describe('validation', () => {
    const base = { firstName: 'Asha', lastName: 'Rao', acceptTerms: true };
    const cases: [string, object, string][] = [
      [
        'terms not accepted',
        {
          ...base,
          email: 'a@flyviman.test',
          password: PASSWORD,
          acceptTerms: false,
        },
        'acceptTerms',
      ],
      [
        'a short password',
        { ...base, email: 'a@flyviman.test', password: 'short' },
        'password',
      ],
      [
        'a common password',
        { ...base, email: 'a@flyviman.test', password: 'password1234' },
        'password',
      ],
      [
        'email without a password',
        { ...base, email: 'a@flyviman.test' },
        'password',
      ],
      [
        'a phone number that is not international',
        { ...base, phone: '9876543210' },
        'phone',
      ],
      [
        'both email and phone',
        {
          ...base,
          email: 'a@flyviman.test',
          password: PASSWORD,
          phone: '+919876543210',
        },
        'email',
      ],
      ['neither email nor phone', base, 'email'],
    ];
    for (const [name, data, field] of cases) {
      test(`rejects ${name}`, async ({ request }) => {
        const response = await request.post('auth/register', { data });
        expect(response.status()).toBe(400);
        const body = await response.json();
        expect(body.error.code).toBe('VALIDATION_ERROR');
        expect(
          body.error.details.map((d: { field: string }) => d.field),
        ).toContain(field);
      });
    }
  });
});

test.describe('one-time codes', () => {
  test('a wrong code is refused and the right one still works', async ({
    request,
  }) => {
    const email = uniqueEmail();
    const verificationId = await startRegistration(request, email);
    const code = await latestCode(request, email);

    const refused = await request.post('auth/email/verify', {
      data: { verificationId, code: wrongCode(code) },
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error.code).toBe('AUTH_OTP_INVALID');

    const accepted = await request.post('auth/email/verify', {
      data: { verificationId, code },
    });
    expect(accepted.status()).toBe(200);
  });

  test('a code works only once', async ({ request, playwright, baseURL }) => {
    const email = uniqueEmail();
    const verificationId = await startRegistration(request, email);
    const code = await latestCode(request, email);
    await request.post('auth/email/verify', { data: { verificationId, code } });

    const other = await playwright.request.newContext({ baseURL });
    const replay = await other.post('auth/email/verify', {
      data: { verificationId, code },
    });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error.code).toBe('AUTH_OTP_EXPIRED');
    await other.dispose();
  });

  test('the code alone, without the attempt it belongs to, is useless', async ({
    request,
  }) => {
    const email = uniqueEmail();
    await startRegistration(request, email);
    const response = await request.post('auth/email/verify', {
      data: {
        verificationId: 'x'.repeat(32),
        code: await latestCode(request, email),
      },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('AUTH_OTP_EXPIRED');
  });

  test('five wrong guesses destroy the code, even when made at once', async ({
    request,
  }) => {
    const email = uniqueEmail();
    const verificationId = await startRegistration(request, email);
    const code = await latestCode(request, email);

    const responses = await Promise.all(
      Array.from({ length: 8 }, () =>
        request.post('auth/email/verify', {
          data: { verificationId, code: wrongCode(code) },
        }),
      ),
    );
    const codes = await Promise.all(
      responses.map(async (r) => (await r.json()).error.code),
    );
    expect(
      codes.filter((c) => c === 'AUTH_OTP_INVALID').length,
    ).toBeLessThanOrEqual(4);
    expect(codes).toContain('AUTH_OTP_EXPIRED');

    const late = await request.post('auth/email/verify', {
      data: { verificationId, code },
    });
    expect((await late.json()).error.code).toBe('AUTH_OTP_EXPIRED');
  });

  test('a fresh code can be sent for an open attempt, replacing the old one', async ({
    request,
  }) => {
    const email = uniqueEmail();
    const verificationId = await startRegistration(request, email);
    const first = await latestCode(request, email);

    const resend = await request.post('auth/otp/request', {
      data: { verificationId },
    });
    expect(resend.status()).toBe(202);
    expect((await outbox(request, email)).length).toBe(2);
    const second = await latestCode(request, email);

    if (first !== second) {
      const old = await request.post('auth/email/verify', {
        data: { verificationId, code: first },
      });
      expect((await old.json()).error.code).toBe('AUTH_OTP_INVALID');
    }
    const fresh = await request.post('auth/email/verify', {
      data: { verificationId, code: second },
    });
    expect(fresh.status()).toBe(200);
  });

  test('asking for a fresh code on an attempt that has ended says so', async ({
    request,
  }) => {
    const email = uniqueEmail();
    const verificationId = await startRegistration(request, email);
    await verify(request, verificationId, email);

    const response = await request.post('auth/otp/request', {
      headers: await csrfHeaders(request),
      data: { verificationId },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('AUTH_OTP_EXPIRED');
  });

  test('requesting a code never reveals whether a number is registered', async ({
    request,
  }) => {
    const unknown = uniquePhone();
    const response = await request.post('auth/otp/request', {
      data: { phone: unknown },
    });
    expect(response.status()).toBe(202);
    const sent = (await response.json()).data;
    expect(sent).toMatchObject({
      channel: 'SMS',
      verificationId: expect.any(String),
    });
    expect(await outbox(request, unknown)).toEqual([]);

    // A wrong code gets the same answer it would for a registered number.
    const guess = await request.post('auth/otp/verify', {
      data: { verificationId: sent.verificationId, code: '123456' },
    });
    expect((await guess.json()).error.code).toBe('AUTH_OTP_INVALID');
  });

  test('a returning mobile customer signs in with a fresh code', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const phone = uniquePhone();
    const register = await request.post('auth/register', {
      data: { firstName: 'Ravi', lastName: 'Menon', phone, acceptTerms: true },
    });
    await verify(
      request,
      (await register.json()).data.verificationId,
      phone,
      'auth/otp/verify',
    );

    const later = await playwright.request.newContext({ baseURL });
    const start = await later.post('auth/otp/request', { data: { phone } });
    expect(start.status()).toBe(202);
    await verify(
      later,
      (await start.json()).data.verificationId,
      phone,
      'auth/otp/verify',
    );
    expect((await later.get('me')).status()).toBe(200);
    await later.dispose();
  });

  test('rejects a request with neither or both of phone and verificationId', async ({
    request,
  }) => {
    for (const data of [
      {},
      { phone: '+919876543210', verificationId: 'x'.repeat(32) },
    ]) {
      const response = await request.post('auth/otp/request', { data });
      expect(response.status()).toBe(400);
    }
  });
});

test.describe('staff accounts cannot be reached by one-time code', () => {
  test('no code is sent for an invited or active staff email or phone', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const email = uniqueEmail('staff');
    const created = await request.post('admin/staff', {
      headers: await csrfHeaders(request),
      data: { email, role: 'OPS' },
    });
    expect(created.status()).toBe(201);
    const invitations = (await outbox(request, email)).length;

    // The only way to start an email verification is a registration, and a
    // registration for an address that has an account sends nothing.
    const register = await request.post('auth/register', {
      headers: await csrfHeaders(request),
      data: {
        firstName: 'Not',
        lastName: 'Staff',
        email,
        password: PASSWORD,
        acceptTerms: true,
      },
    });
    expect(register.status()).toBe(202);
    expect((await outbox(request, email)).length).toBe(invitations);

    const guess = await request.post('auth/email/verify', {
      headers: await csrfHeaders(request),
      data: {
        verificationId: (await register.json()).data.verificationId,
        code: '000000',
      },
    });
    expect(guess.status()).toBe(400);
  });
});

test.describe('password reset', () => {
  test('a reset link sets a new password once and ends existing sessions', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { email } = await registerCustomer(request);
    expect((await request.get('me')).status()).toBe(200);

    const anonymous = await playwright.request.newContext({ baseURL });
    const forgot = await anonymous.post('auth/password/forgot', {
      data: { email },
    });
    expect(forgot.status()).toBe(202);
    const token = await latestLinkToken(anonymous, email);

    const newPassword = 'a brand new passphrase';
    const reset = await anonymous.post('auth/password/reset', {
      data: { token, password: newPassword },
    });
    expect(reset.status()).toBe(204);

    // The session that existed before the reset is over.
    expect((await request.get('me')).status()).toBe(401);

    expect(
      (
        await anonymous.post('auth/login', {
          data: { email, password: PASSWORD },
        })
      ).status(),
    ).toBe(401);
    expect(
      (
        await anonymous.post('auth/login', {
          data: { email, password: newPassword },
        })
      ).status(),
    ).toBe(200);

    // The link cannot be used again.
    const again = await playwright.request.newContext({ baseURL });
    const replay = await again.post('auth/password/reset', {
      data: { token, password: 'yet another passphrase' },
    });
    expect(replay.status()).toBe(400);
    expect((await replay.json()).error.code).toBe('AUTH_TOKEN_INVALID');
    await again.dispose();
    await anonymous.dispose();
  });

  test('answers 202 for an unknown email and sends nothing', async ({
    request,
  }) => {
    const email = uniqueEmail('nobody');
    const response = await request.post('auth/password/forgot', {
      data: { email },
    });
    expect(response.status()).toBe(202);
    expect(await outbox(request, email)).toEqual([]);
  });

  test('rejects a made-up token and a weak new password', async ({
    request,
  }) => {
    const forged = await request.post('auth/password/reset', {
      data: { token: 'x'.repeat(43), password: PASSWORD },
    });
    expect(forged.status()).toBe(400);
    expect((await forged.json()).error.code).toBe('AUTH_TOKEN_INVALID');

    const weak = await request.post('auth/password/reset', {
      data: { token: 'x'.repeat(43), password: 'short' },
    });
    expect(weak.status()).toBe(400);
    expect((await weak.json()).error.code).toBe('VALIDATION_ERROR');
  });
});

test.describe('cross-site requests', () => {
  test('a sign-in posted from another site is refused', async ({ request }) => {
    const { email, password } = ACCOUNTS.customer;
    const response = await request.post('auth/login', {
      headers: { Origin: 'https://evil.example' },
      data: { email, password },
    });
    expect(response.status()).toBe(403);
    expect((await response.json()).error.code).toBe('CSRF_TOKEN_INVALID');
    expect(await cookie(request, 'access_token')).toBeUndefined();
  });

  test('a sign-in from the web origin is accepted', async ({ request }) => {
    const { email, password } = ACCOUNTS.customer;
    const response = await request.post('auth/login', {
      headers: { Origin: 'http://localhost:3000' },
      data: { email, password },
    });
    expect(response.status()).toBe(200);
  });
});

test('ten failed sign-ins lock the email for a while, without saying whether it exists', async ({
  request,
}) => {
  const email = uniqueEmail('locked');
  const statuses: number[] = [];
  for (let attempt = 0; attempt < 11; attempt += 1) {
    const response = await request.post('auth/login', {
      data: { email, password: 'wrong-password' },
    });
    statuses.push(response.status());
  }
  expect(statuses.slice(0, 10)).toEqual(Array(10).fill(401));
  expect(statuses[10]).toBe(429);
});

test('a password reset lifts the sign-in lock', async ({
  request,
  playwright,
  baseURL,
}) => {
  const { email } = await registerCustomer(request);
  const stranger = await playwright.request.newContext({ baseURL });
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await stranger.post('auth/login', {
      data: { email, password: 'wrong-password' },
    });
  }
  expect(
    (
      await stranger.post('auth/login', { data: { email, password: PASSWORD } })
    ).status(),
  ).toBe(429);

  // Recovery is not blocked by the lock, and completing it removes the lock.
  expect(
    (await stranger.post('auth/password/forgot', { data: { email } })).status(),
  ).toBe(202);
  const token = await latestLinkToken(stranger, email);
  const newPassword = 'a brand new passphrase';
  expect(
    (
      await stranger.post('auth/password/reset', {
        data: { token, password: newPassword },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await stranger.post('auth/login', {
        data: { email, password: newPassword },
      })
    ).status(),
  ).toBe(200);
  await stranger.dispose();
});

test('wrong guesses at an attempt that sent no code do not count against the address', async ({
  request,
}) => {
  // "Registering" an address that already has an account sends nothing.
  // Guessing at those attempts must not stop the real owner getting codes.
  const { email } = await registerCustomer(request);
  const headers = await csrfHeaders(request);
  for (let round = 0; round < 5; round += 1) {
    const start = await request.post('auth/register', {
      headers,
      data: {
        firstName: 'X',
        lastName: 'Y',
        email,
        password: PASSWORD,
        acceptTerms: true,
      },
    });
    const { verificationId } = (await start.json()).data;
    for (let guess = 0; guess < 5; guess += 1) {
      await request.post('auth/otp/verify', {
        headers,
        data: { verificationId, code: '000000' },
      });
    }
  }
  const forgot = await request.post('auth/password/forgot', {
    headers,
    data: { email },
  });
  expect(forgot.status()).toBe(202);
  expect(
    (await outbox(request, email)).some(
      (m) => m.subject === 'Reset your Flyviman password',
    ),
  ).toBe(true);
});

test('the development outbox answers on this test server (ENABLE_DEV_TOOLS is on)', async ({
  request,
}) => {
  expect(
    (
      await request.get('dev/outbox', { params: { to: 'x@flyviman.test' } })
    ).status(),
  ).toBe(200);
});

test('GET /content/policies/:slug serves the published terms', async ({
  request,
}) => {
  const response = await request.get('content/policies/terms');
  expect(response.status()).toBe(200);
  const body = await response.json();
  expect(body.data).toMatchObject({ slug: 'terms', title: 'Terms of use' });
  expect(body.data.version).toBeTruthy();

  const missing = await request.get('content/policies/nope');
  expect(missing.status()).toBe(404);
  expect((await missing.json()).error.code).toBe('NOT_FOUND');
});
