import { expect, test } from '@playwright/test';
import { withPrisma } from './support/db.js';
import { approvedOperator } from './support/fleet.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/** Operator pricing inputs (M5 slices 2, 4b and 4c). */

type Line = { code: string; label: string; amountMinor: number };

/** The customer's detail of this aircraft's result, and its stored lines. */
async function priced(
  request: Parameters<typeof searchFor>[0],
  trip: Parameters<typeof searchFor>[1],
) {
  const { searchId, result } = await searchFor(request, trip);
  expect(result.price).toMatchObject({ priceType: 'ESTIMATE' });
  const detail = (
    await (
      await request.get(`search/${searchId}/results/${result.resultId}`)
    ).json()
  ).data;
  const stored = await withPrisma((prisma) =>
    prisma.priceCalculation.findFirstOrThrow({
      where: { searchId, aircraftId: trip.aircraftId },
      select: { breakdown: true },
    }),
  );
  const lines = detail.breakdown as Line[];
  expect(lines.reduce((sum, line) => sum + line.amountMinor, 0)).toBe(
    detail.price.amountMinor,
  );
  return {
    shown: (code: string) => lines.find((line) => line.code === code),
    stored: (code: string) =>
      (stored.breakdown as unknown as Line[]).find(
        (line) => line.code === code,
      ),
  };
}

const NO_DEFAULTS = {
  minBillableHours: null,
  positioningRateFactor: null,
  freeWithinKm: null,
  landingFallbackMinor: null,
  handlingFallbackMinor: null,
};

test.describe('operator pricing', () => {
  test('an aircraft rate turns "price on request" into an estimate, versioned and audited', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    const { aircraftId } = trip;
    const search = async () => (await searchFor(request, trip)).result;

    // No rate yet: offered, but on request.
    expect((await search()).price).toBeNull();
    const empty = await request.get(`operator/aircraft/${aircraftId}/pricing`);
    expect((await empty.json()).data).toMatchObject({
      hourlyRateMinor: null,
      currency: 'INR',
    });

    const body = {
      hourlyRateMinor: 18_000_000,
      taxInclusive: false,
      commissionInclusive: false,
      minBillableHours: 1.5,
    };
    const saved = await request.put(`operator/aircraft/${aircraftId}/pricing`, {
      headers: await csrfHeaders(request),
      data: body,
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).data).toMatchObject(body);
    const priced = await search();
    expect(priced.price).toMatchObject({ priceType: 'ESTIMATE' });

    // Saving the same values again writes nothing; a change is a new version.
    await request.put(`operator/aircraft/${aircraftId}/pricing`, {
      headers: await csrfHeaders(request),
      data: body,
    });
    await request.put(`operator/aircraft/${aircraftId}/pricing`, {
      headers: await csrfHeaders(request),
      data: { ...body, hourlyRateMinor: 20_000_000 },
    });
    const rates = await withPrisma((prisma) =>
      prisma.pricingRule.findMany({
        where: { scopeRef: aircraftId, type: 'HOURLY_RATE' },
        orderBy: { version: 'asc' },
      }),
    );
    expect(rates.map((rule) => [rule.version, rule.isActive])).toEqual([
      [1, false],
      [2, true],
    ]);
    const audits = await withPrisma((prisma) =>
      prisma.auditLog.count({
        where: {
          action: 'pricing_rule.change',
          entityId: { in: rates.map((rule) => rule.id) },
        },
      }),
    );
    expect(audits).toBe(2);
  });

  test('saves made at the same moment leave one rate in force', async ({
    request,
    playwright,
    baseURL,
  }) => {
    // A double click, or two tabs (security review M2): each save used to
    // close version 1 and create its own version 2.
    const { aircraftId } = await listedJet({ request, playwright, baseURL });
    const body = (hourlyRateMinor: number) => ({
      hourlyRateMinor,
      taxInclusive: false,
      commissionInclusive: false,
      minBillableHours: null,
    });
    const first = await request.put(`operator/aircraft/${aircraftId}/pricing`, {
      headers: await csrfHeaders(request),
      data: body(18_000_000),
    });
    expect(first.status()).toBe(200);

    const headers = await csrfHeaders(request);
    const answers = await Promise.all(
      [19_000_000, 21_000_000, 23_000_000].map((rate) =>
        request.put(`operator/aircraft/${aircraftId}/pricing`, {
          headers,
          data: body(rate),
        }),
      ),
    );
    for (const answer of answers) expect(answer.status()).toBe(200);

    const active = await withPrisma((prisma) =>
      prisma.pricingRule.findMany({
        where: { scopeRef: aircraftId, type: 'HOURLY_RATE', isActive: true },
      }),
    );
    expect(active).toHaveLength(1);
    expect(active[0].version).toBe(4);
    const read = await request.get(`operator/aircraft/${aircraftId}/pricing`);
    expect((await read.json()).data.hourlyRateMinor).toBe(
      (active[0].config as { amountMinor: number }).amountMinor,
    );
  });

  test('operator defaults are saved and read back; cleared values are removed', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await approvedOperator(request, playwright, baseURL);
    const defaults = {
      minBillableHours: 2,
      positioningRateFactor: 0.75,
      freeWithinKm: 40,
      landingFallbackMinor: 1_500_000,
      handlingFallbackMinor: 500_000,
    };
    const saved = await request.put('operator/pricing', {
      headers: await csrfHeaders(request),
      data: defaults,
    });
    expect(saved.status()).toBe(200);
    expect((await saved.json()).data).toMatchObject(defaults);

    const cleared = await request.put('operator/pricing', {
      headers: await csrfHeaders(request),
      data: { ...defaults, landingFallbackMinor: null },
    });
    expect((await cleared.json()).data.landingFallbackMinor).toBeNull();
    const read = await request.get('operator/pricing');
    expect((await read.json()).data).toMatchObject({
      ...defaults,
      landingFallbackMinor: null,
    });
  });

  test('round-trip charges left out keep what is stored; only null clears', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await approvedOperator(request, playwright, baseURL);
    const put = async (data: object) => {
      const response = await request.put('operator/pricing', {
        headers: await csrfHeaders(request),
        // The first five defaults are always sent; the round-trip four are optional.
        data: {
          minBillableHours: null,
          positioningRateFactor: null,
          freeWithinKm: null,
          landingFallbackMinor: null,
          handlingFallbackMinor: null,
          ...data,
        },
      });
      expect(response.status()).toBe(200);
      return (await response.json()).data;
    };
    expect(
      await put({
        waitingHourlyMinor: 1_000_000,
        waitingFreeHours: 2,
        overnightMinor: 3_000_000,
        crewNightMinor: 500_000,
      }),
    ).toMatchObject({
      waitingHourlyMinor: 1_000_000,
      waitingFreeHours: 2,
      overnightMinor: 3_000_000,
      crewNightMinor: 500_000,
    });
    // A new rate without free hours keeps the free hours.
    expect(await put({ waitingHourlyMinor: 1_200_000 })).toMatchObject({
      waitingHourlyMinor: 1_200_000,
      waitingFreeHours: 2,
      overnightMinor: 3_000_000,
      crewNightMinor: 500_000,
    });
    // Free hours alone keep the rate.
    expect(await put({ waitingFreeHours: 1.5 })).toMatchObject({
      waitingHourlyMinor: 1_200_000,
      waitingFreeHours: 1.5,
    });
    // Null free hours is 0; a null rate clears the charge; others stay.
    expect(
      await put({ waitingHourlyMinor: 1_200_000, waitingFreeHours: null }),
    ).toMatchObject({ waitingFreeHours: 0 });
    expect(
      await put({ waitingHourlyMinor: null, overnightMinor: null }),
    ).toMatchObject({
      waitingHourlyMinor: null,
      waitingFreeHours: null,
      overnightMinor: null,
      crewNightMinor: 500_000,
    });
  });

  test('trip charges and a per-day minimum reach the customer; left out keeps, null clears', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    const rate = await request.put(
      `operator/aircraft/${trip.aircraftId}/pricing`,
      {
        headers: await csrfHeaders(request),
        data: {
          hourlyRateMinor: 18_000_000,
          taxInclusive: false,
          commissionInclusive: false,
          minBillableHours: 3,
          minBillableHoursPer: 'DAY',
        },
      },
    );
    expect((await rate.json()).data).toMatchObject({
      minBillableHours: 3,
      minBillableHoursPer: 'DAY',
    });
    const put = async (data: object, status = 200) => {
      const response = await request.put('operator/pricing', {
        headers: await csrfHeaders(request),
        data: { ...NO_DEFAULTS, ...data },
      });
      expect(response.status()).toBe(status);
      return await response.json();
    };
    expect(
      (
        await put({
          fuelSurchargePerFlightMinor: 500_000,
          permitPerFlightMinor: 200_000,
          navigationPerFlightMinor: 100_000,
          otherChargeMinor: 300_000,
          otherChargeLabel: 'Catering',
        })
      ).data,
    ).toMatchObject({
      fuelSurchargePerFlightMinor: 500_000,
      permitPerFlightMinor: 200_000,
      navigationPerFlightMinor: 100_000,
      otherChargeMinor: 300_000,
      otherChargeLabel: 'Catering',
      minBillableHoursPer: null,
    });
    // A new name alone keeps every amount.
    expect(
      (await put({ otherChargeLabel: 'Ground transport' })).data,
    ).toMatchObject({
      fuelSurchargePerFlightMinor: 500_000,
      otherChargeMinor: 300_000,
      otherChargeLabel: 'Ground transport',
    });

    const { shown, stored } = await priced(request, trip);
    expect(shown('FUEL_SURCHARGE')?.amountMinor).toBe(500_000);
    expect(shown('PERMIT')?.amountMinor).toBe(200_000);
    expect(shown('NAVIGATION')?.amountMinor).toBe(100_000);
    expect(shown('OTHER')).toMatchObject({
      label: 'Ground transport',
      amountMinor: 300_000,
    });
    // Under 3 h flown: the day's shortfall is stored, and part of Flying.
    const shortfall = stored('MIN_BILLABLE');
    expect(shortfall?.amountMinor).toBeGreaterThan(0);
    expect(shown('MIN_BILLABLE')).toBeUndefined();
    // 3 h billed for the day; Flying also holds the return to base.
    expect(stored('OPERATING')!.amountMinor + shortfall!.amountMinor).toBe(
      54_000_000,
    );
    expect(shown('FLYING')?.amountMinor).toBe(
      ['OPERATING', 'MIN_BILLABLE', 'POSITIONING', 'REPOSITIONING'].reduce(
        (sum, code) => sum + (stored(code)?.amountMinor ?? 0),
        0,
      ),
    );

    // Null clears; the rest stay.
    expect(
      (await put({ fuelSurchargePerFlightMinor: null, otherChargeMinor: null }))
        .data,
    ).toMatchObject({
      fuelSurchargePerFlightMinor: null,
      permitPerFlightMinor: 200_000,
      otherChargeMinor: null,
      otherChargeLabel: null,
    });
    // A new other charge needs a name; a name must be one plain line.
    const nameless = await put({ otherChargeMinor: 1_000 }, 400);
    expect(nameless.error.details[0].field).toBe('otherChargeLabel');
    const hidden = await put(
      { otherChargeMinor: 1_000, otherChargeLabel: 'Cater\u202eing' },
      400,
    );
    expect(hidden.error.details[0].field).toBe('otherChargeLabel');
  });

  test('sector and fixed-route aircraft are priced by their own rate; routes are checked', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    const { aircraftId, mumbai, goa } = trip;
    const model = (pricingModel: 'SECTOR' | 'FIXED_ROUTE') =>
      withPrisma((prisma) =>
        prisma.aircraft.update({
          where: { id: aircraftId },
          data: { pricingModel },
        }),
      );
    const put = async (data: object, status = 200) => {
      const response = await request.put(
        `operator/aircraft/${aircraftId}/pricing`,
        {
          headers: await csrfHeaders(request),
          data: {
            hourlyRateMinor: null,
            taxInclusive: false,
            commissionInclusive: false,
            minBillableHours: null,
            ...data,
          },
        },
      );
      expect(response.status()).toBe(status);
      return await response.json();
    };

    await model('SECTOR');
    expect((await put({ sectorRateMinor: 25_000_000 })).data).toMatchObject({
      sectorRateMinor: 25_000_000,
      fixedRoutes: [],
    });
    // No hourly rate: the flight is the sector rate; positioning is excluded.
    const sector = await priced(request, trip);
    expect(sector.stored('OPERATING')?.amountMinor).toBe(25_000_000);
    expect(sector.shown('FLYING')?.amountMinor).toBe(25_000_000);

    // The flags cover every rate: a sector rate left out is kept under them.
    expect((await put({ taxInclusive: true })).data).toMatchObject({
      sectorRateMinor: 25_000_000,
      taxInclusive: true,
    });
    const sectorRules = await withPrisma((prisma) =>
      prisma.pricingRule.findMany({
        where: { scopeRef: aircraftId, type: 'SECTOR_RATE', isActive: true },
      }),
    );
    expect(sectorRules.map((rule) => rule.config)).toEqual([
      {
        amountMinor: 25_000_000,
        currency: 'INR',
        taxInclusive: true,
        commissionInclusive: false,
      },
    ]);

    await model('FIXED_ROUTE');
    const routes = await put({
      fixedRoutes: [
        { originId: goa, destinationId: mumbai, amountMinor: 30_000_000 },
      ],
    });
    expect(routes.data.fixedRoutes).toEqual([
      {
        originId: goa,
        destinationId: mumbai,
        amountMinor: 30_000_000,
        originName: expect.stringMatching(/Dabolim/),
        destinationName: expect.stringMatching(/Chhatrapati Shivaji/),
      },
    ]);
    expect(routes.data.sectorRateMinor).toBe(25_000_000);
    // Listed Goa to Mumbai, priced Mumbai to Goa: either direction.
    const fixed = await priced(request, trip);
    expect(fixed.stored('OPERATING')?.amountMinor).toBe(30_000_000);

    const unknown = '00000000-0000-4000-8000-000000000000';
    const refused = await put(
      {
        fixedRoutes: [
          { originId: mumbai, destinationId: goa, amountMinor: 1_000 },
          { originId: goa, destinationId: mumbai, amountMinor: 1_000 },
          { originId: goa, destinationId: goa, amountMinor: 1_000 },
          { originId: unknown, destinationId: goa, amountMinor: 1_000 },
        ],
      },
      400,
    );
    expect(
      refused.error.details.map((detail: { field: string }) => detail.field),
    ).toEqual([
      'fixedRoutes[1]',
      'fixedRoutes[2].destinationId',
      'fixedRoutes[3].originId',
    ]);
    const tooMany = await put(
      {
        fixedRoutes: Array.from({ length: 51 }, () => ({
          originId: mumbai,
          destinationId: goa,
          amountMinor: 1_000,
        })),
      },
      400,
    );
    expect(tooMany.error.details[0].field).toBe('fixedRoutes');

    // An empty list clears the routes; the sector rate stays.
    expect((await put({ fixedRoutes: [] })).data).toMatchObject({
      fixedRoutes: [],
      sectorRateMinor: 25_000_000,
    });
    expect(
      (await put({ sectorRateMinor: null })).data.sectorRateMinor,
    ).toBeNull();
  });

  test('only the operator administrator, only for their own aircraft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { aircraftId } = await listedJet({ request, playwright, baseURL });

    // Another approved operator cannot see or set it.
    const other = await playwright.request.newContext({ baseURL });
    await approvedOperator(other, playwright, baseURL);
    const foreign = await other.get(`operator/aircraft/${aircraftId}/pricing`);
    expect(foreign.status()).toBe(404);
    await other.dispose();

    // A customer has no access at all.
    const customer = await playwright.request.newContext({ baseURL });
    await signIn(customer, 'customer');
    expect((await customer.get('operator/pricing')).status()).toBe(403);
    await customer.dispose();

    // Nonsense values are refused field by field.
    const bad = await request.put(`operator/aircraft/${aircraftId}/pricing`, {
      headers: await csrfHeaders(request),
      data: {
        hourlyRateMinor: -5,
        taxInclusive: 'yes',
        commissionInclusive: false,
        minBillableHours: null,
      },
    });
    expect(bad.status()).toBe(400);
    const fields = (await bad.json()).error.details.map(
      (detail: { field: string }) => detail.field,
    );
    expect(fields).toEqual(
      expect.arrayContaining(['hourlyRateMinor', 'taxInclusive']),
    );

    // Every field is required, so leaving one out never clears it silently.
    const partial = await request.put(
      `operator/aircraft/${aircraftId}/pricing`,
      {
        headers: await csrfHeaders(request),
        data: {
          hourlyRateMinor: 18_000_000,
          taxInclusive: false,
          commissionInclusive: false,
        },
      },
    );
    expect(partial.status()).toBe(400);
    expect(
      (await partial.json()).error.details.map(
        (detail: { field: string }) => detail.field,
      ),
    ).toContain('minBillableHours');
  });

  test('a suspended operator can read its rates but not change them', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { aircraftId } = await listedJet({ request, playwright, baseURL });
    const { operatorId } = await withPrisma((prisma) =>
      prisma.aircraft.findUniqueOrThrow({
        where: { id: aircraftId },
        select: { operatorId: true },
      }),
    );
    await withPrisma((prisma) =>
      prisma.operator.update({
        where: { id: operatorId },
        data: { status: 'SUSPENDED' },
      }),
    );
    const read = await request.get(`operator/aircraft/${aircraftId}/pricing`);
    expect(read.status()).toBe(200);
    for (const [path, data] of [
      [
        `operator/aircraft/${aircraftId}/pricing`,
        {
          hourlyRateMinor: 18_000_000,
          taxInclusive: false,
          commissionInclusive: false,
          minBillableHours: null,
        },
      ],
      [
        'operator/pricing',
        {
          minBillableHours: 2,
          positioningRateFactor: null,
          freeWithinKm: null,
          landingFallbackMinor: null,
          handlingFallbackMinor: null,
        },
      ],
    ] as const) {
      const refused = await request.put(path, {
        headers: await csrfHeaders(request),
        data,
      });
      expect(refused.status()).toBe(409);
      expect((await refused.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
    }
  });
});
