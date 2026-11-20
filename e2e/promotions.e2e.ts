import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, locationId, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';
import type { AccountName } from './support/accounts.js';

/**
 * M10 (W4-7): promotion codes (finance manages them, customers preview and
 * book with them, caps hold), the manual price override (a new quote with a
 * reason), and the internal read of an operator's pricing inputs.
 */

type Contexts = Parameters<typeof listedJet>[0];
type Trip = Awaited<ReturnType<typeof listedJet>>;

const CONDITIONS = {
  summary: 'Free cancellation until 72 hours before departure; 50% after.',
  charges: [
    { minHoursBeforeDeparture: 72, chargePercent: 0 },
    { minHoursBeforeDeparture: 0, chargePercent: 50 },
  ],
  inclusions: ['Crew'],
  exclusions: [],
};

async function as(contexts: Contexts, account: AccountName) {
  const context = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await signIn(context, account);
  return context;
}

async function newCustomer(contexts: Contexts) {
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await registerCustomer(customer);
  return customer;
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

/** Another operator's context, for a second aircraft in one test. */
async function anotherOperator(contexts: Contexts): Promise<Contexts> {
  const request = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  return { ...contexts, request };
}

/** A priced jet on `contexts.request` (its operator) and a search for it. */
async function pricedTrip(contexts: Contexts) {
  const trip = await listedJet(contexts);
  await setRate(contexts.request, trip);
  return { trip, searched: await searchFor(contexts.request, trip) };
}

function uniqueCode(prefix = 'T') {
  return `${prefix}${randomUUID().replace(/-/g, '').slice(0, 10)}`.toUpperCase();
}

function promotionBody(overrides: Record<string, unknown> = {}) {
  return {
    code: uniqueCode(),
    name: 'Test offer',
    kind: 'PERCENT',
    percent: 5,
    currency: 'INR',
    startsAt: new Date(Date.now() - 60_000).toISOString(),
    endsAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
    reason: 'Winter campaign',
    ...overrides,
  };
}

async function createPromotion(
  finance: APIRequestContext,
  overrides: Record<string, unknown> = {},
) {
  const response = await post(
    finance,
    'admin/promotions',
    promotionBody(overrides),
  );
  expect(response.status()).toBe(201);
  return (await response.json()).data as {
    id: string;
    code: string;
    status: string;
  };
}

async function preview(
  context: APIRequestContext,
  searched: { searchId: string; result: { resultId: string } },
  code: string,
) {
  return post(
    context,
    `search/${searched.searchId}/results/${searched.result.resultId}/promo-code`,
    { code },
  );
}

async function book(
  customer: APIRequestContext,
  searched: { searchId: string; result: { resultId: string } },
  expectedTotalMinor: number,
  promoCode?: string,
) {
  return post(
    customer,
    'bookings',
    {
      searchId: searched.searchId,
      resultId: searched.result.resultId,
      currency: 'INR',
      expectedTotalMinor,
      ...(promoCode ? { promoCode } : {}),
    },
    randomUUID(),
  );
}

test.describe('promotions: finance manages codes', () => {
  test('finance creates, lists and ends a code; each is audited', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const finance = await as(contexts, 'finance');
    const code = uniqueCode('win-');
    const created = await createPromotion(finance, {
      code: code.toLowerCase(),
      kind: 'FIXED',
      percent: undefined,
      amountMinor: 50_000,
      maxUses: 10,
      maxUsesPerCustomer: 1,
    });
    expect(created).toMatchObject({
      code,
      status: 'ACTIVE',
      kind: 'FIXED',
      amountMinor: 50_000,
      percent: null,
      uses: 0,
      endable: true,
    });

    const list = await finance.get('admin/promotions', {
      params: { status: 'ACTIVE', pageSize: 100 },
    });
    expect(list.status()).toBe(200);
    expect((await list.json()).data.map((p: { id: string }) => p.id)).toContain(
      created.id,
    );

    const duplicate = await post(
      finance,
      'admin/promotions',
      promotionBody({ code }),
    );
    expect(duplicate.status()).toBe(409);
    expect((await duplicate.json()).error.code).toBe('PROMOTION_CODE_EXISTS');

    const ended = await post(finance, `admin/promotions/${created.id}/end`, {
      reason: 'Budget used',
    });
    expect(ended.status()).toBe(200);
    expect((await ended.json()).data).toMatchObject({
      status: 'ENDED',
      endable: false,
    });
    const again = await post(finance, `admin/promotions/${created.id}/end`, {
      reason: 'Budget used',
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('PROMOTION_ENDED');

    const logs = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityType: 'Promotion', entityId: created.id },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(logs.map((log) => [log.action, log.reason])).toEqual([
      ['promotion.create', 'Winter campaign'],
      ['promotion.end', 'Budget used'],
    ]);

    // Operations see that it happened, not its terms.
    const ops = await as(contexts, 'ops');
    const opsLog = await ops.get('admin/audit-logs', {
      params: { entityType: 'Promotion', entityId: created.id },
    });
    expect(opsLog.status()).toBe(200);
    for (const row of (await opsLog.json()).data) {
      expect(row.after).toBeNull();
      expect(row.reason).toBeNull();
    }
  });

  test('refuses other roles, mixed values and half a route', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    for (const account of ['ops', 'customer', 'operatorAdmin'] as const) {
      const other = await as(contexts, account);
      expect((await other.get('admin/promotions')).status()).toBe(403);
      expect(
        (await post(other, 'admin/promotions', promotionBody())).status(),
      ).toBe(403);
    }
    const anonymous = await playwright.request.newContext({ baseURL });
    expect((await anonymous.get('admin/promotions')).status()).toBe(401);

    const finance = await as(contexts, 'finance');
    const mumbai = await locationId(finance, 'BOM');
    for (const body of [
      promotionBody({ amountMinor: 50_000 }), // PERCENT with an amount
      promotionBody({ percent: 100.5 }),
      promotionBody({ percent: 5.123 }),
      promotionBody({ kind: 'FIXED', amountMinor: 50_000 }), // and a percent
      promotionBody({ originId: mumbai }),
      promotionBody({ code: 'A B' }),
      promotionBody({ endsAt: new Date(Date.now() - 1000).toISOString() }),
      promotionBody({ reason: '' }),
    ]) {
      const response = await post(finance, 'admin/promotions', body);
      expect(response.status(), JSON.stringify(body)).toBe(400);
    }
  });
});

test.describe('promotions: customers use a code', () => {
  test('a code lowers the estimate as its own line, and the booking keeps it', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const finance = await as(contexts, 'finance');
    const promotion = await createPromotion(finance, {
      name: 'Winter offer',
      category: 'PRIVATE_CHARTER',
    });
    const { searched } = await pricedTrip(contexts);
    const before = searched.result.price.amountMinor as number;

    // Public: anyone can preview, in any case.
    const anonymous = await playwright.request.newContext({ baseURL });
    const previewed = await preview(
      anonymous,
      searched,
      promotion.code.toLowerCase(),
    );
    expect(previewed.status()).toBe(200);
    const body = (await previewed.json()).data;
    expect(body).toMatchObject({
      code: promotion.code,
      name: 'Winter offer',
      price: { priceType: 'ESTIMATE', currency: 'INR' },
    });
    expect(body.amountOffMinor).toBeGreaterThan(0);
    expect(body.price.amountMinor).toBeLessThan(before);
    const line = body.breakdown.find(
      (entry: { code: string }) => entry.code === 'PROMOTION',
    );
    expect(line).toEqual({
      code: 'PROMOTION',
      label: 'Winter offer',
      amountMinor: -body.amountOffMinor,
    });
    // Customer lines never carry the basis.
    expect(JSON.stringify(body.breakdown)).not.toContain('basis');

    const customer = await newCustomer(contexts);
    const booked = await book(
      customer,
      searched,
      body.price.amountMinor,
      promotion.code,
    );
    expect(booked.status()).toBe(201);
    const created = (await booked.json()).data;
    expect(created.price).toMatchObject({
      priceType: 'ESTIMATE',
      amountMinor: body.price.amountMinor,
    });

    const stored = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference: created.reference },
        include: { calculation: true },
      });
      const redemptions = await prisma.promotionRedemption.findMany({
        where: { bookingId: booking.id },
      });
      return { booking, redemptions };
    });
    expect(stored.redemptions).toHaveLength(1);
    expect(stored.redemptions[0].promotionId).toBe(promotion.id);
    const calculation = stored.booking.calculation!;
    expect(calculation.appliedRules).toContainEqual(
      expect.objectContaining({ id: promotion.id, type: 'PROMOTION' }),
    );
    expect(
      (calculation.inputs as { promotion?: { code: string } }).promotion?.code,
    ).toBe(promotion.code);
    const lines = calculation.breakdown as { amountMinor: number }[];
    expect(lines.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(
      Number(calculation.totalMinor),
    );

    const listed = await finance.get('admin/promotions', {
      params: { pageSize: 100 },
    });
    expect(
      (await listed.json()).data.find(
        (p: { id: string }) => p.id === promotion.id,
      ).uses,
    ).toBe(1);
  });

  test('unknown, ended, not started, another category or route: clear refusals', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const finance = await as(contexts, 'finance');
    const { trip, searched } = await pricedTrip(contexts);
    const delhi = await locationId(finance, 'DEL');

    const expired = await createPromotion(finance);
    await post(finance, `admin/promotions/${expired.id}/end`, {
      reason: 'Withdrawn',
    });
    const later = await createPromotion(finance, {
      startsAt: new Date(Date.now() + 86_400_000).toISOString(),
    });
    const helicopter = await createPromotion(finance, {
      category: 'HELICOPTER',
    });
    const otherRoute = await createPromotion(finance, {
      originId: trip.mumbai,
      destinationId: delhi,
    });
    const thisRoute = await createPromotion(finance, {
      // Either direction.
      originId: trip.goa,
      destinationId: trip.mumbai,
    });

    for (const [code, error] of [
      ['NOSUCHCODE', 'PROMO_CODE_INVALID'],
      [later.code, 'PROMO_CODE_INVALID'],
      [expired.code, 'PROMO_CODE_EXPIRED'],
      [helicopter.code, 'PROMO_CODE_NOT_APPLICABLE'],
      [otherRoute.code, 'PROMO_CODE_NOT_APPLICABLE'],
    ]) {
      const response = await preview(request, searched, code);
      expect(response.status(), code).toBe(422);
      const body = await response.json();
      expect(body.error.code).toBe(error);
      expect(body.error.details).toEqual([
        { field: 'promoCode', issue: error },
      ]);
    }
    expect((await preview(request, searched, thisRoute.code)).status()).toBe(
      200,
    );

    // Booking with a refused code books nothing.
    const customer = await newCustomer(contexts);
    const refused = await book(
      customer,
      searched,
      searched.result.price.amountMinor,
      expired.code,
    );
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.code).toBe('PROMO_CODE_EXPIRED');
    const count = await withPrisma((prisma) =>
      prisma.booking.count({
        where: { aircraftId: trip.aircraftId },
      }),
    );
    expect(count).toBe(0);
  });

  test('caps: overall and per customer', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const finance = await as(contexts, 'finance');
    const once = await createPromotion(finance, { maxUses: 1 });
    const perCustomer = await createPromotion(finance, {
      maxUsesPerCustomer: 1,
    });

    // Overall: one booking uses it, then no one else may.
    const first = await pricedTrip(contexts);
    const total = async (searched: typeof first.searched, code: string) =>
      (await (await preview(request, searched, code)).json()).data.price
        .amountMinor as number;
    const customer = await newCustomer(contexts);
    expect(
      (
        await book(
          customer,
          first.searched,
          await total(first.searched, once.code),
          once.code,
        )
      ).status(),
    ).toBe(201);
    const second = await pricedTrip(await anotherOperator(contexts));
    const other = await newCustomer(contexts);
    const capped = await preview(other, second.searched, once.code);
    expect(capped.status()).toBe(422);
    expect((await capped.json()).error.code).toBe('PROMO_CODE_LIMIT_REACHED');

    // Per customer: the same customer is refused, another is not.
    expect(
      (
        await book(
          customer,
          second.searched,
          await total(second.searched, perCustomer.code),
          perCustomer.code,
        )
      ).status(),
    ).toBe(201);
    const third = await pricedTrip(await anotherOperator(contexts));
    const mine = await preview(customer, third.searched, perCustomer.code);
    expect(mine.status()).toBe(422);
    expect((await mine.json()).error.code).toBe('PROMO_CODE_LIMIT_REACHED');
    const refused = await book(
      customer,
      third.searched,
      third.searched.result.price.amountMinor,
      perCustomer.code,
    );
    expect(refused.status()).toBe(422);
    expect(
      (await preview(other, third.searched, perCustomer.code)).status(),
    ).toBe(200);
  });
});

test.describe('price override', () => {
  async function requested(contexts: Contexts) {
    const { trip, searched } = await pricedTrip(contexts);
    const customer = await newCustomer(contexts);
    const response = await book(
      customer,
      searched,
      searched.result.price.amountMinor,
    );
    expect(response.status()).toBe(201);
    const created = (await response.json()).data;
    expect(created.status).toBe('OPERATOR_PENDING');
    return { trip, customer, reference: created.reference as string };
  }

  test('finance sets a new price with a reason: a new quote and calculation, audited', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts);
    const finance = await as(contexts, 'finance');

    // No quote yet to carry conditions from.
    const bare = await post(
      finance,
      `admin/bookings/${reference}/price-override`,
      { totalMinor: 40_000_000, currency: 'INR', reason: 'Goodwill' },
    );
    expect(bare.status()).toBe(400);
    expect(
      (
        await post(finance, `admin/bookings/${reference}/price-override`, {
          totalMinor: 40_000_000,
          currency: 'INR',
          conditions: CONDITIONS,
        })
      ).status(),
    ).toBe(400);

    const overridden = await post(
      finance,
      `admin/bookings/${reference}/price-override`,
      {
        totalMinor: 40_000_000,
        currency: 'INR',
        reason: 'Goodwill after a delay',
        conditions: CONDITIONS,
      },
    );
    expect(overridden.status()).toBe(200);
    const quote = (await overridden.json()).data;
    expect(quote).toMatchObject({
      bookingReference: reference,
      status: 'SENT',
      open: true,
      price: { priceType: 'QUOTE', amountMinor: 40_000_000, currency: 'INR' },
      conditions: { summary: CONDITIONS.summary },
    });

    const stored = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
        include: { calculation: true },
      });
      const row = await prisma.quote.findUniqueOrThrow({
        where: { reference: quote.reference },
        include: { calculation: true },
      });
      const audit = await prisma.auditLog.findFirst({
        where: { entityId: booking.id, action: 'booking.price_override' },
      });
      return { booking, row, audit };
    });
    const original = stored.booking.calculation!;
    const copy = stored.row.calculation!;
    // A new calculation; the booking's own is untouched.
    expect(copy.id).not.toBe(original.id);
    expect(copy).toMatchObject({
      priceType: 'QUOTE',
      totalMinor: 40_000_000n,
      overrideReason: 'Goodwill after a delay',
      operatorPayableMinor: original.operatorPayableMinor,
    });
    expect(copy.overriddenById).toBeTruthy();
    expect(copy.platformRevenueMinor).toBe(
      original.platformRevenueMinor + (40_000_000n - original.totalMinor),
    );
    const lines = copy.breakdown as { code: string; amountMinor: number }[];
    expect(lines.at(-1)?.code).toBe('OVERRIDE');
    expect(lines.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(40_000_000);
    expect(stored.audit).toMatchObject({
      reason: 'Goodwill after a delay',
      before: expect.objectContaining({
        totalMinor: Number(original.totalMinor),
      }),
      after: expect.objectContaining({
        totalMinor: 40_000_000,
        priceType: 'QUOTE',
        quoteReference: quote.reference,
      }),
    });

    // The customer sees an ordinary quote, without the reason.
    const seen = await customer.get(`quotes/${quote.reference}`);
    expect(seen.status()).toBe(200);
    expect(JSON.stringify(await seen.json())).not.toContain('Goodwill');

    // The calculation viewer shows finance the reason.
    const viewer = await finance.get(`admin/price-calculations/${copy.id}`);
    expect((await viewer.json()).data.overrideReason).toBe(
      'Goodwill after a delay',
    );
  });

  test('operations override an operator quote: it is superseded, its conditions carried', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts);
    const operatorQuote = await post(
      request,
      `operator/booking-requests/${reference}/revise-quote`,
      { totalMinor: 61_000_000, currency: 'INR', conditions: CONDITIONS },
    );
    expect(operatorQuote.status()).toBe(201);
    const first = (await operatorQuote.json()).data;

    const ops = await as(contexts, 'ops');
    const overridden = await post(
      ops,
      `admin/bookings/${reference.toLowerCase()}/price-override`,
      { totalMinor: 58_000_000, currency: 'INR', reason: 'Matched a rival' },
    );
    expect(overridden.status()).toBe(200);
    const second = (await overridden.json()).data;
    expect(second.conditions).toEqual(first.conditions);

    const old = await customer.get(`quotes/${first.reference}`);
    expect((await old.json()).data.status).toBe('SUPERSEDED');

    // The customer accepts it; the price is now confirmed and final.
    const accepted = await post(
      customer,
      `quotes/${second.reference}/accept`,
      undefined,
      randomUUID(),
    );
    expect(accepted.status()).toBe(200);
    const booking = await customer.get(`bookings/${reference}`);
    expect((await booking.json()).data.price).toMatchObject({
      priceType: 'CONFIRMED',
      amountMinor: 58_000_000,
    });

    // Past the quote stage: no more overrides.
    const late = await post(ops, `admin/bookings/${reference}/price-override`, {
      totalMinor: 50_000_000,
      currency: 'INR',
      reason: 'Too late',
    });
    expect(late.status()).toBe(409);
    expect((await late.json()).error.code).toBe('BOOKING_INVALID_TRANSITION');
  });

  test('refuses other roles, unknown bookings and a missing reason', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await requested(contexts);
    const body = {
      totalMinor: 40_000_000,
      currency: 'INR',
      reason: 'Goodwill',
      conditions: CONDITIONS,
    };
    for (const other of [customer, request]) {
      const response = await post(
        other,
        `admin/bookings/${reference}/price-override`,
        body,
      );
      expect(response.status()).toBe(403);
    }
    const superAdmin = await as(contexts, 'superAdmin');
    expect(
      (
        await post(
          superAdmin,
          'admin/bookings/FLY-BK-ZZZZZZ/price-override',
          body,
        )
      ).status(),
    ).toBe(404);
    expect(
      (
        await post(superAdmin, `admin/bookings/${reference}/price-override`, {
          ...body,
          reason: 'x',
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await post(superAdmin, `admin/bookings/${reference}/price-override`, {
          ...body,
          totalMinor: 0,
        })
      ).status(),
    ).toBe(400);
    expect(
      (
        await post(
          superAdmin,
          `admin/bookings/${reference}/price-override`,
          body,
        )
      ).status(),
    ).toBe(200);
  });
});

test.describe('internal read of operator pricing', () => {
  test('operations, finance and super admins read rates; others cannot', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { trip } = await pricedTrip(contexts);
    const operatorId = await withPrisma(
      async (prisma) =>
        (
          await prisma.aircraft.findUniqueOrThrow({
            where: { id: trip.aircraftId },
          })
        ).operatorId,
    );
    for (const account of ['ops', 'finance', 'superAdmin'] as const) {
      const admin = await as(contexts, account);
      const response = await admin.get(`admin/operators/${operatorId}/pricing`);
      expect(response.status(), account).toBe(200);
      const body = (await response.json()).data;
      expect(body.operatorId).toBe(operatorId);
      expect(body.operator.currency).toBe('INR');
      expect(body.aircraftTotal).toBe(1);
      expect(body.aircraft[0]).toMatchObject({
        aircraftId: trip.aircraftId,
        hourlyRateMinor: 18_000_000,
        pricingModel: 'HOURLY',
      });
    }
    const customer = await as(contexts, 'customer');
    expect(
      (await customer.get(`admin/operators/${operatorId}/pricing`)).status(),
    ).toBe(403);
    expect(
      (await request.get(`admin/operators/${operatorId}/pricing`)).status(),
    ).toBe(403);
    const finance = await as(contexts, 'finance');
    expect(
      (await finance.get(`admin/operators/${randomUUID()}/pricing`)).status(),
    ).toBe(404);
  });
});
