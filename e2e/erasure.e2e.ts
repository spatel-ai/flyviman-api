import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { ACCOUNTS } from './support/accounts.js';
import {
  latestCode,
  PASSWORD,
  registerCustomer,
  registerOperator,
  uniqueEmail,
  uniquePhone,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Erasing an account (W5-8b, D-201, D-202, D-207): who may, what is refused,
 * what is gone and what the record keeps.
 */

type Contexts = Parameters<typeof listedJet>[0];

const FIRST_NAME = 'Zorbaq';
const PASSENGER = {
  firstName: 'Quillon',
  lastName: 'Fenwhistle',
  dateOfBirth: '1990-04-12',
  gender: 'FEMALE',
  nationality: 'IN',
  documentType: 'PASSPORT',
  documentNumber: 'P7654321',
  documentExpiry: '2031-01-31',
};

async function post(context: APIRequestContext, path: string, data?: unknown) {
  return context.post(path, {
    headers: await csrfHeaders(context),
    ...(data === undefined ? {} : { data }),
  });
}

async function fresh(contexts: Contexts) {
  return contexts.playwright.request.newContext({ baseURL: contexts.baseURL });
}

async function signedIn(contexts: Contexts, account: keyof typeof ACCOUNTS) {
  const context = await fresh(contexts);
  await signIn(context, account);
  return context;
}

async function userId(email: string): Promise<string> {
  return withPrisma(
    async (prisma) =>
      (await prisma.user.findUniqueOrThrow({ where: { email } })).id,
  );
}

/** A customer with a saved passenger and a booking request on a priced jet. */
async function customerWithBooking(contexts: Contexts) {
  const { request } = contexts;
  const trip = await listedJet(contexts);
  const priced = await request.put(
    `operator/aircraft/${trip.aircraftId}/pricing`,
    {
      headers: await csrfHeaders(request),
      data: {
        hourlyRateMinor: 18_000_000,
        taxInclusive: false,
        commissionInclusive: false,
        minBillableHours: null,
      },
    },
  );
  expect(priced.status()).toBe(200);
  const searched = await searchFor(request, trip);
  const customer = await fresh(contexts);
  const { email, id } = await registerCustomer(customer, {
    firstName: FIRST_NAME,
  });
  const saved = await post(customer, 'me/passengers', PASSENGER);
  expect(saved.status()).toBe(201);
  const created = await customer.post('bookings', {
    headers: {
      ...(await csrfHeaders(customer)),
      'Idempotency-Key': randomUUID(),
    },
    data: {
      searchId: searched.searchId,
      resultId: searched.result.resultId,
      cancellationTermsVersion: searched.termsVersion,
      expectedTotalMinor: searched.result.price.amountMinor,
      currency: 'INR',
      passengerIds: [(await saved.json()).data.id],
    },
  });
  expect(created.status()).toBe(201);
  const booking = (await created.json()).data;
  return {
    customer,
    email,
    id,
    reference: booking.reference as string,
    price: booking.price as { amountMinor: number; currency: string },
  };
}

async function cancelBooking(customer: APIRequestContext, reference: string) {
  const quote = await customer.get(`bookings/${reference}/cancellation-quote`);
  expect(quote.status()).toBe(200);
  const response = await customer.post(`bookings/${reference}/cancel`, {
    headers: {
      ...(await csrfHeaders(customer)),
      'Idempotency-Key': randomUUID(),
    },
    data: {
      expectedChargeMinor: (await quote.json()).data.chargeMinor,
      currency: 'INR',
    },
  });
  expect(response.status()).toBe(200);
}

test.describe('POST /me/erasure', () => {
  test('is refused while a booking is open, and the refusal uses up neither password nor code', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, email, reference } = await customerWithBooking(contexts);

    const blocked = await post(customer, 'me/erasure', { password: PASSWORD });
    expect(blocked.status()).toBe(409);
    const error = (await blocked.json()).error;
    expect(error.code).toBe('USER_ERASURE_BLOCKED');
    expect(error.details).toContainEqual({
      field: 'reason',
      issue: 'OPEN_BOOKINGS',
    });

    // The code is checked after the blockers: a refused request keeps it.
    const sent = await post(customer, 'me/erasure/code');
    expect(sent.status()).toBe(202);
    const { verificationId } = (await sent.json()).data;
    const code = await latestCode(request, email);
    const refused = await post(customer, 'me/erasure', {
      verificationId,
      code,
    });
    expect(refused.status()).toBe(409);

    // Still signed in, still the owner; once the booking is closed the same
    // code erases the account.
    expect((await customer.get('me')).status()).toBe(200);
    await cancelBooking(customer, reference);
    const erased = await post(customer, 'me/erasure', { verificationId, code });
    expect(erased.status()).toBe(204);
  });

  test('a wrong password is 401 and counts as a failed sign-in', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const customer = await fresh(contexts);
    const { email } = await registerCustomer(customer);

    const wrong = await post(customer, 'me/erasure', { password: 'nope-nope' });
    expect(wrong.status()).toBe(401);
    expect((await wrong.json()).error.code).toBe('AUTH_INVALID_CREDENTIALS');
    expect((await customer.get('me')).status()).toBe(200);

    // Ten failures from one address lock the email: the eleventh attempt,
    // with the right password, is refused as too many.
    for (let attempt = 1; attempt < 10; attempt += 1) {
      expect(
        (
          await post(customer, 'me/erasure', { password: 'nope-nope' })
        ).status(),
      ).toBe(401);
    }
    const locked = await post(customer, 'me/erasure', { password: PASSWORD });
    expect(locked.status()).toBe(429);
    expect((await locked.json()).error.code).toBe('RATE_LIMITED');
    const signInLocked = await customer.post('auth/login', {
      headers: await csrfHeaders(customer),
      data: { email, password: PASSWORD },
    });
    expect(signInLocked.status()).toBe(429);
  });

  test('needs exactly one proof, and a customer account', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const customer = await fresh(contexts);
    await registerCustomer(customer);
    expect((await post(customer, 'me/erasure', {})).status()).toBe(400);
    expect(
      (
        await post(customer, 'me/erasure', {
          password: PASSWORD,
          verificationId: 'x',
          code: '123456',
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await post(await fresh(contexts), 'me/erasure', { password: PASSWORD })
      ).status(),
    ).toBe(401);
    for (const account of ['ops', 'finance', 'superAdmin'] as const) {
      const staff = await signedIn(contexts, account);
      expect(
        (
          await post(staff, 'me/erasure', {
            password: ACCOUNTS[account].password,
          })
        ).status(),
        account,
      ).toBe(403);
      expect((await post(staff, 'me/erasure/code')).status(), account).toBe(
        403,
      );
    }
    const operator = await fresh(contexts);
    await registerOperator(operator);
    expect(
      (await post(operator, 'me/erasure', { password: PASSWORD })).status(),
    ).toBe(403);
  });

  test('erases a customer who has only a cancelled booking: the session ends, the email is free, the record stays without names', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, email, id, reference, price } =
      await customerWithBooking(contexts);
    await cancelBooking(customer, reference);
    expect((await customer.get('me/passengers')).status()).toBe(200);

    const erased = await post(customer, 'me/erasure', { password: PASSWORD });
    expect(erased.status()).toBe(204);

    // The same cookie is refused at once, reads and writes alike.
    expect((await customer.get('me')).status()).toBe(401);
    expect((await post(customer, 'me/passengers', PASSENGER)).status()).toBe(
      401,
    );
    expect(
      (
        await customer.post('bookings', {
          headers: {
            ...(await csrfHeaders(customer)),
            'Idempotency-Key': randomUUID(),
          },
          data: {},
        })
      ).status(),
    ).toBe(401);

    // Signing in fails, and the same email registers again as a new person.
    const again = await playwright.request.newContext({ baseURL });
    const login = await again.post('auth/login', {
      data: { email, password: PASSWORD },
    });
    expect(login.status()).toBe(401);
    const second = await registerCustomer(again, { email });
    expect(second.id).not.toBe(id);

    // The booking stays for staff, with its amount, and no passenger names.
    const ops = await signedIn(contexts, 'ops');
    const shown = await ops.get(`admin/bookings/${reference}`);
    expect(shown.status()).toBe(200);
    const booking = (await shown.json()).data;
    expect(booking).toMatchObject({
      reference,
      status: 'CANCELLED',
      price: { amountMinor: price.amountMinor, currency: 'INR' },
    });
    expect(booking.passengers).toHaveLength(1);
    expect(booking.passengers[0]).toMatchObject({
      firstName: '[erased]',
      lastName: '',
    });
    expect(JSON.stringify(booking)).not.toContain(PASSENGER.lastName);

    const stored = await withPrisma(async (prisma) => ({
      user: await prisma.user.findUniqueOrThrow({ where: { id } }),
      passengers: await prisma.passenger.count({ where: { customerId: id } }),
      profiles: await prisma.customerProfile.count({ where: { userId: id } }),
      sessions: await prisma.session.count({ where: { userId: id } }),
      audit: await prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.erase', entityId: id },
      }),
    }));
    expect(stored.user).toMatchObject({
      status: 'ERASED',
      email: null,
      phone: null,
      passwordHash: null,
    });
    expect(stored.user.erasedAt).not.toBeNull();
    expect(stored.passengers).toBe(0);
    expect(stored.profiles).toBe(0);
    expect(stored.sessions).toBe(0);

    // Counts only: nothing that was erased is copied into the audit log.
    const audit = JSON.stringify(stored.audit);
    for (const personal of [
      email,
      email.split('@')[0],
      FIRST_NAME,
      'Rao',
      PASSENGER.firstName,
      PASSENGER.lastName,
      PASSENGER.documentNumber,
    ]) {
      expect(audit).not.toContain(personal);
    }
    expect(stored.audit.after).toMatchObject({
      status: 'ERASED',
      bookings: 1,
      savedPassengers: 1,
    });
  });

  test('a code bound to erasure signs nobody in, and a sign-in code erases nobody', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const customer = await fresh(contexts);
    const { id } = await registerCustomer(customer);
    const phone = uniquePhone();
    await withPrisma((prisma) =>
      prisma.user.update({
        where: { id },
        data: { phone, phoneVerifiedAt: new Date() },
      }),
    );
    const visitor = await fresh(contexts);

    // A sign-in code is refused by erasure, whatever its digits.
    const signIn = await visitor.post('auth/otp/request', { data: { phone } });
    expect(signIn.status()).toBe(202);
    const signInCode = await latestCode(request, phone);
    const refused = await post(customer, 'me/erasure', {
      verificationId: (await signIn.json()).data.verificationId,
      code: signInCode,
    });
    expect(refused.status()).toBe(400);
    expect((await refused.json()).error.code).toBe('AUTH_OTP_EXPIRED');
    expect((await customer.get('me')).status()).toBe(200);

    // The erasure code goes to the phone and is refused by both sign-in routes.
    const sent = await post(customer, 'me/erasure/code');
    expect(sent.status()).toBe(202);
    const { verificationId } = (await sent.json()).data;
    const code = await latestCode(request, phone);
    for (const route of ['auth/otp/verify', 'auth/email/verify']) {
      const response = await visitor.post(route, {
        data: { verificationId, code },
      });
      expect(response.status(), route).toBe(400);
      expect((await response.json()).error.code).toBe('AUTH_OTP_EXPIRED');
    }

    // Left unused by those refusals, it works for erasure, once.
    const erased = await post(customer, 'me/erasure', { verificationId, code });
    expect(erased.status()).toBe(204);
    const replay = await post(customer, 'me/erasure', { verificationId, code });
    expect(replay.status()).toBe(401);
  });

  test('resets the notification opt-outs', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const customer = await fresh(contexts);
    const { id } = await registerCustomer(customer);
    const set = await customer.patch('me/notification-preferences', {
      headers: await csrfHeaders(customer),
      data: { smsOptedOut: true, whatsappOptedOut: true },
    });
    expect(set.status()).toBe(200);
    expect(
      (await post(customer, 'me/erasure', { password: PASSWORD })).status(),
    ).toBe(204);
    const user = await withPrisma((prisma) =>
      prisma.user.findUniqueOrThrow({ where: { id } }),
    );
    expect(user).toMatchObject({ smsOptedOut: false, whatsappOptedOut: false });
  });
});

test.describe('POST /admin/users/:id/erase', () => {
  test('a super administrator erases a customer, with a reason, once', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const customer = await fresh(contexts);
    const { id, email } = await registerCustomer(customer);
    const admin = await signedIn(contexts, 'superAdmin');

    expect((await post(admin, `admin/users/${id}/erase`, {})).status()).toBe(
      400,
    );
    expect(
      (await post(admin, `admin/users/${id}/erase`, { reason: ' ' })).status(),
    ).toBe(400);

    const erased = await post(admin, `admin/users/${id}/erase`, {
      reason: 'Request received by email',
    });
    expect(erased.status()).toBe(200);
    expect((await erased.json()).data).toMatchObject({
      id,
      status: 'ERASED',
    });
    expect((await customer.get('me')).status()).toBe(401);

    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: { action: 'user.erase', entityId: id },
      }),
    );
    expect(audit.reason).toBe('Request received by email');
    expect(JSON.stringify(audit)).not.toContain(email);

    const again = await post(admin, `admin/users/${id}/erase`, {
      reason: 'Request received by email',
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('USER_INVALID_TRANSITION');
  });

  test('refuses a customer with an open booking', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id } = await customerWithBooking(contexts);
    const admin = await signedIn(contexts, 'superAdmin');
    const blocked = await post(admin, `admin/users/${id}/erase`, {
      reason: 'Request received by letter',
    });
    expect(blocked.status()).toBe(409);
    expect((await blocked.json()).error.code).toBe('USER_ERASURE_BLOCKED');
  });

  test('staff and operator accounts answer 409; operations and finance may not call it', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const admin = await signedIn(contexts, 'superAdmin');
    const operator = await fresh(contexts);
    const { email: operatorEmail } = await registerOperator(operator);
    const targets = [
      await userId(ACCOUNTS.ops.email),
      await userId(operatorEmail),
    ];
    for (const id of targets) {
      const response = await post(admin, `admin/users/${id}/erase`, {
        reason: 'Not a customer',
      });
      expect(response.status()).toBe(409);
      expect((await response.json()).error.code).toBe(
        'USER_INVALID_TRANSITION',
      );
    }
    expect(
      (
        await post(admin, `admin/users/${randomUUID()}/erase`, {
          reason: 'abc',
        })
      ).status(),
    ).toBe(404);

    const customer = await fresh(contexts);
    const { id } = await registerCustomer(customer, {
      email: uniqueEmail('keep'),
    });
    for (const account of ['ops', 'finance'] as const) {
      const staff = await signedIn(contexts, account);
      expect(
        (
          await post(staff, `admin/users/${id}/erase`, { reason: 'abc' })
        ).status(),
        account,
      ).toBe(403);
    }
    expect((await customer.get('me')).status()).toBe(200);
  });
});
