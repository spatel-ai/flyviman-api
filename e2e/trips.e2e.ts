import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { approvedOperator } from './support/fleet.js';
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

test.describe('GET /bookings/:reference/cancellation-quote', () => {
  test('shows the terms and the charge before the customer commits', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);

    // The terms a search request is made on carry no charge.
    const plain = await quote(customer, reference);
    expect(plain).toMatchObject({
      reference,
      status: 'OPERATOR_PENDING',
      terms: { source: 'PLATFORM', charges: [] },
      appliedCharge: null,
      priceType: 'ESTIMATE',
      amountKnown: false,
      chargeMinor: 0,
      paidMinor: 0,
      refundMinor: 0,
      currency: 'INR',
    });
    expect(plain.hoursBeforeDeparture).toBeGreaterThanOrEqual(72);

    // The operator's terms apply before the price is confirmed: the rule
    // is shown, but no amount is invented.
    await setBooking(reference, { cancellationTerms: TIERED_TERMS });
    const estimate = await quote(customer, reference);
    expect(estimate).toMatchObject({
      appliedCharge: { minHoursBeforeDeparture: 72, chargePercent: 50 },
      amountKnown: false,
      chargeMinor: 0,
    });
    expect(estimate.explanation).toContain('not confirmed');

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
    expect(stored.booking.cancellationReason).toBe('Plans changed');
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
});
