import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { APIRequestContext, expect, test } from '@playwright/test';
import { FieldCipher, isEncrypted } from '../src/common/crypto/field-cipher.js';
import { encryptLegacyFreeText } from '../src/modules/bookings/free-text-backfill.js';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { approvedOperator } from './support/fleet.js';
import { pagedReferences, threeDepartures } from './support/list-sort.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/** Customer trips, cancellation and change requests (M8, W3-2). */

type Contexts = Parameters<typeof listedJet>[0];

/** Charges by notice; the test trip departs 78 to 102 hours from now. */
const TIERED_TERMS = {
  version: 1,
  source: 'OPERATOR_QUOTE',
  summary: 'Free until 5 days before, 50% until 3 days before, then 100%.',
  charges: [
    { minHoursBeforeDeparture: 120, chargePercent: 0 },
    { minHoursBeforeDeparture: 72, chargePercent: 50 },
    { minHoursBeforeDeparture: 0, chargePercent: 100 },
  ],
  acceptedAt: '2026-11-20T00:00:00.000Z',
};

/**
 * A customer of their own with one booking request on a fresh, priced jet
 * whose operator is signed in on `contexts.request`.
 */
async function bookedTrip(contexts: Contexts) {
  const { request, playwright, baseURL } = contexts;
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
  await registerCustomer(customer);
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
  return { customer, reference };
}

async function newCustomer(contexts: Contexts) {
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await registerCustomer(customer);
  return customer;
}

async function cancel(
  customer: APIRequestContext,
  reference: string,
  data: Record<string, unknown>,
  key: string = randomUUID(),
) {
  return customer.post(`bookings/${reference}/cancel`, {
    headers: { ...(await csrfHeaders(customer)), 'Idempotency-Key': key },
    data,
  });
}

async function quote(customer: APIRequestContext, reference: string) {
  const response = await customer.get(
    `bookings/${reference}/cancellation-quote`,
  );
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

function setBooking(reference: string, data: Record<string, unknown>) {
  return withPrisma((prisma) =>
    prisma.booking.update({ where: { reference }, data }),
  );
}

async function askChange(
  customer: APIRequestContext,
  reference: string,
  details = 'Could we leave an hour later?',
) {
  return customer.post(`bookings/${reference}/change-requests`, {
    headers: await csrfHeaders(customer),
    data: { details },
  });
}

async function decide(
  actor: APIRequestContext,
  path: 'operator' | 'admin',
  id: string,
  data: Record<string, unknown>,
) {
  return actor.post(`${path}/change-requests/${id}/decide`, {
    headers: await csrfHeaders(actor),
    data,
  });
}

test.describe('GET /me/bookings', () => {
  test('lists the caller’s own trips, upcoming then past, without passengers', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);

    const upcoming = await customer.get('me/bookings');
    expect(upcoming.status()).toBe(200);
    const body = await upcoming.json();
    expect(body.meta).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(body.data).toHaveLength(1);
    const [row] = body.data;
    expect(row).toMatchObject({
      reference,
      status: 'OPERATOR_PENDING',
      tripType: 'ONE_WAY',
      passengerCount: 2,
      price: { priceType: 'ESTIMATE', currency: 'INR' },
    });
    expect(row).not.toHaveProperty('passengers');
    expect(row).not.toHaveProperty('specialRequests');
    expect(
      (await (await customer.get('me/bookings?view=past')).json()).data,
    ).toHaveLength(0);

    const shown = await quote(customer, reference);
    expect(
      (
        await cancel(customer, reference, {
          expectedChargeMinor: shown.chargeMinor,
          currency: 'INR',
        })
      ).status(),
    ).toBe(200);
    const past = (await (await customer.get('me/bookings?view=past')).json())
      .data;
    expect(past.map((entry: { reference: string }) => entry.reference)).toEqual(
      [reference],
    );
    expect(
      (await (await customer.get('me/bookings')).json()).data,
    ).toHaveLength(0);

    const stranger = await newCustomer(contexts);
    expect(
      (await (await stranger.get('me/bookings?view=past')).json()).data,
    ).toHaveLength(0);

    expect((await customer.get('me/bookings?pageSize=51')).status()).toBe(400);
    expect((await customer.get('me/bookings?view=all')).status()).toBe(400);
    expect((await request.get('me/bookings')).status()).toBe(403);
  });
});

test.describe('GET /me/bookings sort', () => {
  test('orders by departure across pages, keeps the default, rejects unknown values and stays scoped', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);
    const own = (await (await customer.get('me/bookings')).json()).data[0]
      .departureAt as string;
    const { earlier, later } = await threeDepartures(reference, own);

    const get = (url: string) => customer.get(url);
    // Default: newest created first, as before the parameter existed.
    expect(await pagedReferences(get, 'me/bookings', 3)).toEqual([
      later,
      earlier,
      reference,
    ]);
    expect(
      await pagedReferences(get, 'me/bookings?sort=created_desc', 3),
    ).toEqual([later, earlier, reference]);
    expect(
      await pagedReferences(get, 'me/bookings?sort=departure_asc', 3),
    ).toEqual([earlier, reference, later]);
    expect(
      await pagedReferences(get, 'me/bookings?sort=departure_desc', 3),
    ).toEqual([later, reference, earlier]);
    const total = (
      await (
        await customer.get('me/bookings?sort=departure_asc&pageSize=1&page=2')
      ).json()
    ).meta.total;
    expect(total).toBe(3);

    const invalid = await customer.get('me/bookings?sort=price_asc');
    expect(invalid.status()).toBe(400);
    expect((await invalid.json()).error.code).toBe('VALIDATION_ERROR');

    const stranger = await newCustomer(contexts);
    const theirs = await stranger.get('me/bookings?sort=departure_asc');
    expect((await theirs.json()).data).toHaveLength(0);
  });
});

test.describe('GET /bookings/:reference/cancellation-quote', () => {
  test('shows the terms and the charge before the customer commits', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);

    // A search request carries Flyviman's tiers (D-172); before the price
    // is confirmed the rule is shown and no money is taken.
    const plain = await quote(customer, reference);
    expect(plain).toMatchObject({
      reference,
      status: 'OPERATOR_PENDING',
      terms: { source: 'PLATFORM' },
      priceType: 'ESTIMATE',
      amountKnown: false,
      chargeMinor: 0,
      paidMinor: 0,
      refundMinor: 0,
      currency: 'INR',
    });
    expect(plain.hoursBeforeDeparture).toBeGreaterThanOrEqual(72);
    expect(plain.terms.charges.length).toBeGreaterThan(0);
    const tier = plain.appliedCharge as {
      minHoursBeforeDeparture: number;
      chargePercent: number;
    };
    expect(tier.minHoursBeforeDeparture).toBeLessThanOrEqual(
      plain.hoursBeforeDeparture,
    );

    // Once the price is confirmed, the snapshot's tier is charged.
    await setBooking(reference, { priceType: 'CONFIRMED' });
    const flyviman = await quote(customer, reference);
    expect(flyviman).toMatchObject({
      amountKnown: true,
      appliedCharge: tier,
      chargeMinor: Math.floor((flyviman.totalMinor * tier.chargePercent) / 100),
    });
    await setBooking(reference, { priceType: 'ESTIMATE' });

    // Terms stored by an operator's quote before D-172 still apply.

    await setBooking(reference, { cancellationTerms: TIERED_TERMS });
    const estimate = await quote(customer, reference);
    expect(estimate).toMatchObject({
      appliedCharge: { minHoursBeforeDeparture: 72, chargePercent: 50 },
      amountKnown: false,
      chargeMinor: 0,
    });
    expect(estimate.explanation).toContain('still an estimate');

    await setBooking(reference, { priceType: 'CONFIRMED' });
    const confirmed = await quote(customer, reference);
    expect(confirmed).toMatchObject({
      priceType: 'CONFIRMED',
      amountKnown: true,
      chargeMinor: Math.floor(confirmed.totalMinor / 2),
      refundMinor: 0,
    });

    const stranger = await newCustomer(contexts);
    const theirs = await stranger.get(
      `bookings/${reference}/cancellation-quote`,
    );
    expect(theirs.status()).toBe(404);
    expect(
      (await request.get(`bookings/${reference}/cancellation-quote`)).status(),
    ).toBe(403);
  });
});

test.describe('POST /bookings/:reference/cancel', () => {
  test('cancels at the charge shown, records it once, and never twice', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);
    await setBooking(reference, {
      cancellationTerms: TIERED_TERMS,
      priceType: 'CONFIRMED',
    });
    const shown = await quote(customer, reference);
    expect(shown.chargeMinor).toBeGreaterThan(0);

    // A charge other than the current one is refused with the current one.
    const stale = await cancel(customer, reference, {
      expectedChargeMinor: 0,
      currency: 'INR',
    });
    expect(stale.status()).toBe(409);
    const staleError = (await stale.json()).error;
    expect(staleError.code).toBe('BOOKING_CANCELLATION_CHANGED');
    expect(staleError.details).toContainEqual({
      field: 'chargeMinor',
      issue: String(shown.chargeMinor),
    });

    expect(
      (
        await cancel(
          customer,
          reference,
          { expectedChargeMinor: shown.chargeMinor, currency: 'INR' },
          'not-a-uuid',
        )
      ).status(),
    ).toBe(400);
    expect(
      (
        await customer.post(`bookings/${reference}/cancel`, {
          headers: {
            ...(await csrfHeaders(customer)),
            'Idempotency-Key': randomUUID(),
          },
          data: { expectedChargeMinor: -1, currency: 'INR' },
        })
      ).status(),
    ).toBe(400);

    const stranger = await newCustomer(contexts);
    const theirs = await cancel(stranger, reference, {
      expectedChargeMinor: shown.chargeMinor,
      currency: 'INR',
    });
    expect(theirs.status()).toBe(404);

    const key = randomUUID();
    const body = {
      expectedChargeMinor: shown.chargeMinor,
      currency: 'INR',
      reason: 'Plans changed',
    };
    const first = await cancel(customer, reference, body, key);
    expect(first.status()).toBe(200);
    const cancelled = (await first.json()).data;
    expect(cancelled).toMatchObject({
      reference,
      status: 'CANCELLED',
      cancellation: {
        chargeMinor: shown.chargeMinor,
        refundMinor: 0,
        amountKnown: true,
      },
    });

    // The same key gives the same answer; a new key is refused.
    const again = await cancel(customer, reference, body, key);
    expect(again.status()).toBe(200);
    expect((await again.json()).data).toEqual(cancelled);
    const twice = await cancel(customer, reference, body);
    expect(twice.status()).toBe(409);
    expect((await twice.json()).error.code).toBe('BOOKING_NOT_CANCELLABLE');
    expect(
      (await customer.get(`bookings/${reference}/cancellation-quote`)).status(),
    ).toBe(409);

    const detail = (await (await customer.get(`bookings/${reference}`)).json())
      .data;
    expect(detail.status).toBe('CANCELLED');
    expect(detail.cancelledAt).toBe(cancelled.cancelledAt);
    expect(detail.changeRequests).toEqual([
      expect.objectContaining({ kind: 'CANCELLATION', status: 'COMPLETED' }),
    ]);

    const stored = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
        include: {
          events: { where: { toStatus: 'CANCELLED' } },
          changeRequests: true,
          holds: true,
        },
      });
      const audits = await prisma.auditLog.findMany({
        where: { entityId: booking.id, action: 'booking.cancel' },
      });
      return { booking, audits };
    });
    // Kept, encrypted: the customer's own words.
    const reason = stored.booking.cancellationReason as string;
    expect(isEncrypted(reason)).toBe(true);
    expect(reason).not.toContain('Plans changed');
    // The aircraft's time is offered again at once.
    expect(stored.booking.holds).toHaveLength(1);
    expect(stored.booking.holds[0].expiresAt!.getTime()).toBeLessThanOrEqual(
      Date.now(),
    );
    expect(stored.booking.events).toHaveLength(1);
    expect(stored.booking.events[0].payload).toMatchObject({
      cancellation: {
        termsSource: 'OPERATOR_QUOTE',
        appliedCharge: { chargePercent: 50 },
        chargeMinor: shown.chargeMinor,
        refundMinor: 0,
      },
    });
    expect(stored.booking.changeRequests).toHaveLength(1);
    expect(stored.booking.changeRequests[0].chargeMinor).toBe(
      BigInt(shown.chargeMinor),
    );
    expect(stored.booking.changeRequests[0].refundMinor).toBe(0n);
    expect(stored.audits).toHaveLength(1);
    expect(JSON.stringify(stored.audits[0].after)).not.toContain(
      'Plans changed',
    );
  });

  test('cancelling closes the operator’s open quote (EXPIRED)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await bookedTrip({
      request,
      playwright,
      baseURL,
    });
    const quoted = await request.post(
      `operator/booking-requests/${reference}/revise-quote`,
      {
        headers: await csrfHeaders(request),
        data: {
          operatorPriceMinor: 61_000_000,
          currency: 'INR',
          conditions: { inclusions: [], exclusions: [] },
        },
      },
    );
    expect(quoted.status()).toBe(201);
    const sent = (await quoted.json()).data.reference as string;
    expect(
      (
        await cancel(customer, reference, {
          expectedChargeMinor: 0,
          currency: 'INR',
        })
      ).status(),
    ).toBe(200);
    const row = await withPrisma((prisma) =>
      prisma.quote.findUniqueOrThrow({ where: { reference: sent } }),
    );
    expect(row.status).toBe('EXPIRED');
  });

  test('cancelling waits while a payment is being processed (409)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await bookedTrip({
      request,
      playwright,
      baseURL,
    });
    const paymentId = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      const payment = await prisma.payment.create({
        data: {
          reference: `FLY-PY-${randomUUID().slice(0, 6).toUpperCase()}`,
          bookingId: booking.id,
          provider: 'MOCK',
          purpose: 'FULL',
          amountMinor: booking.totalMinor,
          currency: 'INR',
          status: 'PENDING',
          idempotencyKey: `e2e:${randomUUID()}`,
        },
      });
      return payment.id;
    });
    const body = { expectedChargeMinor: 0, currency: 'INR' };
    const refused = await cancel(customer, reference, body);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe(
      'BOOKING_PAYMENT_IN_PROGRESS',
    );
    // Once the gateway has answered, the cancellation goes ahead.
    await withPrisma((prisma) =>
      prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'FAILED' },
      }),
    );
    expect((await cancel(customer, reference, body)).status()).toBe(200);
  });

  test('the customer declines a confirmed price before paying: QUOTE_DECLINED, hold released', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);
    const decline = async (who: APIRequestContext) =>
      who.post(`bookings/${reference}/decline`, {
        headers: await csrfHeaders(who),
      });
    // Not while the operator has not answered.
    const early = await decline(customer);
    expect(early.status()).toBe(409);
    expect((await early.json()).error.code).toBe('BOOKING_INVALID_TRANSITION');
    await setBooking(reference, {
      status: 'PRICE_CONFIRMED',
      priceType: 'CONFIRMED',
    });
    expect((await decline(await newCustomer(contexts))).status()).toBe(404);
    const declined = await decline(customer);
    expect(declined.status()).toBe(200);
    expect((await declined.json()).data.status).toBe('QUOTE_DECLINED');
    const holds = await withPrisma((prisma) =>
      prisma.availabilityBlock.findMany({
        where: { booking: { reference } },
      }),
    );
    expect(holds[0].expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('a completed booking cannot be cancelled', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await bookedTrip({
      request,
      playwright,
      baseURL,
    });
    await setBooking(reference, { status: 'COMPLETED' });
    const refused = await cancel(customer, reference, {
      expectedChargeMinor: 0,
      currency: 'INR',
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe('BOOKING_NOT_CANCELLABLE');
  });
});

test.describe('Change requests', () => {
  test('one open per booking, answered once by its operator with a note', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);

    expect((await askChange(customer, reference, '')).status()).toBe(400);
    const created = await askChange(customer, reference);
    expect(created.status()).toBe(201);
    const change = (await created.json()).data;
    expect(change).toMatchObject({
      bookingReference: reference,
      kind: 'CHANGE',
      status: 'REQUESTED',
      decisionNote: null,
    });
    const second = await askChange(customer, reference);
    expect(second.status()).toBe(409);
    expect((await second.json()).error.code).toBe('CHANGE_REQUEST_OPEN');

    const stranger = await newCustomer(contexts);
    expect((await askChange(stranger, reference)).status()).toBe(404);
    expect(
      (
        await decide(customer, 'operator', change.id, {
          decision: 'APPROVED',
          note: 'x',
        })
      ).status(),
    ).toBe(403);

    // Another operator does not see it.
    const other = await playwright.request.newContext({ baseURL });
    await approvedOperator(other, playwright, baseURL);
    const notTheirs = await decide(other, 'operator', change.id, {
      decision: 'APPROVED',
      note: 'Fine',
    });
    expect(notTheirs.status()).toBe(404);

    expect(
      (
        await decide(request, 'operator', change.id, {
          decision: 'COMPLETED',
          note: 'Fine',
        })
      ).status(),
    ).toBe(400);
    const approved = await decide(request, 'operator', change.id, {
      decision: 'APPROVED',
      note: 'We can leave at 07:00.',
    });
    expect(approved.status()).toBe(200);
    expect((await approved.json()).data).toMatchObject({
      status: 'APPROVED',
      decisionNote: 'We can leave at 07:00.',
    });
    const late = await decide(request, 'operator', change.id, {
      decision: 'REJECTED',
      note: 'No',
    });
    expect(late.status()).toBe(409);
    expect((await late.json()).error.code).toBe('CHANGE_REQUEST_DECIDED');

    const detail = (await (await customer.get(`bookings/${reference}`)).json())
      .data;
    expect(detail.changeRequests[0]).toMatchObject({
      id: change.id,
      status: 'APPROVED',
      decisionNote: 'We can leave at 07:00.',
    });
    // The operator's request page carries it too, so it can be answered there.
    const operatorView = await request.get(
      `operator/booking-requests/${reference}`,
    );
    expect(operatorView.status()).toBe(200);
    expect((await operatorView.json()).data.changeRequests[0]).toMatchObject({
      id: change.id,
      status: 'APPROVED',
      details: 'Could we leave an hour later?',
    });

    // Once answered, another can be asked; operations may answer it.
    const next = (await (await askChange(customer, reference)).json()).data;
    const ops = await playwright.request.newContext({ baseURL });
    await signIn(ops, 'ops');
    const declined = await decide(ops, 'admin', next.id, {
      decision: 'REJECTED',
      note: 'The aircraft is not free then.',
    });
    expect(declined.status()).toBe(200);
    expect((await declined.json()).data.status).toBe('REJECTED');
    expect(
      (
        await decide(request, 'admin', next.id, {
          decision: 'REJECTED',
          note: 'x',
        })
      ).status(),
    ).toBe(403);

    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: { in: [change.id, next.id] } },
      }),
    );
    expect(audits.map((entry) => entry.action).sort()).toEqual([
      'changeRequest.create',
      'changeRequest.create',
      'changeRequest.decide',
      'changeRequest.decide',
    ]);
    expect(JSON.stringify(audits)).not.toContain('leave an hour later');
  });

  test('cancelling closes an open request; a closed booking takes none', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await bookedTrip({
      request,
      playwright,
      baseURL,
    });
    const change = (await (await askChange(customer, reference)).json()).data;
    expect(
      (
        await cancel(customer, reference, {
          expectedChargeMinor: 0,
          currency: 'INR',
        })
      ).status(),
    ).toBe(200);
    const detail = (await (await customer.get(`bookings/${reference}`)).json())
      .data;
    expect(
      detail.changeRequests.find(
        (entry: { id: string }) => entry.id === change.id,
      ),
    ).toMatchObject({
      status: 'REJECTED',
      decisionNote: 'Closed because the booking was cancelled.',
    });
    const refused = await askChange(customer, reference);
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe(
      'CHANGE_REQUEST_NOT_ALLOWED',
    );
    expect(
      (
        await decide(request, 'operator', change.id, {
          decision: 'APPROVED',
          note: 'x',
        })
      ).status(),
    ).toBe(409);
  });

  test('the customer’s and the decision’s words are encrypted at rest; older plain rows still read', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference } = await bookedTrip({
      request,
      playwright,
      baseURL,
    });
    const words = `Please add a stop at Jaipur ${randomUUID().slice(0, 6)}`;
    const created = await askChange(customer, reference, words);
    expect(created.status()).toBe(201);
    const change = (await created.json()).data;
    expect(change.details).toBe(words);
    const answered = await decide(request, 'operator', change.id, {
      decision: 'REJECTED',
      note: 'No stop is possible on this aircraft.',
    });
    expect(answered.status()).toBe(200);
    expect(
      (
        await cancel(customer, reference, {
          expectedChargeMinor: 0,
          currency: 'INR',
          reason: 'Plans changed at work',
        })
      ).status(),
    ).toBe(200);

    const stored = () =>
      withPrisma(async (prisma) => {
        const booking = await prisma.booking.findUniqueOrThrow({
          where: { reference },
          include: { changeRequests: true, events: true },
        });
        return {
          reason: booking.cancellationReason as string,
          details: booking.changeRequests.map((row) => row.details),
          events: JSON.stringify(booking.events.map((event) => event.payload)),
        };
      });
    const atRest = await stored();
    for (const value of [atRest.reason, ...atRest.details]) {
      expect(isEncrypted(value)).toBe(true);
    }
    const everything = JSON.stringify(atRest);
    for (const plain of [
      words,
      'No stop is possible',
      'Plans changed at work',
      'Closed because',
      'Cancelled by the customer',
    ]) {
      expect(everything).not.toContain(plain);
    }

    const shown = async () =>
      (await (await customer.get(`bookings/${reference}`)).json()).data
        .changeRequests as {
        id: string;
        details: string;
        decisionNote: string;
      }[];
    expect(await shown()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: change.id,
          details: words,
          decisionNote: 'No stop is possible on this aircraft.',
        }),
        expect.objectContaining({
          kind: 'CANCELLATION',
          details: 'Cancelled by the customer.',
        }),
      ]),
    );

    // Rows written before encryption: plain details and reason, and a
    // plain note on an (append-only) event.
    await withPrisma(async (prisma) => {
      await prisma.changeRequest.update({
        where: { id: change.id },
        data: { details: 'An older plain request' },
      });
      await prisma.booking.update({
        where: { reference },
        data: { cancellationReason: 'An older plain reason' },
      });
      const { id: bookingId } = await prisma.booking.findUniqueOrThrow({
        where: { reference },
        select: { id: true },
      });
      await prisma.bookingEvent.create({
        data: {
          bookingId,
          type: 'NOTE',
          payload: {
            changeRequestId: change.id,
            decision: 'REJECTED',
            note: 'An older plain note',
          },
        },
      });
    });
    expect((await shown()).find((row) => row.id === change.id)).toMatchObject({
      details: 'An older plain request',
      decisionNote: 'An older plain note',
    });

    // The start-up data migration encrypts the mutable columns, once.
    const cipher = new FieldCipher({
      getOrThrow: () => process.env.DATA_ENCRYPTION_KEY,
    } as unknown as ConfigService);
    const migrate = () =>
      withPrisma((prisma) =>
        encryptLegacyFreeText(prisma, (plain) => cipher.encrypt(plain)),
      );
    expect(await migrate()).toBeGreaterThanOrEqual(2);
    const migrated = await stored();
    expect(isEncrypted(migrated.reason)).toBe(true);
    expect(migrated.details.every(isEncrypted)).toBe(true);
    expect(JSON.stringify(migrated.details)).not.toContain('older plain');
    expect(cipher.decrypt(migrated.reason)).toBe('An older plain reason');
    await migrate();
    expect((await stored()).details).toEqual(migrated.details);
    expect((await shown()).find((row) => row.id === change.id)).toMatchObject({
      details: 'An older plain request',
    });
  });
});
