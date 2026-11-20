import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { isEncrypted } from '../src/common/crypto/field-cipher.js';
import {
  latestLinkToken,
  outbox,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { aircraftBody } from './support/fleet.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders } from './support/session.js';

/**
 * The booking request flow after creation (M8, W3-1): the operator's inbox
 * (accept, reject, clarify, quote, notes), the customer's answers (accept or
 * decline a quote, answer a question) and the hold-expiry job.
 */

type Contexts = Parameters<typeof listedJet>[0];
type Trip = Awaited<ReturnType<typeof listedJet>>;

const QUOTE = {
  totalMinor: 61_000_000,
  currency: 'INR',
  conditions: {
    summary: 'Free cancellation until 72 hours before departure; 50% after.',
    charges: [
      { minHoursBeforeDeparture: 72, chargePercent: 0 },
      { minHoursBeforeDeparture: 0, chargePercent: 50 },
    ],
    inclusions: ['Crew', 'Fuel'],
    exclusions: ['Airport lounge'],
  },
};

async function setRate(operator: APIRequestContext, trip: Trip) {
  const response = await operator.put(
    `operator/aircraft/${trip.aircraftId}/pricing`,
    {
      headers: await csrfHeaders(operator),
      data: {
        hourlyRateMinor: 18_000_000,
        taxInclusive: false,
        commissionInclusive: false,
        minBillableHours: null,
      },
    },
  );
  expect(response.status()).toBe(200);
}

async function newCustomer(contexts: Contexts) {
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  const { email } = await registerCustomer(customer);
  return { customer, email };
}

/**
 * An approved jet on `contexts.request` (its operator administrator) and a
 * customer's request for it: priced, or on request when `priced` is false.
 */
async function requested(
  contexts: Contexts,
  priced = true,
  before?: (
    customer: APIRequestContext,
    searched: Awaited<ReturnType<typeof searchFor>>,
  ) => Promise<void>,
) {
  const trip = await listedJet(contexts);
  if (priced) await setRate(contexts.request, trip);
  const searched = await searchFor(contexts.request, trip);
  const { customer, email } = await newCustomer(contexts);
  await before?.(customer, searched);
  const response = await customer.post('bookings', {
    headers: {
      ...(await csrfHeaders(customer)),
      'Idempotency-Key': randomUUID(),
    },
    data: {
      searchId: searched.searchId,
      resultId: searched.result.resultId,
      currency: 'INR',
      ...(priced
        ? { expectedTotalMinor: searched.result.price.amountMinor }
        : {}),
    },
  });
  expect(response.status()).toBe(201);
  const created = (await response.json()).data;
  return {
    trip,
    searched,
    customer,
    email,
    reference: created.reference as string,
    created,
  };
}

async function post(
  context: APIRequestContext,
  path: string,
  data?: unknown,
  key?: string,
) {
  return context.post(path, {
    headers: {
      ...(await csrfHeaders(context)),
      ...(key ? { 'Idempotency-Key': key } : {}),
    },
    ...(data === undefined ? {} : { data }),
  });
}

async function quote(
  operator: APIRequestContext,
  reference: string,
  data = {},
) {
  const response = await post(
    operator,
    `operator/booking-requests/${reference}/revise-quote`,
    { ...QUOTE, ...data },
  );
  expect(response.status()).toBe(201);
  return (await response.json()).data;
}

/** Runs the job, waiting out a run another test holds the lock for. */
async function runJob(request: APIRequestContext) {
  let result: { skipped: boolean } = { skipped: true };
  await expect
    .poll(async () => {
      const response = await post(request, 'dev/jobs/booking-hold-expiry');
      expect(response.status()).toBe(200);
      result = (await response.json()).data;
      return result.skipped;
    })
    .toBe(false);
  return result;
}

function stored(reference: string) {
  return withPrisma((prisma) =>
    prisma.booking.findUniqueOrThrow({
      where: { reference },
      include: {
        holds: true,
        quotes: { orderBy: { createdAt: 'asc' } },
        events: { orderBy: { createdAt: 'asc' } },
      },
    }),
  );
}

/** Lets the request's hold lapse, as if its time had passed. */
function lapseHold(reference: string) {
  return withPrisma(async (prisma) => {
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { reference },
    });
    await prisma.availabilityBlock.updateMany({
      where: { bookingId: booking.id },
      data: { expiresAt: new Date(Date.now() - 60_000) },
    });
  });
}

/** A staff member of the operator on `admin`, signed in in its own context. */
async function staffMember(
  contexts: Contexts,
  permissions: {
    capabilities: string[];
    allAircraft?: boolean;
    aircraftIds?: string[];
  },
) {
  const email = uniqueEmail('staff');
  const invited = await post(contexts.request, 'operator/staff', {
    email,
    allAircraft: false,
    aircraftIds: [],
    ...permissions,
  });
  expect(invited.status()).toBe(201);
  const staff = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  const token = await latestLinkToken(staff, email);
  expect(
    (
      await staff.post('auth/password/reset', {
        data: { token, password: PASSWORD },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await staff.post('auth/login', { data: { email, password: PASSWORD } })
    ).status(),
  ).toBe(200);
  return staff;
}

test.describe('operator booking request inbox', () => {
  test('lists and shows the operator’s own requests, with no passenger identity', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, trip, created } = await requested(contexts);

    const list = await request.get('operator/booking-requests');
    expect(list.status()).toBe(200);
    const body = await list.json();
    const item = body.data.find(
      (entry: { reference: string }) => entry.reference === reference,
    );
    expect(item).toMatchObject({
      reference,
      status: 'OPERATOR_PENDING',
      aircraft: { id: trip.aircraftId },
      passengerCount: 2,
      price: { priceType: 'ESTIMATE', amountMinor: created.price.amountMinor },
      quote: null,
    });
    // The hold lasts 48 hours (BOOKING_HOLD_HOURS) or until the trip ends.
    const holdMs = Date.parse(item.holdExpiresAt) - Date.now();
    expect(holdMs).toBeGreaterThan(47 * 3_600_000);
    expect(holdMs).toBeLessThanOrEqual(48 * 3_600_000);

    const filtered = await request.get('operator/booking-requests', {
      params: { status: 'CANCELLED' },
    });
    expect(
      (await filtered.json()).data.some(
        (entry: { reference: string }) => entry.reference === reference,
      ),
    ).toBe(false);

    const detail = await request.get(`operator/booking-requests/${reference}`);
    expect(detail.status()).toBe(200);
    const shown = (await detail.json()).data;
    expect(shown).toMatchObject({
      reference,
      itinerary: { aircraft: { id: trip.aircraftId } },
      quotes: [],
      messages: [],
      notes: [],
    });
    expect(shown).not.toHaveProperty('passengers');

    // Bad input and the wrong role.
    expect(
      (
        await request.get('operator/booking-requests', {
          params: { status: 'NOPE' },
        })
      ).status(),
    ).toBe(400);
    const { customer } = await newCustomer(contexts);
    expect((await customer.get('operator/booking-requests')).status()).toBe(
      403,
    );
    expect(
      (await request.get('operator/booking-requests/FLY-BK-000000')).status(),
    ).toBe(404);
  });

  test('another operator gets 404; staff need MANAGE_BOOKINGS and the aircraft in reach', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, trip } = await requested(contexts);

    const other = await playwright.request.newContext({ baseURL });
    await listedJet({ request: other, playwright, baseURL });
    expect(
      (await other.get(`operator/booking-requests/${reference}`)).status(),
    ).toBe(404);
    expect(
      (
        await post(
          other,
          `operator/booking-requests/${reference}/accept`,
          {},
          randomUUID(),
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await post(other, `operator/bookings/${reference}/notes`, {
          note: 'Not ours',
        })
      ).status(),
    ).toBe(404);

    const noCapability = await staffMember(contexts, {
      capabilities: ['MANAGE_AVAILABILITY'],
      allAircraft: true,
    });
    expect((await noCapability.get('operator/booking-requests')).status()).toBe(
      403,
    );

    // Staff assigned only another aircraft of the same operator.
    const another = await post(
      request,
      'operator/aircraft',
      aircraftBody(trip.mumbai),
    );
    expect(another.status()).toBe(201);
    const outOfReach = await staffMember(contexts, {
      capabilities: ['MANAGE_BOOKINGS'],
      aircraftIds: [(await another.json()).data.id],
    });
    expect(
      (await outOfReach.get(`operator/booking-requests/${reference}`)).status(),
    ).toBe(404);
    const reachable = await outOfReach.get('operator/booking-requests');
    expect((await reachable.json()).data).toEqual([]);

    const inReach = await staffMember(contexts, {
      capabilities: ['MANAGE_BOOKINGS'],
      aircraftIds: [trip.aircraftId],
    });
    expect(
      (await inReach.get(`operator/booking-requests/${reference}`)).status(),
    ).toBe(200);
  });

  test('accepts at the proposed price, once: PRICE_CONFIRMED, audited, customer told', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, customer, email, created } = await requested(contexts);
    const key = randomUUID();
    const path = `operator/booking-requests/${reference}/accept`;

    const accepted = await post(request, path, undefined, key);
    expect(accepted.status()).toBe(200);
    const body = (await accepted.json()).data;
    expect(body).toMatchObject({
      reference,
      status: 'PRICE_CONFIRMED',
      price: { priceType: 'CONFIRMED', amountMinor: created.price.amountMinor },
    });
    // The same key returns the same answer; a new key is a second accept.
    const repeat = await post(request, path, undefined, key);
    expect(repeat.status()).toBe(200);
    expect((await repeat.json()).data.status).toBe('PRICE_CONFIRMED');
    const again = await post(request, path, undefined, randomUUID());
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('BOOKING_INVALID_TRANSITION');
    // Without a key: refused.
    expect((await post(request, path)).status()).toBe(400);

    const own = (await (await customer.get(`bookings/${reference}`)).json())
      .data;
    expect(own.status).toBe('PRICE_CONFIRMED');
    expect(own.price).toMatchObject({
      priceType: 'CONFIRMED',
      amountMinor: created.price.amountMinor,
    });
    // The terms the customer was shown stand (rule 9).
    expect(own.cancellationTerms.source).toBe('PLATFORM');

    const row = await stored(reference);
    expect(row.operatorAcceptedAt).not.toBeNull();
    expect(
      row.events
        .filter((event) => event.type === 'STATUS_CHANGED')
        .map((event) => event.toStatus),
    ).toEqual(['REQUESTED', 'OPERATOR_PENDING', 'PRICE_CONFIRMED']);
    const actions = await withPrisma(async (prisma) =>
      (
        await prisma.auditLog.findMany({
          where: { entityType: 'Booking', entityId: row.id },
        })
      ).map((entry) => entry.action),
    );
    expect(actions).toEqual(
      expect.arrayContaining(['booking.status', 'booking.price']),
    );
    await expect
      .poll(async () =>
        (await outbox(request, email)).some((message) =>
          message.subject?.includes(reference),
        ),
      )
      .toBe(true);
  });

  test('rechecks the aircraft before accepting (rule 3)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, trip } = await requested(contexts);
    // Maintenance was booked over the held time meanwhile.
    const row = await stored(reference);
    await withPrisma((prisma) =>
      prisma.availabilityBlock.create({
        data: {
          aircraftId: trip.aircraftId,
          startsAt: row.holds[0].startsAt,
          endsAt: row.holds[0].endsAt,
          reason: 'MAINTENANCE',
        },
      }),
    );
    const accepted = await post(
      request,
      `operator/booking-requests/${reference}/accept`,
      undefined,
      randomUUID(),
    );
    expect(accepted.status()).toBe(409);
    expect((await accepted.json()).error.code).toBe('BOOKING_UNAVAILABLE');
    expect((await stored(reference)).status).toBe('OPERATOR_PENDING');
  });

  test('rejects with a reason: OPERATOR_UNAVAILABLE, hold released', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, customer } = await requested(contexts);
    const path = `operator/booking-requests/${reference}/reject`;
    expect((await post(request, path, {})).status()).toBe(400);

    const rejected = await post(request, path, {
      reason: 'Crew unavailable that day',
    });
    expect(rejected.status()).toBe(200);
    expect((await rejected.json()).data.status).toBe('OPERATOR_UNAVAILABLE');
    expect((await post(request, path, { reason: 'Again' })).status()).toBe(409);

    const row = await stored(reference);
    expect(row.holds[0].expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const response = row.events.find(
      (event) => event.type === 'OPERATOR_RESPONSE',
    );
    const payload = response!.payload as { reason: string };
    expect(isEncrypted(payload.reason)).toBe(true);
    // The customer sees the outcome, not the operator's reason.
    const own = await (await customer.get(`bookings/${reference}`)).json();
    expect(own.data.status).toBe('OPERATOR_UNAVAILABLE');
    expect(JSON.stringify(own)).not.toContain('Crew unavailable');
  });

  test('asks a question; the customer’s answer returns the request to the operator', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, customer } = await requested(contexts);
    // Nothing to answer yet.
    expect(
      (
        await post(customer, `bookings/${reference}/messages`, {
          message: 'Hello',
        })
      ).status(),
    ).toBe(409);

    const asked = await post(
      request,
      `operator/booking-requests/${reference}/clarify`,
      { message: 'How much luggage will you carry?' },
    );
    expect(asked.status()).toBe(200);
    expect((await asked.json()).data.status).toBe('CLARIFICATION_REQUESTED');

    const { customer: stranger } = await newCustomer(contexts);
    expect(
      (await stranger.get(`bookings/${reference}/messages`)).status(),
    ).toBe(404);
    expect(
      (
        await post(stranger, `bookings/${reference}/messages`, {
          message: 'Not mine',
        })
      ).status(),
    ).toBe(404);

    const answered = await post(customer, `bookings/${reference}/messages`, {
      message: 'Two suitcases',
    });
    expect(answered.status()).toBe(201);
    expect(
      (await answered.json()).data.map(
        (entry: { from: string; body: string }) => [entry.from, entry.body],
      ),
    ).toEqual([
      ['OPERATOR', 'How much luggage will you carry?'],
      ['CUSTOMER', 'Two suitcases'],
    ]);
    const detail = (
      await (await request.get(`operator/booking-requests/${reference}`)).json()
    ).data;
    expect(detail.status).toBe('OPERATOR_PENDING');
    expect(detail.messages).toHaveLength(2);

    const row = await stored(reference);
    for (const event of row.events.filter((e) => e.type === 'MESSAGE')) {
      expect(isEncrypted((event.payload as { body: string }).body)).toBe(true);
    }
  });

  test('keeps internal notes from the customer', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, customer } = await requested(contexts);
    const added = await post(request, `operator/bookings/${reference}/notes`, {
      note: 'Call the handler at Goa',
    });
    expect(added.status()).toBe(201);
    expect((await added.json()).data.body).toBe('Call the handler at Goa');
    expect(
      (
        await post(request, `operator/bookings/${reference}/notes`, {})
      ).status(),
    ).toBe(400);

    const detail = (
      await (await request.get(`operator/booking-requests/${reference}`)).json()
    ).data;
    expect(detail.notes.map((note: { body: string }) => note.body)).toEqual([
      'Call the handler at Goa',
    ]);
    const seen = JSON.stringify([
      await (await customer.get(`bookings/${reference}`)).json(),
      await (await customer.get(`bookings/${reference}/messages`)).json(),
    ]);
    expect(seen).not.toContain('handler');
  });
});

test.describe('quotes', () => {
  test('a revision supersedes the open quote; the customer accepts the current one, once', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, customer } = await requested(contexts);

    const first = await quote(request, reference);
    expect(first).toMatchObject({
      reference: expect.stringMatching(/^FLY-QT-[2-9A-HJ-NP-Z]{6}$/),
      bookingReference: reference,
      status: 'SENT',
      open: true,
      price: { priceType: 'QUOTE', amountMinor: QUOTE.totalMinor },
      conditions: QUOTE.conditions,
    });
    // Valid for 48 hours by default.
    const validMs = Date.parse(first.price.validUntil) - Date.now();
    expect(validMs).toBeGreaterThan(47 * 3_600_000);
    expect(validMs).toBeLessThanOrEqual(48 * 3_600_000);

    // While a quote waits for the customer, the operator cannot accept.
    const blocked = await post(
      request,
      `operator/booking-requests/${reference}/accept`,
      undefined,
      randomUUID(),
    );
    expect(blocked.status()).toBe(409);

    const second = await quote(request, reference, { totalMinor: 59_000_000 });
    const quotes = (
      await (await customer.get(`bookings/${reference}/quotes`)).json()
    ).data;
    expect(
      quotes.map((entry: { reference: string; status: string }) => [
        entry.reference,
        entry.status,
      ]),
    ).toEqual([
      [second.reference, 'SENT'],
      [first.reference, 'SUPERSEDED'],
    ]);

    // A stale screen accepting the replaced quote.
    const stale = await post(
      customer,
      `quotes/${first.reference}/accept`,
      undefined,
      randomUUID(),
    );
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe('QUOTE_INVALID_TRANSITION');

    // Another customer cannot see or accept it.
    const { customer: stranger } = await newCustomer(contexts);
    expect((await stranger.get(`quotes/${second.reference}`)).status()).toBe(
      404,
    );
    expect(
      (
        await post(
          stranger,
          `quotes/${second.reference}/accept`,
          undefined,
          randomUUID(),
        )
      ).status(),
    ).toBe(404);
    // Operators do not answer quotes.
    expect(
      (
        await post(
          request,
          `quotes/${second.reference}/accept`,
          undefined,
          randomUUID(),
        )
      ).status(),
    ).toBe(403);

    const key = randomUUID();
    const accepted = await post(
      customer,
      `quotes/${second.reference}/accept`,
      undefined,
      key,
    );
    expect(accepted.status()).toBe(200);
    expect((await accepted.json()).data).toMatchObject({
      status: 'ACCEPTED',
      open: false,
      price: { priceType: 'CONFIRMED', amountMinor: 59_000_000 },
    });
    const repeat = await post(
      customer,
      `quotes/${second.reference}/accept`,
      undefined,
      key,
    );
    expect(repeat.status()).toBe(200);
    const twice = await post(
      customer,
      `quotes/${second.reference}/accept`,
      undefined,
      randomUUID(),
    );
    expect(twice.status()).toBe(409);
    expect((await twice.json()).error.code).toBe('QUOTE_INVALID_TRANSITION');

    const own = (await (await customer.get(`bookings/${reference}`)).json())
      .data;
    expect(own).toMatchObject({
      status: 'PRICE_CONFIRMED',
      price: { priceType: 'CONFIRMED', amountMinor: 59_000_000 },
      cancellationTerms: {
        source: 'OPERATOR_QUOTE',
        summary: QUOTE.conditions.summary,
        charges: QUOTE.conditions.charges,
      },
    });
    const row = await stored(reference);
    expect(row.acceptedQuoteId).toBe(row.quotes[1].id);
    expect(row.operatorAcceptedAt).not.toBeNull();
    // A request that is no longer pending cannot be quoted.
    const late = await post(
      request,
      `operator/booking-requests/${reference}/revise-quote`,
      QUOTE,
    );
    expect(late.status()).toBe(409);
  });

  test('refuses a quote with bad validity or conditions', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference } = await requested(contexts);
    const path = `operator/booking-requests/${reference}/revise-quote`;
    for (const data of [
      { ...QUOTE, validUntil: new Date(Date.now() + 60_000).toISOString() },
      {
        ...QUOTE,
        validUntil: new Date(Date.now() + 30 * 86_400_000).toISOString(),
      },
      {
        ...QUOTE,
        conditions: {
          ...QUOTE.conditions,
          charges: [...QUOTE.conditions.charges].reverse(),
        },
      },
      { ...QUOTE, totalMinor: 0 },
      { ...QUOTE, currency: 'USD' },
    ]) {
      const response = await post(request, path, data);
      expect(response.status(), JSON.stringify(data)).toBe(400);
    }
    const custom = await quote(request, reference, {
      validUntil: new Date(Date.now() + 6 * 3_600_000).toISOString(),
    });
    expect(Date.parse(custom.price.validUntil)).toBeLessThan(
      Date.now() + 7 * 3_600_000,
    );
  });

  test('the customer declines: QUOTE_DECLINED, hold released', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, customer } = await requested(contexts);
    const sent = await quote(request, reference);
    const declined = await post(customer, `quotes/${sent.reference}/reject`);
    expect(declined.status()).toBe(200);
    expect((await declined.json()).data.status).toBe('REJECTED');
    expect(
      (await post(customer, `quotes/${sent.reference}/reject`)).status(),
    ).toBe(409);
    const row = await stored(reference);
    expect(row.status).toBe('QUOTE_DECLINED');
    expect(row.holds[0].expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });

  test('a price on request becomes a quote request, priced only by a quote', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, customer, created, searched } = await requested(
      contexts,
      false,
      async (customer, searched) => {
        // An amount sent for a result on request is a change to show first.
        const withAmount = await customer.post('bookings', {
          headers: {
            ...(await csrfHeaders(customer)),
            'Idempotency-Key': randomUUID(),
          },
          data: {
            searchId: searched.searchId,
            resultId: searched.result.resultId,
            currency: 'INR',
            expectedTotalMinor: 1000,
          },
        });
        expect(withAmount.status()).toBe(409);
        expect((await withAmount.json()).error).toMatchObject({
          code: 'BOOKING_PRICE_CHANGED',
          details: [{ field: 'price', issue: 'ON_REQUEST' }],
        });
      },
    );
    expect(searched.result.price).toBeNull();
    expect(created).toMatchObject({ status: 'OPERATOR_PENDING', price: null });
    const detail = (
      await (
        await customer.get(
          `search/${searched.searchId}/results/${searched.result.resultId}`,
        )
      ).json()
    ).data;
    expect(detail.confirmationRequirements.join(' ')).toMatch(/quote/);

    expect(
      (await (await customer.get(`bookings/${reference}`)).json()).data.price,
    ).toBeNull();
    const inbox = (
      await (await request.get(`operator/booking-requests/${reference}`)).json()
    ).data;
    expect(inbox.price).toBeNull();
    const plain = await post(
      request,
      `operator/booking-requests/${reference}/accept`,
      undefined,
      randomUUID(),
    );
    expect(plain.status()).toBe(409);

    const sent = await quote(request, reference);
    const accepted = await post(
      customer,
      `quotes/${sent.reference}/accept`,
      undefined,
      randomUUID(),
    );
    expect(accepted.status()).toBe(200);
    expect(
      (await (await customer.get(`bookings/${reference}`)).json()).data.price,
    ).toMatchObject({ priceType: 'CONFIRMED', amountMinor: QUOTE.totalMinor });
  });
});

test.describe('hold-expiry job', () => {
  test('closes a request whose hold lapsed unanswered, once', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, email } = await requested(contexts);
    await lapseHold(reference);
    await runJob(request);
    let row = await stored(reference);
    expect(row.status).toBe('OPERATOR_UNAVAILABLE');
    const closing = row.events.find(
      (event) => event.toStatus === 'OPERATOR_UNAVAILABLE',
    );
    expect(closing?.actorId).toBeNull();
    // A second run changes nothing.
    await runJob(request);
    row = await stored(reference);
    expect(
      row.events.filter((event) => event.toStatus === 'OPERATOR_UNAVAILABLE'),
    ).toHaveLength(1);
    await expect
      .poll(async () =>
        (await outbox(request, email)).some((message) =>
          message.subject?.includes(reference),
        ),
      )
      .toBe(true);
  });

  test('expires a lapsed quote and its request; a stale accept is refused', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, customer } = await requested(contexts);
    const sent = await quote(request, reference);
    await withPrisma((prisma) =>
      prisma.quote.update({
        where: { reference: sent.reference },
        data: { validUntil: new Date(Date.now() - 60_000) },
      }),
    );
    // Past validUntil, before the job has run.
    const late = await post(
      customer,
      `quotes/${sent.reference}/accept`,
      undefined,
      randomUUID(),
    );
    expect(late.status()).toBe(409);
    expect((await late.json()).error.code).toBe('QUOTE_EXPIRED');

    await runJob(request);
    await runJob(request);
    const row = await stored(reference);
    expect(row.status).toBe('EXPIRED');
    expect(row.quotes[0].status).toBe('EXPIRED');
    expect(
      row.events.filter((event) => event.toStatus === 'EXPIRED'),
    ).toHaveLength(1);
    expect(row.holds[0].expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});
