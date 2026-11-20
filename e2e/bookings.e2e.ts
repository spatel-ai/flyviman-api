import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { isEncrypted } from '../src/common/crypto/field-cipher.js';
import { STRICT_BASE_URL } from './support/accounts.js';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';
import { asVisitor, visitorAddress } from './support/visitor.js';

/** Booking requests from a charter search result (M8, W2-5). */

type Trip = Awaited<ReturnType<typeof listedJet>>;
type Contexts = Parameters<typeof listedJet>[0];

const PASSENGER = {
  firstName: 'Kavya',
  lastName: 'Ramaswamy',
  dateOfBirth: '1990-04-12',
  gender: 'FEMALE',
  nationality: 'IN',
  documentType: 'PASSPORT',
  documentNumber: 'P1234567',
  documentExpiry: '2031-01-31',
  specialAssistance: 'Wheelchair to the aircraft',
};

async function setRate(
  operator: APIRequestContext,
  trip: Trip,
  hourlyRateMinor: number,
) {
  const response = await operator.put(
    `operator/aircraft/${trip.aircraftId}/pricing`,
    {
      headers: await csrfHeaders(operator),
      data: {
        hourlyRateMinor,
        taxInclusive: false,
        commissionInclusive: false,
        minBillableHours: null,
      },
    },
  );
  expect(response.status()).toBe(200);
}

/** An approved, priced jet on `request` (signed in as its operator). */
async function pricedJet(contexts: Contexts): Promise<Trip> {
  const trip = await listedJet(contexts);
  await setRate(contexts.request, trip, 18_000_000);
  return trip;
}

/** A newly registered customer in a context of their own. */
async function newCustomer(contexts: Contexts) {
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  const { id } = await registerCustomer(customer);
  return { customer, userId: id };
}

async function savePassenger(customer: APIRequestContext) {
  const response = await customer.post('me/passengers', {
    headers: await csrfHeaders(customer),
    data: PASSENGER,
  });
  expect(response.status()).toBe(201);
  return (await response.json()).data.id as string;
}

async function book(
  customer: APIRequestContext,
  data: Record<string, unknown>,
  key: string = randomUUID(),
) {
  return customer.post('bookings', {
    headers: { ...(await csrfHeaders(customer)), 'Idempotency-Key': key },
    data,
  });
}

function bodyFor(
  searched: Awaited<ReturnType<typeof searchFor>>,
  extra: Record<string, unknown> = {},
) {
  return {
    searchId: searched.searchId,
    resultId: searched.result.resultId,
    expectedTotalMinor: searched.result.price.amountMinor,
    currency: 'INR',
    ...extra,
  };
}

test.describe('POST /bookings', () => {
  test('creates a request: rechecked, held, snapshotted, sent to the operator', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    const searched = await searchFor(request, trip);
    expect(searched.result.price.priceType).toBe('ESTIMATE');
    const { customer, userId } = await newCustomer(contexts);
    const passengerId = await savePassenger(customer);

    const response = await book(
      customer,
      bodyFor(searched, {
        passengerIds: [passengerId],
        specialRequests: 'Vegetarian meals',
      }),
    );
    expect(response.status()).toBe(201);
    const created = (await response.json()).data;
    expect(created).toEqual({
      reference: expect.stringMatching(/^FLY-BK-[2-9A-HJ-NP-Z]{6}$/),
      status: 'OPERATOR_PENDING',
      paymentStatus: 'UNPAID',
      price: {
        priceType: 'ESTIMATE',
        amountMinor: searched.result.price.amountMinor,
        currency: 'INR',
        validUntil: expect.any(String),
      },
      createdAt: expect.any(String),
    });
    // References and statuses only: nothing about the passengers.
    expect(JSON.stringify(created)).not.toContain(PASSENGER.lastName);

    const detail = await customer.get(`bookings/${created.reference}`);
    expect(detail.status()).toBe(200);
    const booking = (await detail.json()).data;
    const shown = (
      await (
        await customer.get(
          `search/${searched.searchId}/results/${searched.result.resultId}`,
        )
      ).json()
    ).data;
    expect(booking).toMatchObject({
      reference: created.reference,
      category: 'PRIVATE_CHARTER',
      status: 'OPERATOR_PENDING',
      paymentStatus: 'UNPAID',
      bookingMode: 'REQUEST',
      paymentModel: 'B_OPERATOR_CONFIRMED',
      price: created.price,
      itinerary: {
        version: 1,
        source: 'SEARCH',
        searchId: searched.searchId,
        resultId: searched.result.resultId,
        tripType: 'ONE_WAY',
        passengerCount: 2,
        legs: [{ originId: trip.mumbai, destinationId: trip.goa }],
        aircraft: { id: trip.aircraftId },
      },
      // The note the result showed, word for word (rule 9).
      cancellationTerms: {
        version: 1,
        source: 'PLATFORM',
        summary: shown.cancellationNote,
        charges: [],
      },
      specialRequests: 'Vegetarian meals',
      passengers: [
        {
          firstName: 'Kavya',
          lastName: 'Ramaswamy',
          dateOfBirth: '1990-04-12',
          documentType: 'PASSPORT',
          documentNumberLast4: '4567',
          specialAssistance: 'Wheelchair to the aircraft',
        },
      ],
    });
    expect(booking.passengers[0]).not.toHaveProperty('documentNumber');

    const stored = await withPrisma(async (prisma) => {
      const row = await prisma.booking.findUniqueOrThrow({
        where: { reference: created.reference },
        include: {
          passengers: true,
          events: { orderBy: { createdAt: 'asc' } },
          holds: true,
        },
      });
      const audits = await prisma.auditLog.findMany({
        where: { entityType: 'Booking', entityId: row.id },
        orderBy: { createdAt: 'asc' },
      });
      return { row, audits };
    });
    expect(stored.row.customerId).toBe(userId);
    expect(stored.row.calculationId).not.toBeNull();
    const [snapshot] = stored.row.passengers;
    expect(snapshot.passengerId).toBe(passengerId);
    expect(isEncrypted(snapshot.documentNumber!)).toBe(true);
    expect(isEncrypted(snapshot.specialAssistance!)).toBe(true);
    expect(isEncrypted(stored.row.specialRequests!)).toBe(true);
    // A soft hold on the aircraft for this booking, lapsing within 48 hours.
    expect(stored.row.holds).toHaveLength(1);
    const [hold] = stored.row.holds;
    expect(hold).toMatchObject({
      aircraftId: trip.aircraftId,
      reason: 'SOFT_HOLD',
    });
    expect(hold.expiresAt!.getTime()).toBeLessThanOrEqual(
      Date.now() + 48 * 3_600_000,
    );
    // Every transition has an event and an audit record.
    expect(
      stored.row.events.map((event) => [event.fromStatus, event.toStatus]),
    ).toEqual([
      [null, 'REQUESTED'],
      ['REQUESTED', 'OPERATOR_PENDING'],
    ]);
    expect(stored.audits.map((entry) => entry.action)).toEqual([
      'booking.create',
      'booking.status',
    ]);
    const trail = JSON.stringify([stored.audits, stored.row.events]);
    for (const secret of [
      'Kavya',
      'Ramaswamy',
      'P1234567',
      'Wheelchair',
      'Vegetarian',
    ]) {
      expect(trail).not.toContain(secret);
    }
  });

  test('a repeat with the same key returns the same booking, once', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    const searched = await searchFor(request, trip);
    const { customer, userId } = await newCustomer(contexts);
    const key = randomUUID();

    const first = await book(customer, bodyFor(searched), key);
    expect(first.status()).toBe(201);
    const again = await book(customer, bodyFor(searched), key);
    expect(again.status()).toBe(201);
    expect(again.headers()['idempotent-replayed']).toBe('true');
    expect((await again.json()).data).toEqual((await first.json()).data);

    const other = await book(
      customer,
      bodyFor(searched, { specialRequests: 'Different' }),
      key,
    );
    expect(other.status()).toBe(409);
    expect((await other.json()).error.code).toBe('IDEMPOTENCY_CONFLICT');

    const count = await withPrisma((prisma) =>
      prisma.booking.count({ where: { customerId: userId } }),
    );
    expect(count).toBe(1);
  });

  test('a changed price is refused with the new estimate, which can then be agreed to', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    const searched = await searchFor(request, trip);
    // The operator raises its rate after the customer searched.
    await setRate(request, trip, 24_000_000);
    const { customer, userId } = await newCustomer(contexts);

    const refused = await book(customer, bodyFor(searched));
    expect(refused.status()).toBe(409);
    const error = (await refused.json()).error;
    expect(error.code).toBe('BOOKING_PRICE_CHANGED');
    const details = Object.fromEntries(
      error.details.map((d: { field: string; issue: string }) => [
        d.field,
        d.issue,
      ]),
    );
    expect(details.currency).toBe('INR');
    expect(details.priceType).toBe('ESTIMATE');
    expect(Number.isNaN(Date.parse(details.validUntil))).toBe(false);
    const newTotal = Number(details.totalMinor);
    expect(newTotal).toBeGreaterThan(searched.result.price.amountMinor);
    expect(
      await withPrisma((prisma) =>
        prisma.booking.count({ where: { customerId: userId } }),
      ),
    ).toBe(0);

    const agreed = await book(
      customer,
      bodyFor(searched, { expectedTotalMinor: newTotal }),
    );
    expect(agreed.status()).toBe(201);
    expect((await agreed.json()).data.price.amountMinor).toBe(newTotal);
  });

  test('the held aircraft cannot be requested for the same time again', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    const searched = await searchFor(request, trip);
    const { customer: first } = await newCustomer(contexts);
    const { customer: second } = await newCustomer(contexts);

    expect((await book(first, bodyFor(searched))).status()).toBe(201);
    const late = await book(second, bodyFor(searched));
    expect(late.status()).toBe(409);
    expect((await late.json()).error.code).toBe('BOOKING_UNAVAILABLE');
    // The hold also takes it out of a fresh search (rule 4).
    const again = await searchFor(request, trip);
    expect(again.result).toBeUndefined();
    // And the operator cannot remove the booking's hold.
    const hold = await withPrisma((prisma) =>
      prisma.availabilityBlock.findFirstOrThrow({
        where: { aircraftId: trip.aircraftId, bookingId: { not: null } },
      }),
    );
    const removed = await request.delete(
      `operator/aircraft/${trip.aircraftId}/availability/blocks/${hold.id}`,
      { headers: await csrfHeaders(request) },
    );
    expect(removed.status()).toBe(409);
  });

  test('the same customer cannot request the same aircraft for the same time twice', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    const searched = await searchFor(request, trip);
    const { customer, userId } = await newCustomer(contexts);

    expect((await book(customer, bodyFor(searched))).status()).toBe(201);
    const again = await book(customer, bodyFor(searched));
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('BOOKING_DUPLICATE');

    // Still a duplicate once the hold has lapsed: the request is open.
    await withPrisma((prisma) =>
      prisma.availabilityBlock.updateMany({
        where: { booking: { customerId: userId } },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );
    const lapsed = await book(customer, bodyFor(searched));
    expect(lapsed.status()).toBe(409);
    expect((await lapsed.json()).error.code).toBe('BOOKING_DUPLICATE');
    expect(
      await withPrisma((prisma) =>
        prisma.booking.count({ where: { customerId: userId } }),
      ),
    ).toBe(1);
  });

  test('a customer may have at most 5 open requests', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    const searched = await searchFor(request, trip);
    const { customer, userId } = await newCustomer(contexts);
    const statuses = [
      'REQUESTED',
      'OPERATOR_PENDING',
      'OPERATOR_PENDING',
      'OPERATOR_PENDING',
      'OPERATOR_PENDING',
      // Answered or closed requests do not count.
      'CANCELLED',
      'OPERATOR_UNAVAILABLE',
    ] as const;
    const ids = await withPrisma((prisma) =>
      Promise.all(
        statuses.map(async (status) => {
          const row = await prisma.booking.create({
            data: {
              reference: `FLY-BK-${randomUUID().slice(0, 6).toUpperCase()}`,
              customerId: userId,
              status,
              category: 'PRIVATE_CHARTER',
              bookingMode: 'REQUEST',
              paymentModel: 'B_OPERATOR_CONFIRMED',
              itinerary: {},
              totalMinor: 1_000_000n,
              currency: 'INR',
              priceType: 'ESTIMATE',
              cancellationTerms: {},
            },
          });
          return row.id;
        }),
      ),
    );

    const refused = await book(customer, bodyFor(searched));
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe('BOOKING_LIMIT_REACHED');
    const held = await withPrisma((prisma) =>
      prisma.availabilityBlock.count({
        where: { aircraftId: trip.aircraftId, bookingId: { not: null } },
      }),
    );
    expect(held).toBe(0);

    // Once one is answered, there is room again.
    await withPrisma((prisma) =>
      prisma.booking.update({
        where: { id: ids[0] },
        data: { status: 'CANCELLED' },
      }),
    );
    expect((await book(customer, bodyFor(searched))).status()).toBe(201);
  });

  test('an operator’s calendar edit waits for the aircraft’s lock, like a hold', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    const headers = await csrfHeaders(request);
    const day = 24 * 3_600_000;
    const at = (days: number) =>
      new Date(Date.now() + days * day).toISOString();
    const key = `availability_hold:${trip.aircraftId}`;
    let block: Promise<Awaited<ReturnType<APIRequestContext['post']>>>;
    let slot: Promise<Awaited<ReturnType<APIRequestContext['post']>>>;
    await withPrisma((prisma) =>
      prisma.$transaction(
        async (tx) => {
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
          block = request.post(
            `operator/aircraft/${trip.aircraftId}/availability/blocks`,
            {
              headers,
              data: { startsAt: at(10), endsAt: at(11), reason: 'MAINTENANCE' },
            },
          );
          slot = request.post(
            `operator/aircraft/${trip.aircraftId}/availability/slots`,
            {
              headers,
              data: { startsAt: at(12), endsAt: at(13), kind: 'OPEN' },
            },
          );
          const settled = await Promise.race([
            Promise.any([block, slot]).then(() => 'answered'),
            new Promise((resolve) =>
              setTimeout(() => resolve('waiting'), 1500),
            ),
          ]);
          expect(settled).toBe('waiting');
        },
        { timeout: 20_000 },
      ),
    );
    expect((await block!).status()).toBe(201);
    expect((await slot!).status()).toBe(201);
  });

  test('refuses bad input, another customer’s passenger and other roles', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    const searched = await searchFor(request, trip);
    const { customer } = await newCustomer(contexts);
    const { customer: stranger } = await newCustomer(contexts);
    const theirs = await savePassenger(stranger);

    const noKey = await customer.post('bookings', {
      headers: await csrfHeaders(customer),
      data: bodyFor(searched),
    });
    expect(noKey.status()).toBe(400);

    const unknown = await book(
      customer,
      bodyFor(searched, { status: 'CONFIRMED' }),
    );
    expect(unknown.status()).toBe(400);
    expect((await unknown.json()).error.code).toBe('VALIDATION_ERROR');

    const tooMany = await book(
      customer,
      bodyFor(searched, {
        passengerIds: [randomUUID(), randomUUID(), randomUUID()],
      }),
    );
    expect(tooMany.status()).toBe(400);

    const notMine = await book(
      customer,
      bodyFor(searched, { passengerIds: [theirs] }),
    );
    expect(notMine.status()).toBe(404);

    const noResult = await book(
      customer,
      bodyFor(searched, { resultId: randomUUID() }),
    );
    expect(noResult.status()).toBe(404);

    // The operator who listed the aircraft is not a customer.
    const operator = await book(request, bodyFor(searched));
    expect(operator.status()).toBe(403);

    const anonymous = await playwright.request.newContext({ baseURL });
    const signedOut = await anonymous.post('bookings', {
      headers: { 'Idempotency-Key': randomUUID() },
      data: bodyFor(searched),
    });
    expect(signedOut.status()).toBe(401);
  });

  test('air ambulance is never instant, and an instant charter estimate still goes to the operator', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    // This operator books charter instantly (its own override, open decision 5).
    const operatorId = await withPrisma(async (prisma) => {
      const aircraft = await prisma.aircraft.findUniqueOrThrow({
        where: { id: trip.aircraftId },
      });
      await prisma.operator.update({
        where: { id: aircraft.operatorId },
        data: { bookingMode: { PRIVATE_CHARTER: 'INSTANT' } },
      });
      return aircraft.operatorId;
    });
    const searched = await searchFor(request, trip);
    const { customer } = await newCustomer(contexts);
    const response = await book(customer, bodyFor(searched));
    expect(response.status()).toBe(201);
    const created = (await response.json()).data;
    // An estimate needs the operator's price: never straight to payment.
    expect(created.status).toBe('OPERATOR_PENDING');
    const booking = (
      await (await customer.get(`bookings/${created.reference}`)).json()
    ).data;
    expect(booking.bookingMode).toBe('INSTANT');

    // The database refuses an instant air ambulance booking outright (rule 7).
    const refused = await withPrisma(async (prisma) => {
      const row = await prisma.booking.findUniqueOrThrow({
        where: { reference: created.reference },
      });
      return prisma.booking
        .create({
          data: {
            reference: `FLY-BK-${randomUUID().slice(0, 6).toUpperCase()}`,
            customerId: row.customerId,
            category: 'AIR_AMBULANCE',
            bookingMode: 'INSTANT',
            paymentModel: 'B_OPERATOR_CONFIRMED',
            operatorId,
            itinerary: row.itinerary as object,
            totalMinor: row.totalMinor,
            currency: 'INR',
            priceType: 'ESTIMATE',
            cancellationTerms: row.cancellationTerms as object,
          },
        })
        .then(
          () => 'created',
          (error: Error) => error.message,
        );
    });
    expect(refused).toContain('Booking_air_ambulance_not_instant');
  });
});

test.describe('POST /bookings rate limit', () => {
  test('one caller can send 10 booking requests in 10 minutes', async ({
    playwright,
  }) => {
    // The strict server runs the real limits. The limit is counted before
    // anything else, so a signed-out request with an empty body is enough;
    // a visitor address of its own keeps earlier runs out of the count.
    const request = await playwright.request.newContext({
      baseURL: STRICT_BASE_URL,
      extraHTTPHeaders: asVisitor(visitorAddress()),
    });
    const statuses: number[] = [];
    let blocked;
    for (let attempt = 0; attempt < 11; attempt += 1) {
      const response = await request.post('bookings', { data: {} });
      statuses.push(response.status());
      if (attempt === 0) {
        expect(response.headers()['ratelimit-limit-booking']).toBe('10');
      }
      if (response.status() === 429) {
        blocked = response;
        break;
      }
    }
    expect(statuses.slice(0, 10)).not.toContain(429);
    expect(blocked, `statuses: ${statuses.join(', ')}`).toBeDefined();
    expect((await blocked!.json()).error.code).toBe('RATE_LIMITED');
    expect(Number(blocked!.headers()['retry-after'])).toBeGreaterThan(0);
    await request.dispose();
  });
});

test.describe('GET /bookings/:reference', () => {
  test('is the owner’s alone: another customer and a malformed reference get 404', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await pricedJet(contexts);
    const searched = await searchFor(request, trip);
    const { customer } = await newCustomer(contexts);
    const created = (await (await book(customer, bodyFor(searched))).json())
      .data;

    const lower = await customer.get(
      `bookings/${created.reference.toLowerCase()}`,
    );
    expect(lower.status()).toBe(200);

    const { customer: stranger } = await newCustomer(contexts);
    const theirs = await stranger.get(`bookings/${created.reference}`);
    expect(theirs.status()).toBe(404);
    expect((await theirs.json()).error.code).toBe('NOT_FOUND');

    expect((await customer.get('bookings/not-a-reference')).status()).toBe(404);

    const ops = await playwright.request.newContext({ baseURL });
    await signIn(ops, 'ops');
    expect((await ops.get(`bookings/${created.reference}`)).status()).toBe(403);
  });
});
