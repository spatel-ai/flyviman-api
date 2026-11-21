import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { outbox, registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, inDays } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Booking an empty leg (M8-C, D-199, D-200, D-213): the request, the rules
 * it enforces, the offer's lock while the request is live, and its release
 * or sale.
 */

type Contexts = Parameters<typeof listedJet>[0];

const PRICE = 18_500_000;

interface Offer {
  id: string;
  reference: string;
  priceMinor: number;
}

/** A published offer on a fresh approved jet; `request` is its operator. */
async function liveOffer(
  contexts: Contexts,
  data: Record<string, unknown> = {},
) {
  const { request } = contexts;
  const trip = await listedJet(contexts);
  const created = await request.post('operator/empty-legs', {
    headers: await csrfHeaders(request),
    data: {
      aircraftId: trip.aircraftId,
      originId: trip.goa,
      destinationId: trip.mumbai,
      departureFrom: inDays(6, 4).toISOString(),
      departureTo: inDays(6, 12).toISOString(),
      seatsAvailable: 6,
      priceMinor: PRICE,
      validUntil: inDays(5, 12).toISOString(),
      conditions: 'Subject to the aircraft repositioning as planned.',
      ...data,
    },
  });
  expect(created.status()).toBe(201);
  const offer = (await created.json()).data as Offer;
  const published = await request.post(
    `operator/empty-legs/${offer.id}/publish`,
    {
      headers: await csrfHeaders(request),
    },
  );
  expect(published.status()).toBe(200);
  return { trip, offer };
}

async function newCustomer(contexts: Contexts) {
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await registerCustomer(customer);
  return customer;
}

/** What a customer sends: the public detail's price, terms and version. */
async function bodyFor(
  customer: APIRequestContext,
  offer: Offer,
  extra: Record<string, unknown> = {},
) {
  const detail = await customer.get(`empty-legs/${offer.id}`);
  expect(detail.status()).toBe(200);
  const shown = (await detail.json()).data;
  return {
    emptyLegId: offer.id,
    passengerCount: 2,
    expectedTotalMinor: shown.price.amountMinor,
    currency: 'INR',
    cancellationTermsVersion: shown.cancellationTerms.version,
    offerUpdatedAt: shown.updatedAt,
    ...extra,
  };
}

async function book(
  customer: APIRequestContext,
  data: Record<string, unknown>,
  key: string = randomUUID(),
) {
  return customer.post('bookings/empty-leg', {
    headers: { ...(await csrfHeaders(customer)), 'Idempotency-Key': key },
    data,
  });
}

async function errorOf(response: {
  status(): number;
  json(): Promise<unknown>;
}) {
  return (
    (await response.json()) as {
      error: { code: string; details?: { field: string; issue: string }[] };
    }
  ).error;
}

async function bookingsOf(offerId: string) {
  return withPrisma((prisma) =>
    prisma.booking.findMany({ where: { emptyLegId: offerId } }),
  );
}

async function listedIds(request: APIRequestContext, origin: string) {
  const ids: string[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const response = await request.get('empty-legs', {
      params: { pageSize: 100, page, origin },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    ids.push(...(body.data as { id: string }[]).map((o) => o.id));
    if (page * 100 >= body.meta.total) break;
  }
  return ids;
}

async function operatorOffer(request: APIRequestContext, id: string) {
  const response = await request.get(`operator/empty-legs/${id}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

/** A request that is live: the offer, the customer and the booking. */
async function requested(contexts: Contexts) {
  const { offer, trip } = await liveOffer(contexts);
  const customer = await newCustomer(contexts);
  const response = await book(customer, await bodyFor(customer, offer));
  expect(response.status()).toBe(201);
  const reference = (await response.json()).data.reference as string;
  return { offer, trip, customer, reference };
}

test.describe('POST /bookings/empty-leg', () => {
  test('a customer books a listed offer: a labelled quote request with its price split stored', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { offer } = await liveOffer(contexts);
    const customer = await newCustomer(contexts);
    const body = await bodyFor(customer, offer);
    const key = randomUUID();

    const response = await book(customer, body, key);
    expect(response.status()).toBe(201);
    const created = (await response.json()).data;
    expect(created).toMatchObject({
      status: 'OPERATOR_PENDING',
      paymentStatus: 'UNPAID',
      // Rule 1: the operator's own price, a quote until it accepts.
      price: { priceType: 'QUOTE', amountMinor: PRICE, currency: 'INR' },
    });

    const stored = await withPrisma((prisma) =>
      prisma.booking.findUniqueOrThrow({
        where: { reference: created.reference },
        include: { calculation: true },
      }),
    );
    expect(stored.emptyLegId).toBe(offer.id);
    expect(stored.category).toBe('EMPTY_LEG');
    expect(stored.priceType).toBe('QUOTE');
    expect(stored.totalMinor).toBe(BigInt(PRICE));
    const calc = stored.calculation!;
    expect(calc.totalMinor).toBe(BigInt(PRICE));
    expect(calc.priceType).toBe('QUOTE');
    // The parts add up to the offer's price, none negative.
    expect(
      calc.operatorPayableMinor + calc.platformRevenueMinor + calc.taxMinor,
    ).toBe(BigInt(PRICE));
    expect(calc.baseMinor + calc.feesMinor + calc.taxMinor).toBe(BigInt(PRICE));
    for (const part of [
      calc.baseMinor,
      calc.feesMinor,
      calc.taxMinor,
      calc.operatorPayableMinor,
      calc.platformRevenueMinor,
    ]) {
      expect(part >= 0n).toBe(true);
    }
    // Rule 9: the terms the customer accepted are stored with the request.
    // (`version` here is the stored JSON's shape version, not the rule version.)
    expect(stored.cancellationTerms).toMatchObject({
      version: 1,
      acceptedAt: expect.any(String),
    });

    // Idempotent (rule 5): the same key answers the same, one booking.
    const repeat = await book(customer, body, key);
    expect(repeat.status()).toBe(201);
    expect((await repeat.json()).data.reference).toBe(created.reference);
    expect(await bookingsOf(offer.id)).toHaveLength(1);

    // A new key from the same customer is a duplicate request.
    const again = await book(customer, body);
    expect(again.status()).toBe(409);
    expect((await errorOf(again)).code).toBe('BOOKING_DUPLICATE');
    expect(await bookingsOf(offer.id)).toHaveLength(1);
  });

  test('refuses stale terms, a stale offer, a wrong price and missing acceptance', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { offer } = await liveOffer(contexts);
    const customer = await newCustomer(contexts);
    const body = await bodyFor(customer, offer);

    // Rule 9: no accepted terms version, or an old one, is not a request.
    const { cancellationTermsVersion: _terms, ...withoutTerms } = body;
    const noTerms = await book(customer, withoutTerms);
    expect(noTerms.status()).toBe(400);
    expect((await errorOf(noTerms)).code).toBe('VALIDATION_ERROR');
    const oldTerms = await book(customer, {
      ...body,
      cancellationTermsVersion: Number(body.cancellationTermsVersion) + 1000,
    });
    expect(oldTerms.status()).toBe(409);
    expect((await errorOf(oldTerms)).code).toBe('BOOKING_TERMS_CHANGED');

    const { offerUpdatedAt: _updated, ...withoutVersion } = body;
    expect((await book(customer, withoutVersion)).status()).toBe(400);

    // A wrong expected price answers with the current one.
    const price = await book(customer, {
      ...body,
      expectedTotalMinor: PRICE - 1,
    });
    expect(price.status()).toBe(409);
    const priceError = await errorOf(price);
    expect(priceError.code).toBe('BOOKING_PRICE_CHANGED');
    expect(priceError.details).toContainEqual({
      field: 'totalMinor',
      issue: String(PRICE),
    });
    expect(priceError.details).toContainEqual({
      field: 'priceType',
      issue: 'QUOTE',
    });

    // The operator changes a term but not the price: the offer's version
    // moved, so the customer reads it again; no price in the details.
    const patch = await request.patch(`operator/empty-legs/${offer.id}`, {
      headers: await csrfHeaders(request),
      data: { seatsAvailable: 5 },
    });
    expect(patch.status()).toBe(200);
    const stale = await book(customer, body);
    expect(stale.status()).toBe(409);
    const staleError = await errorOf(stale);
    expect(staleError.code).toBe('BOOKING_PRICE_CHANGED');
    const fields = (staleError.details ?? []).map((d) => d.field);
    expect(fields).toContain('offerUpdatedAt');
    expect(fields).not.toContain('totalMinor');
    expect(await bookingsOf(offer.id)).toHaveLength(0);

    // Re-read, then more seats than the offer has is a validation error.
    const fresh = await bodyFor(customer, offer);
    const tooMany = await book(customer, { ...fresh, passengerCount: 6 });
    expect(tooMany.status()).toBe(400);
    expect((await book(customer, fresh)).status()).toBe(201);
  });

  test('only a customer, and only a listed offer from an approved operator, can be booked (rule 4)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const customer = await newCustomer(contexts);
    // Each offer has an operator of its own (one registration per context).
    const operator = async () => ({
      request: await playwright.request.newContext({ baseURL }),
      playwright,
      baseURL,
    });

    // The operator cannot book, and a signed-out caller is refused.
    const live = await liveOffer(contexts);
    const body = await bodyFor(customer, live.offer);
    expect((await book(request, body)).status()).toBe(403);
    const anonymous = await playwright.request.newContext({ baseURL });
    const signedOut = await anonymous.post('bookings/empty-leg', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: body,
    });
    expect(signedOut.status()).toBe(401);

    // Withdrawn.
    const withdrawer = await operator();
    const withdrawn = await liveOffer(withdrawer);
    const withdrawnBody = await bodyFor(customer, withdrawn.offer);
    expect(
      (
        await withdrawer.request.post(
          `operator/empty-legs/${withdrawn.offer.id}/withdraw`,
          {
            headers: await csrfHeaders(withdrawer.request),
          },
        )
      ).status(),
    ).toBe(200);
    const w = await book(customer, withdrawnBody);
    expect(w.status()).toBe(409);
    expect((await errorOf(w)).code).toBe('BOOKING_UNAVAILABLE');

    // Expired.
    const expired = await liveOffer(await operator());
    const expiredBody = await bodyFor(customer, expired.offer);
    await withPrisma((prisma) =>
      prisma.emptyLeg.update({
        where: { id: expired.offer.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );
    const e = await book(customer, expiredBody);
    expect(e.status()).toBe(409);
    expect((await errorOf(e)).code).toBe('BOOKING_UNAVAILABLE');

    // Not published (a draft).
    const draft = await liveOffer(await operator());
    const draftBody = await bodyFor(customer, draft.offer);
    await withPrisma((prisma) =>
      prisma.emptyLeg.update({
        where: { id: draft.offer.id },
        data: { status: 'DRAFT' },
      }),
    );
    const d = await book(customer, draftBody);
    expect(d.status()).toBe(409);
    expect((await errorOf(d)).code).toBe('BOOKING_UNAVAILABLE');

    // An operator that is no longer approved.
    const suspended = await liveOffer(await operator());
    const suspendedBody = await bodyFor(customer, suspended.offer);
    await withPrisma(async (prisma) => {
      const row = await prisma.emptyLeg.findUniqueOrThrow({
        where: { id: suspended.offer.id },
      });
      await prisma.operator.update({
        where: { id: row.operatorId },
        data: { status: 'SUSPENDED' },
      });
    });
    const s = await book(customer, suspendedBody);
    expect(s.status()).toBe(409);
    expect((await errorOf(s)).code).toBe('BOOKING_UNAVAILABLE');

    for (const offer of [
      withdrawn.offer,
      expired.offer,
      draft.offer,
      suspended.offer,
    ]) {
      expect(await bookingsOf(offer.id)).toHaveLength(0);
    }
  });

  test('a second customer cannot book an offer while the first request is live', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { offer } = await liveOffer(contexts);
    const first = await newCustomer(contexts);
    const second = await newCustomer(contexts);
    const secondBody = await bodyFor(second, offer);
    expect((await book(first, await bodyFor(first, offer))).status()).toBe(201);

    const refused = await book(second, secondBody);
    expect(refused.status()).toBe(409);
    expect((await errorOf(refused)).code).toBe('BOOKING_UNAVAILABLE');
    expect(await bookingsOf(offer.id)).toHaveLength(1);
  });

  test('two concurrent requests for one offer make exactly one booking', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { offer } = await liveOffer(contexts);
    const a = await newCustomer(contexts);
    const b = await newCustomer(contexts);
    const bodies = [await bodyFor(a, offer), await bodyFor(b, offer)];

    const [ra, rb] = await Promise.all([
      book(a, bodies[0]),
      book(b, bodies[1]),
    ]);
    expect([ra.status(), rb.status()].sort((x, y) => x - y)).toEqual([
      201, 409,
    ]);
    const loser = ra.status() === 409 ? ra : rb;
    expect((await errorOf(loser)).code).toBe('BOOKING_UNAVAILABLE');
    expect(await bookingsOf(offer.id)).toHaveLength(1);
  });
});

test.describe('while the request is live', () => {
  test('the offer leaves the listing, and the operator cannot change any term or withdraw it (D-213)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { offer, trip, customer } = await requested(contexts);
    const anonymous = await playwright.request.newContext({ baseURL });

    expect(await listedIds(anonymous, trip.goa)).not.toContain(offer.id);
    expect((await anonymous.get(`empty-legs/${offer.id}`)).status()).toBe(404);
    expect((await customer.get(`empty-legs/${offer.id}`)).status()).toBe(404);
    expect((await operatorOffer(request, offer.id)).hasLiveRequest).toBe(true);

    const changes: [string, Record<string, unknown>][] = [
      ['priceMinor', { priceMinor: 15_000_000 }],
      ['departureFrom', { departureFrom: inDays(6, 5).toISOString() }],
      ['departureTo', { departureTo: inDays(6, 11).toISOString() }],
      ['seatsAvailable', { seatsAvailable: 3 }],
      ['conditions', { conditions: 'Changed after the request was sent.' }],
      ['validUntil', { validUntil: inDays(5, 6).toISOString() }],
      ['aircraftId', { aircraftId: randomUUID() }],
      ['originId', { originId: trip.mumbai }],
      ['destinationId', { destinationId: trip.goa }],
    ];
    for (const [field, data] of changes) {
      const response = await request.patch(`operator/empty-legs/${offer.id}`, {
        headers: await csrfHeaders(request),
        data,
      });
      expect(response.status(), field).toBe(409);
      const error = await errorOf(response);
      // A published offer's aircraft and route are locked in any case
      // (the lock answers first); every other term is held by the request.
      expect(error.code, field).toBe(
        ['aircraftId', 'originId', 'destinationId'].includes(field)
          ? 'EMPTY_LEG_FIELD_LOCKED'
          : 'EMPTY_LEG_HAS_LIVE_REQUEST',
      );
      expect(
        (error.details ?? []).map((d) => d.field),
        field,
      ).toContain(field);
    }
    const all = await request.patch(`operator/empty-legs/${offer.id}`, {
      headers: await csrfHeaders(request),
      data: Object.assign({}, ...changes.slice(0, 6).map(([, data]) => data)),
    });
    expect(all.status()).toBe(409);
    expect((await errorOf(all)).details).toHaveLength(6);

    const withdraw = await request.post(
      `operator/empty-legs/${offer.id}/withdraw`,
      { headers: await csrfHeaders(request) },
    );
    expect(withdraw.status()).toBe(409);
    expect((await errorOf(withdraw)).code).toBe('EMPTY_LEG_HAS_LIVE_REQUEST');
    expect((await operatorOffer(request, offer.id)).status).toBe('PUBLISHED');
  });

  test('the operator team is told of the request, as for a charter request', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference } = await requested(contexts);
    const dispatched = await request.post('dev/jobs/notification-outbox', {
      headers: await csrfHeaders(request),
    });
    expect(dispatched.status()).toBe(200);

    const email = (await (await request.get('me')).json()).data.email as string;
    const mail = (await outbox(request, email)).find(
      (m) => m.channel === 'EMAIL' && m.body.includes(reference),
    );
    expect(mail, 'email to the operator').toBeTruthy();
    expect(mail!.body).toContain(`/operator/requests/${reference}`);
    const inApp = await request.get('me/notifications', {
      params: { pageSize: 100 },
    });
    expect(
      (
        (await inApp.json()).data as { templateKey: string; href: string }[]
      ).some(
        (n) =>
          n.templateKey === 'booking.requested' &&
          n.href === `/operator/requests/${reference}`,
      ),
    ).toBe(true);
  });
});

test.describe('when the request ends or is confirmed', () => {
  test('a cancelled request lists the offer again and frees it to edit and to book', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { offer, trip, customer, reference } = await requested(contexts);
    const anonymous = await playwright.request.newContext({ baseURL });
    expect(await listedIds(anonymous, trip.goa)).not.toContain(offer.id);

    const quote = await customer.get(
      `bookings/${reference}/cancellation-quote`,
    );
    expect(quote.status()).toBe(200);
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

    expect(await listedIds(anonymous, trip.goa)).toContain(offer.id);
    expect((await anonymous.get(`empty-legs/${offer.id}`)).status()).toBe(200);
    expect((await operatorOffer(request, offer.id)).hasLiveRequest).toBe(false);
    const edited = await request.patch(`operator/empty-legs/${offer.id}`, {
      headers: await csrfHeaders(request),
      data: { priceMinor: 17_000_000 },
    });
    expect(edited.status()).toBe(200);

    // Another customer can now request it, at the new price.
    const other = await newCustomer(contexts);
    const rebooked = await book(other, await bodyFor(other, offer));
    expect(rebooked.status()).toBe(201);
    expect((await rebooked.json()).data.price.amountMinor).toBe(17_000_000);
  });

  test('once the operator accepts and the booking is confirmed the offer is BOOKED and never listed', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { offer, trip, reference } = await requested(contexts);

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
    expect((await accepted.json()).data).toMatchObject({
      status: 'AWAITING_PAYMENT',
      price: { priceType: 'CONFIRMED', amountMinor: PRICE },
    });
    expect((await operatorOffer(request, offer.id)).status).toBe('PUBLISHED');

    // Staff confirm with a reason, standing in for the payment path.
    const ops = await playwright.request.newContext({ baseURL });
    await signIn(ops, 'ops');
    const confirmed = await ops.patch(`admin/bookings/${reference}/status`, {
      headers: await csrfHeaders(ops),
      data: { status: 'CONFIRMED', reason: 'Paid offline, test of the sale' },
    });
    expect(confirmed.status()).toBe(200);

    expect((await operatorOffer(request, offer.id)).status).toBe('BOOKED');
    const anonymous = await playwright.request.newContext({ baseURL });
    expect(await listedIds(anonymous, trip.goa)).not.toContain(offer.id);
    expect((await anonymous.get(`empty-legs/${offer.id}`)).status()).toBe(404);
    const withdraw = await request.post(
      `operator/empty-legs/${offer.id}/withdraw`,
      { headers: await csrfHeaders(request) },
    );
    expect(withdraw.status()).toBe(409);
  });
});
