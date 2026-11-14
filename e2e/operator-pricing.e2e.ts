import { expect, test } from '@playwright/test';
import { withPrisma } from './support/db.js';
import { approvedOperator } from './support/fleet.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/** Operator pricing inputs (M5 slice 2). */

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
