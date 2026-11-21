import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { ACCOUNTS } from './support/accounts.js';
import {
  outbox,
  registerCustomer,
  registerOperator,
  uniquePhone,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * The caller's SMS and WhatsApp opt-outs (D-209): who may set them, and that
 * a non-mandatory message honours them while a mandatory one does not.
 */

type Contexts = Parameters<typeof listedJet>[0];

const PATH = 'me/notification-preferences';

async function patch(context: APIRequestContext, data: unknown) {
  return context.patch(PATH, { headers: await csrfHeaders(context), data });
}

async function dispatch(request: APIRequestContext) {
  const response = await request.post('dev/jobs/notification-outbox', {
    headers: await csrfHeaders(request),
  });
  expect(response.status()).toBe(200);
}

test.describe('/me/notification-preferences', () => {
  test('defaults to opted in, and a change to one field keeps the other', async ({
    playwright,
    baseURL,
  }) => {
    const customer = await playwright.request.newContext({ baseURL });
    await registerCustomer(customer);
    const defaults = await customer.get(PATH);
    expect(defaults.status()).toBe(200);
    expect((await defaults.json()).data).toEqual({
      smsOptedOut: false,
      whatsappOptedOut: false,
    });

    const sms = await patch(customer, { smsOptedOut: true });
    expect(sms.status()).toBe(200);
    expect((await sms.json()).data).toEqual({
      smsOptedOut: true,
      whatsappOptedOut: false,
    });
    const whatsapp = await patch(customer, { whatsappOptedOut: true });
    expect((await whatsapp.json()).data).toEqual({
      smsOptedOut: true,
      whatsappOptedOut: true,
    });
    const back = await patch(customer, { smsOptedOut: false });
    expect((await back.json()).data).toEqual({
      smsOptedOut: false,
      whatsappOptedOut: true,
    });
    expect((await (await customer.get(PATH)).json()).data).toEqual({
      smsOptedOut: false,
      whatsappOptedOut: true,
    });
  });

  test('refuses null, other types and unknown fields', async ({
    playwright,
    baseURL,
  }) => {
    const customer = await playwright.request.newContext({ baseURL });
    await registerCustomer(customer);
    for (const data of [
      { smsOptedOut: null },
      { whatsappOptedOut: null },
      { smsOptedOut: 'yes' },
      { emailOptedOut: true },
    ]) {
      const response = await patch(customer, data);
      expect(response.status(), JSON.stringify(data)).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
    expect((await (await customer.get(PATH)).json()).data).toEqual({
      smsOptedOut: false,
      whatsappOptedOut: false,
    });
  });

  test('customers and operator users may; staff may not; nobody anonymous', async ({
    playwright,
    baseURL,
  }) => {
    const operator = await playwright.request.newContext({ baseURL });
    await registerOperator(operator);
    expect((await patch(operator, { smsOptedOut: true })).status()).toBe(200);
    expect((await operator.get(PATH)).status()).toBe(200);

    for (const account of ['ops', 'finance', 'superAdmin'] as const) {
      const staff = await playwright.request.newContext({ baseURL });
      await signIn(staff, account);
      expect((await staff.get(PATH)).status(), account).toBe(403);
      expect(
        (await patch(staff, { smsOptedOut: true })).status(),
        account,
      ).toBe(403);
    }
    const anonymous = await playwright.request.newContext({ baseURL });
    expect((await anonymous.get(PATH)).status()).toBe(401);
    // The seeded staff accounts are untouched.
    const stored = await withPrisma((prisma) =>
      prisma.user.findUniqueOrThrow({ where: { email: ACCOUNTS.ops.email } }),
    );
    expect(stored.smsOptedOut).toBe(false);
  });

  test('an SMS opt-out drops a non-mandatory text but not email, in-app or a mandatory text', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts: Contexts = { request, playwright, baseURL };
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

    const customer = await playwright.request.newContext({ baseURL });
    const { email, id } = await registerCustomer(customer);
    const phone = uniquePhone();
    await withPrisma((prisma) =>
      prisma.user.update({
        where: { id },
        data: { phone, phoneVerifiedAt: new Date() },
      }),
    );
    expect((await patch(customer, { smsOptedOut: true })).status()).toBe(200);

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
      },
    });
    expect(created.status()).toBe(201);
    const reference = (await created.json()).data.reference as string;

    // Not mandatory: the operator accepts, the customer is told the price is
    // confirmed.
    const accepted = await request.post(
      `operator/booking-requests/${reference}/accept`,
      {
        headers: {
          ...(await csrfHeaders(request)),
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(accepted.status()).toBe(200);
    await dispatch(request);

    const about = async () =>
      [...(await outbox(request, email)), ...(await outbox(request, phone))]
        .filter((message) => message.body.includes(reference))
        .map((message) => message.channel)
        .sort();
    expect(await about()).toEqual(['EMAIL', 'WHATSAPP']);
    const inApp = (
      await (
        await customer.get('me/notifications', {
          params: { pageSize: 100 },
        })
      ).json()
    ).data as { templateKey: string }[];
    expect(
      inApp.some((entry) => entry.templateKey === 'booking.price_confirmed'),
    ).toBe(true);

    // Mandatory: cancelling the booking still texts the customer.
    const quote = await customer.get(
      `bookings/${reference}/cancellation-quote`,
    );
    const cancelled = await customer.post(`bookings/${reference}/cancel`, {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: {
        expectedChargeMinor: (await quote.json()).data.chargeMinor,
        currency: 'INR',
      },
    });
    expect(cancelled.status()).toBe(200);
    await dispatch(request);
    expect(await about()).toEqual([
      'EMAIL',
      'EMAIL',
      'SMS',
      'WHATSAPP',
      'WHATSAPP',
    ]);
    const texts = (await outbox(request, phone)).filter(
      (message) => message.channel === 'SMS',
    );
    expect(texts).toHaveLength(1);
    expect(texts[0].body).toContain(reference);
  });
});
