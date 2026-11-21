import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * The customer's own booking self-service (M8, D-195, D-198, D-199, D-207):
 * the timeline allowlist, replacing passengers, the recheck before paying
 * and the documents list. Helpers are copied from booking-requests.e2e.ts.
 */

type Contexts = Parameters<typeof listedJet>[0];

const QUOTE = {
  operatorPriceMinor: 50_000_000,
  currency: 'INR',
  conditions: { inclusions: ['Crew', 'Fuel'], exclusions: ['Lounge'] },
};

function passengerBody(firstName: string) {
  return {
    firstName,
    lastName: 'Zzyzx',
    dateOfBirth: '1990-04-12',
    gender: 'FEMALE',
    nationality: 'IN',
    documentType: 'PASSPORT',
    documentNumber: `P${randomUUID().slice(0, 7)}`,
    documentExpiry: '2031-01-31',
    specialAssistance: 'Needs a wheelchair',
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

async function newCustomer(contexts: Contexts) {
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await registerCustomer(customer);
  return customer;
}

async function savePassenger(customer: APIRequestContext, firstName: string) {
  const response = await post(
    customer,
    'me/passengers',
    passengerBody(firstName),
  );
  expect(response.status()).toBe(201);
  return (await response.json()).data.id as string;
}

/** A priced jet on `contexts.request` and a customer's request for it. */
async function requested(contexts: Contexts) {
  const trip = await listedJet(contexts);
  const rate = await contexts.request.put(
    `operator/aircraft/${trip.aircraftId}/pricing`,
    {
      headers: await csrfHeaders(contexts.request),
      data: {
        hourlyRateMinor: 18_000_000,
        taxInclusive: false,
        commissionInclusive: false,
        minBillableHours: null,
      },
    },
  );
  expect(rate.status()).toBe(200);
  const searched = await searchFor(contexts.request, trip);
  const customer = await newCustomer(contexts);
  const created = await post(
    customer,
    'bookings',
    {
      searchId: searched.searchId,
      resultId: searched.result.resultId,
      cancellationTermsVersion: searched.termsVersion,
      currency: 'INR',
      expectedTotalMinor: searched.result.price.amountMinor,
    },
    randomUUID(),
  );
  expect(created.status()).toBe(201);
  return {
    trip,
    customer,
    reference: (await created.json()).data.reference as string,
  };
}

async function staff(contexts: Contexts) {
  const ops = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await signIn(ops, 'ops');
  return ops;
}

function audits(reference: string, action: string) {
  return withPrisma(async (prisma) => {
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { reference },
    });
    return prisma.auditLog.findMany({
      where: { entityId: booking.id, action },
    });
  });
}

function holdOf(reference: string) {
  return withPrisma(async (prisma) => {
    const booking = await prisma.booking.findUniqueOrThrow({
      where: { reference },
      include: { holds: true },
    });
    return booking.holds.map((hold) => hold.expiresAt?.toISOString() ?? null);
  });
}

async function events(customer: APIRequestContext, reference: string) {
  const response = await customer.get(`bookings/${reference}/events`);
  expect(response.status()).toBe(200);
  return (await response.json()).data as {
    kind: string;
    by: string;
    price: { priceType: string; amountMinor: number } | null;
  }[];
}

test.describe('GET /bookings/:reference/events', () => {
  test('shows the customer their own timeline and nothing internal', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts);
    const ops = await staff(contexts);

    expect(
      (
        await post(request, `operator/booking-requests/${reference}/clarify`, {
          message: 'How much luggage?',
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await post(customer, `bookings/${reference}/messages`, {
          message: 'Two bags',
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await post(
          request,
          `operator/booking-requests/${reference}/revise-quote`,
          QUOTE,
        )
      ).status(),
    ).toBe(201);

    // A passenger change, with a distinctive name that must never show.
    const savedId = await savePassenger(customer, 'Quillon');
    expect(
      (
        await customer.put(`bookings/${reference}/passengers`, {
          headers: {
            ...(await csrfHeaders(customer)),
            'Idempotency-Key': randomUUID(),
          },
          data: { passengerIds: [savedId] },
        })
      ).status(),
    ).toBe(200);

    // Internal material: an admin note, an escalation, the operator's reject
    // reason and an override reason.
    expect(
      (
        await post(ops, `admin/bookings/${reference}/notes`, {
          note: 'SECRETNOTE call the customer back',
        })
      ).status(),
    ).toBe(201);
    expect(
      (
        await post(ops, `admin/bookings/${reference}/escalate`, {
          reason: 'SECRETESCALATION suspicious payer',
        })
      ).status(),
    ).toBe(200);
    expect(
      (
        await post(request, `operator/booking-requests/${reference}/reject`, {
          reason: 'SECRETREJECT crew is on strike',
        })
      ).status(),
    ).toBe(200);
    const moved = await ops.patch(`admin/bookings/${reference}/status`, {
      headers: await csrfHeaders(ops),
      data: { status: 'EXPIRED', reason: 'SECRETOVERRIDE agreed by phone' },
    });
    expect(moved.status()).toBe(200);

    const response = await customer.get(`bookings/${reference}/events`);
    expect(response.status()).toBe(200);
    const text = await response.text();
    for (const secret of [
      'SECRETNOTE',
      'SECRETESCALATION',
      'SECRETREJECT',
      'SECRETOVERRIDE',
      'Quillon',
      'Zzyzx',
      'OPS',
      'SUPER_ADMIN',
      'actorId',
      'actorRole',
      'overrideReason',
    ]) {
      expect(text, secret).not.toContain(secret);
    }
    const list = JSON.parse(text).data as Awaited<ReturnType<typeof events>>;
    const kinds = list.map((entry) => entry.kind);
    expect(kinds).toEqual(
      expect.arrayContaining([
        'STATUS_CHANGED',
        'QUESTION_ASKED',
        'QUESTION_ANSWERED',
        'QUOTE_SENT',
        'PASSENGERS_UPDATED',
      ]),
    );
    expect(kinds.join()).not.toMatch(/ESCALAT/);
    const quote = list.find((entry) => entry.kind === 'QUOTE_SENT')!;
    expect(quote.price).toMatchObject({ priceType: 'QUOTE' });
    expect(quote.by).toBe('OPERATOR');
    expect(list.find((e) => e.kind === 'QUESTION_ANSWERED')!.by).toBe('YOU');
    const changed = list.find((entry) => entry.kind === 'PASSENGERS_UPDATED')!;
    expect(changed).toMatchObject({ by: 'YOU', note: null });
    // Every entry comes only from the fixed field list.
    for (const entry of list) {
      expect(['YOU', 'OPERATOR', 'FLYVIMAN', 'SYSTEM']).toContain(entry.by);
    }
  });

  test('another customer gets 404', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference } = await requested(contexts);
    const stranger = await newCustomer(contexts);
    expect((await stranger.get(`bookings/${reference}/events`)).status()).toBe(
      404,
    );
  });
});

test.describe('PUT /bookings/:reference/passengers', () => {
  const put = async (
    customer: APIRequestContext,
    reference: string,
    passengerIds: string[],
    key = randomUUID(),
  ) =>
    customer.put(`bookings/${reference}/passengers`, {
      headers: { ...(await csrfHeaders(customer)), 'Idempotency-Key': key },
      data: { passengerIds },
    });

  test('replaces with the caller’s saved passengers, audited by count, idempotent, operator told without names', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts);
    const first = await savePassenger(customer, 'Ottoline');
    const second = await savePassenger(customer, 'Perpetua');

    const key = randomUUID();
    const done = await put(customer, reference, [first, second], key);
    expect(done.status()).toBe(200);
    expect((await done.json()).data).toEqual({ reference, passengerCount: 2 });
    const again = await put(customer, reference, [first, second], key);
    expect(again.status()).toBe(200);
    expect((await again.json()).data).toEqual({ reference, passengerCount: 2 });

    const trip = (await (await customer.get(`bookings/${reference}`)).json())
      .data;
    expect(JSON.stringify(trip)).toContain('Ottoline');

    // One audit row for the two identical requests, counts only.
    const rows = await audits(reference, 'booking.passengers_replace');
    expect(rows).toHaveLength(1);
    expect(rows[0].after).toEqual({ reference, passengerCount: 2 });
    expect(JSON.stringify(rows[0])).not.toMatch(/Ottoline|Perpetua|Zzyzx/);

    // The operator is told: the count, never a name.
    await post(request, 'dev/jobs/notification-outbox');
    const inbox = (
      await (
        await request.get('me/notifications', { params: { pageSize: 100 } })
      ).json()
    ).data as { templateKey: string; title: string; body: string }[];
    const notice = inbox.find(
      (entry) =>
        entry.templateKey === 'booking.passengers_changed' &&
        entry.body.includes(reference),
    );
    expect(notice, 'operator notice').toBeTruthy();
    expect(notice!.body).toContain('2 passengers');
    expect(JSON.stringify(notice)).not.toMatch(/Ottoline|Perpetua|Zzyzx/);
  });

  test('refuses another customer’s passenger, too many, none, and another customer’s booking', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts); // two passengers
    const ids = [
      await savePassenger(customer, 'Ambrose'),
      await savePassenger(customer, 'Beatrix'),
      await savePassenger(customer, 'Cosimo'),
    ];
    const stranger = await newCustomer(contexts);
    const theirs = await savePassenger(stranger, 'Dorian');

    expect((await put(customer, reference, [theirs])).status()).toBe(404);
    const tooMany = await put(customer, reference, ids);
    expect(tooMany.status()).toBe(400);
    expect((await tooMany.json()).error.code).toBe('VALIDATION_ERROR');
    expect((await put(customer, reference, [])).status()).toBe(400);
    expect((await put(stranger, reference, [theirs])).status()).toBe(404);
    expect(await audits(reference, 'booking.passengers_replace')).toHaveLength(
      0,
    );
  });

  test('is locked once SCHEDULED and within 24 hours of departure', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts);
    const saved = await savePassenger(customer, 'Evander');
    const ops = await staff(contexts);

    // Within 24 hours of the first departure.
    await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      const itinerary = booking.itinerary as unknown as {
        legs: { departureAt: string }[];
      };
      itinerary.legs[0].departureAt = new Date(
        Date.now() + 2 * 3_600_000,
      ).toISOString();
      await prisma.booking.update({
        where: { id: booking.id },
        data: { itinerary: itinerary as never },
      });
    });
    const late = await put(customer, reference, [saved]);
    expect(late.status()).toBe(409);
    expect((await late.json()).error.code).toBe('BOOKING_PASSENGERS_LOCKED');

    // Once SCHEDULED, whatever the departure.
    await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      const itinerary = booking.itinerary as unknown as {
        legs: { departureAt: string }[];
      };
      itinerary.legs[0].departureAt = new Date(
        Date.now() + 90 * 3_600_000,
      ).toISOString();
      await prisma.booking.update({
        where: { id: booking.id },
        data: { itinerary: itinerary as never },
      });
    });
    expect((await put(customer, reference, [saved])).status()).toBe(200);
    const moved = await ops.patch(`admin/bookings/${reference}/status`, {
      headers: await csrfHeaders(ops),
      data: { status: 'SCHEDULED', reason: 'Scheduled by hand for the test' },
    });
    expect(moved.status()).toBe(200);
    const locked = await put(customer, reference, [saved]);
    expect(locked.status()).toBe(409);
    expect((await locked.json()).error.code).toBe('BOOKING_PASSENGERS_LOCKED');
  });
});

test.describe('POST /bookings/:reference/revalidate', () => {
  test('owner only, writes nothing, labels the price', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts);
    const holdBefore = await holdOf(reference);

    const checked = await post(customer, `bookings/${reference}/revalidate`);
    expect(checked.status()).toBe(200);
    const body = (await checked.json()).data;
    expect(body).toMatchObject({
      available: true,
      reason: null,
      price: { priceType: 'ESTIMATE' },
    });
    expect(await holdOf(reference)).toEqual(holdBefore);
    expect(await audits(reference, 'booking.passengers_replace')).toHaveLength(
      0,
    );
    // No audit row for this booking at all beyond what creation wrote.
    const forBooking = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      return prisma.auditLog.count({ where: { entityId: booking.id } });
    });
    await post(customer, `bookings/${reference}/revalidate`);
    const afterBooking = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      return prisma.auditLog.count({ where: { entityId: booking.id } });
    });
    expect(afterBooking).toBe(forBooking);

    const stranger = await newCustomer(contexts);
    expect(
      (await post(stranger, `bookings/${reference}/revalidate`)).status(),
    ).toBe(404);
  });

  test('a suspended aircraft is only “unavailable”, never why', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference, trip } = await requested(contexts);
    const ops = await staff(contexts);
    const suspended = await post(
      ops,
      `admin/aircraft/${trip.aircraftId}/suspend`,
      {
        reason: 'Insurance under query.',
      },
    );
    expect(suspended.status()).toBe(200);

    const checked = await post(customer, `bookings/${reference}/revalidate`);
    expect(checked.status()).toBe(200);
    const text = await checked.text();
    expect(JSON.parse(text).data).toMatchObject({
      available: false,
      reason: 'UNAVAILABLE',
      amountDue: null,
    });
    expect(text).not.toMatch(/OPERATOR_NOT_APPROVED|SUSPENDED|AIRCRAFT/i);
  });
});

test.describe('GET /bookings/:reference/documents', () => {
  test('owner only; no confirmation before confirmation; terms listed', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts);

    const response = await customer.get(`bookings/${reference}/documents`);
    expect(response.status()).toBe(200);
    const documents = (await response.json()).data as {
      kind: string;
      available: boolean;
      issuedAt: string | null;
    }[];
    expect(documents.find((d) => d.kind === 'CONFIRMATION')).toMatchObject({
      available: false,
      issuedAt: null,
    });
    expect(
      documents.find((d) => d.kind === 'CANCELLATION_TERMS'),
    ).toMatchObject({
      available: true,
    });
    expect(documents.some((d) => d.kind === 'RECEIPT')).toBe(false);

    const stranger = await newCustomer(contexts);
    expect(
      (await stranger.get(`bookings/${reference}/documents`)).status(),
    ).toBe(404);
  });

  // Receipts need a captured payment; the payment-order and webhook helpers
  // live in payments.e2e.ts and are not copied here.
  test.fixme('a receipt appears after a payment', () => {});
});
