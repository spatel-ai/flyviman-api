import { APIRequestContext, expect, test } from '@playwright/test';
import { withPrisma } from './support/db.js';
import {
  addAircraftDocument,
  aircraftBody,
  approvedOperator,
} from './support/fleet.js';
import { csrfHeaders, signIn } from './support/session.js';

/** Operator pricing inputs (M5 slice 2). */

async function locationId(request: APIRequestContext, q: string) {
  const response = await request.get('locations', {
    params: { q, pageSize: 1 },
  });
  return (await response.json()).data[0].id as string;
}

function inDays(days: number, hourUtc = 6): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

/** An approved jet in Mumbai with time offered, and no rate yet. */
async function listedJet(contexts: {
  request: APIRequestContext;
  playwright: Parameters<typeof approvedOperator>[1];
  baseURL: string | undefined;
}) {
  const { request } = contexts;
  await approvedOperator(request, contexts.playwright, contexts.baseURL);
  const mumbai = await locationId(request, 'BOM');
  const created = await request.post('operator/aircraft', {
    headers: await csrfHeaders(request),
    data: aircraftBody(mumbai),
  });
  expect(created.status()).toBe(201);
  const aircraftId = (await created.json()).data.id as string;
  for (const type of ['REGISTRATION', 'AIRWORTHINESS', 'INSURANCE']) {
    await addAircraftDocument(request, aircraftId, type);
  }
  await withPrisma((prisma) =>
    prisma.aircraft.update({
      where: { id: aircraftId },
      data: { listingStatus: 'APPROVED' },
    }),
  );
  const slot = await request.post(
    `operator/aircraft/${aircraftId}/availability/slots`,
    {
      headers: await csrfHeaders(request),
      data: {
        startsAt: inDays(3, 0).toISOString(),
        endsAt: inDays(5, 0).toISOString(),
        kind: 'OPEN',
      },
    },
  );
  expect(slot.status()).toBe(201);
  return { aircraftId, mumbai, goa: await locationId(request, 'GOI') };
}

test.describe('operator pricing', () => {
  test('an aircraft rate turns "price on request" into an estimate, versioned and audited', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { aircraftId, mumbai, goa } = await listedJet({
      request,
      playwright,
      baseURL,
    });
    const search = async () => {
      const response = await request.post('search/charter', {
        headers: await csrfHeaders(request),
        data: {
          originId: mumbai,
          destinationId: goa,
          departureAt: inDays(4).toISOString(),
          passengerCount: 2,
        },
      });
      expect(response.status()).toBe(200);
      return (await response.json()).data.results.find(
        (result: { aircraft: { id: string } }) =>
          result.aircraft.id === aircraftId,
      );
    };

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
  });
});
