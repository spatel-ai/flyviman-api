import {
  APIRequestContext,
  expect,
  test,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Admin pricing rules and the calculation viewer (M5 slice 3).
 *
 * Other API tests run at the same time and price jets against the platform
 * rules, so these tests never change a platform rule: they create, change
 * and end rules on the turboprop category, which no other test prices, and
 * touch platform rules only through refusals and identical saves.
 */

const CATEGORY = 'TURBOPROP';

async function as(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
  account: 'finance' | 'ops' | 'customer' | 'operatorAdmin',
): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL });
  await signIn(context, account);
  return context;
}

/** Ends any turboprop rule an earlier, interrupted run left in force. */
async function clearCategory() {
  await withPrisma((prisma) =>
    prisma.pricingRule.updateMany({
      where: { scope: 'CATEGORY', scopeRef: CATEGORY, isActive: true },
      data: { isActive: false, validTo: new Date() },
    }),
  );
}

test.describe.serial('admin pricing rules', () => {
  test.beforeEach(clearCategory);
  test.afterAll(clearCategory);

  test('finance creates, changes and ends a category commission, each versioned and audited with its reason', async ({
    playwright,
    baseURL,
  }) => {
    const finance = await as(playwright, baseURL, 'finance');

    const created = await finance.post('admin/pricing-rules', {
      headers: await csrfHeaders(finance),
      data: {
        type: 'COMMISSION',
        scope: 'CATEGORY',
        scopeRef: CATEGORY,
        config: { percent: 8, mode: 'ADD_ON' },
        reason: 'Turboprop launch rate',
      },
    });
    expect(created.status()).toBe(201);
    const first = (await created.json()).data;
    expect(first).toMatchObject({
      type: 'COMMISSION',
      scope: 'CATEGORY',
      scopeRef: CATEGORY,
      config: { percent: 8, mode: 'ADD_ON' },
      inForce: true,
      editable: true,
    });

    // A second rule for the same type and scope is refused.
    const duplicate = await finance.post('admin/pricing-rules', {
      headers: await csrfHeaders(finance),
      data: {
        type: 'COMMISSION',
        scope: 'CATEGORY',
        scopeRef: CATEGORY,
        config: { percent: 9, mode: 'ADD_ON' },
        reason: 'Second try',
      },
    });
    expect(duplicate.status()).toBe(409);
    expect((await duplicate.json()).error.code).toBe('PRICING_RULE_EXISTS');

    // Identical settings write nothing; new settings make the next version.
    const same = await finance.patch(`admin/pricing-rules/${first.id}`, {
      headers: await csrfHeaders(finance),
      data: { config: { mode: 'ADD_ON', percent: 8 }, reason: 'No change' },
    });
    expect((await same.json()).data.id).toBe(first.id);
    const changed = await finance.patch(`admin/pricing-rules/${first.id}`, {
      headers: await csrfHeaders(finance),
      data: {
        config: { percent: 7.5, mode: 'DEDUCTED' },
        reason: 'Renegotiated',
      },
    });
    expect(changed.status()).toBe(200);
    const second = (await changed.json()).data;
    expect(second).toMatchObject({ version: first.version + 1, inForce: true });
    expect(second.id).not.toBe(first.id);

    // The old version can no longer be changed.
    const stale = await finance.patch(`admin/pricing-rules/${first.id}`, {
      headers: await csrfHeaders(finance),
      data: { config: { percent: 6, mode: 'ADD_ON' }, reason: 'Stale tab' },
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe('PRICING_RULE_NOT_CURRENT');

    // The in-force list shows the new version only; history shows both.
    const inForce = await finance.get('admin/pricing-rules', {
      params: { scope: 'CATEGORY', type: 'COMMISSION' },
    });
    const ids = (await inForce.json()).data.map((r: { id: string }) => r.id);
    expect(ids).toContain(second.id);
    expect(ids).not.toContain(first.id);
    const history = await finance.get('admin/pricing-rules', {
      params: { scope: 'CATEGORY', type: 'COMMISSION', active: 'false' },
    });
    const all = (await history.json()).data.map((r: { id: string }) => r.id);
    expect(all).toEqual(expect.arrayContaining([first.id, second.id]));

    // Ending a category rule hands back to the platform default.
    const ended = await finance.post(
      `admin/pricing-rules/${second.id}/deactivate`,
      {
        headers: await csrfHeaders(finance),
        data: { reason: 'Back to the platform rate' },
      },
    );
    expect(ended.status()).toBe(200);
    expect((await ended.json()).data.inForce).toBe(false);

    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: { in: [first.id, second.id] } },
        orderBy: { createdAt: 'asc' },
        select: { action: true, reason: true, before: true, after: true },
      }),
    );
    expect(audits.map((a) => [a.action, a.reason])).toEqual([
      ['pricing_rule.create', 'Turboprop launch rate'],
      ['pricing_rule.change', 'Renegotiated'],
      ['pricing_rule.deactivate', 'Back to the platform rate'],
    ]);
    expect(audits[1].before).toMatchObject({ config: { percent: 8 } });
    expect(audits[1].after).toMatchObject({ config: { percent: 7.5 } });
    await finance.dispose();
  });

  test('platform rules can be changed but never ended; identical saves write nothing', async ({
    playwright,
    baseURL,
  }) => {
    const finance = await as(playwright, baseURL, 'finance');
    const list = await finance.get('admin/pricing-rules', {
      params: { scope: 'PLATFORM', type: 'TAX' },
    });
    const tax = (await list.json()).data[0];
    expect(tax).toMatchObject({
      scope: 'PLATFORM',
      type: 'TAX',
      inForce: true,
    });

    const ended = await finance.post(
      `admin/pricing-rules/${tax.id}/deactivate`,
      {
        headers: await csrfHeaders(finance),
        data: { reason: 'Try to end tax' },
      },
    );
    expect(ended.status()).toBe(409);
    expect((await ended.json()).error.code).toBe('PRICING_RULE_REQUIRED');

    const same = await finance.patch(`admin/pricing-rules/${tax.id}`, {
      headers: await csrfHeaders(finance),
      data: { config: tax.config, reason: 'Re-save' },
    });
    expect(same.status()).toBe(200);
    expect((await same.json()).data).toMatchObject({
      id: tax.id,
      version: tax.version,
    });
    await finance.dispose();
  });

  test('settings, scope, reason and type are checked', async ({
    playwright,
    baseURL,
  }) => {
    const finance = await as(playwright, baseURL, 'finance');
    const post = async (data: object) =>
      finance.post('admin/pricing-rules', {
        headers: await csrfHeaders(finance),
        data,
      });
    const base = {
      type: 'TAX',
      scope: 'CATEGORY',
      scopeRef: CATEGORY,
      config: { name: 'GST', percent: 18 },
      reason: 'Category tax',
    };

    const badConfig = await post({
      ...base,
      config: { name: 'GST', percent: 90, extra: true },
    });
    expect(badConfig.status()).toBe(400);
    expect(
      (await badConfig.json()).error.details.map(
        (d: { field: string }) => d.field,
      ),
    ).toEqual(expect.arrayContaining(['config.percent', 'config.extra']));

    expect((await post({ ...base, scopeRef: 'BALLOON' })).status()).toBe(400);
    expect(
      (await post({ ...base, scope: 'PLATFORM', scopeRef: CATEGORY })).status(),
    ).toBe(400);
    expect((await post({ ...base, reason: ' x ' })).status()).toBe(400);
    // Types the engine does not apply yet, and operator-owned scopes, are refused.
    expect((await post({ ...base, type: 'MARKUP' })).status()).toBe(400);
    expect((await post({ ...base, scope: 'OPERATOR' })).status()).toBe(400);

    // An operator's own rule is not found through this screen.
    const operatorRule = await withPrisma((prisma) =>
      prisma.pricingRule.findFirst({
        where: { scope: { in: ['OPERATOR', 'AIRCRAFT'] } },
        select: { id: true },
      }),
    );
    if (operatorRule) {
      const response = await finance.patch(
        `admin/pricing-rules/${operatorRule.id}`,
        {
          headers: await csrfHeaders(finance),
          data: { config: { hours: 2 }, reason: 'Override operator' },
        },
      );
      expect(response.status()).toBe(404);
    }
    await finance.dispose();
  });

  test('only finance and super administrators manage rules', async ({
    playwright,
    baseURL,
    request,
  }) => {
    for (const account of ['ops', 'operatorAdmin', 'customer'] as const) {
      const context = await as(playwright, baseURL, account);
      expect((await context.get('admin/pricing-rules')).status()).toBe(403);
      const write = await context.post('admin/pricing-rules', {
        headers: await csrfHeaders(context),
        data: {
          type: 'TAX',
          scope: 'CATEGORY',
          scopeRef: CATEGORY,
          config: { name: 'GST', percent: 18 },
          reason: 'Not allowed',
        },
      });
      expect(write.status()).toBe(403);
      await context.dispose();
    }
    expect((await request.get('admin/pricing-rules')).status()).toBe(401);
  });
});

test.describe('calculation viewer', () => {
  test('finance sees the full calculation; operations see it without the restricted figures', async ({
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
          minBillableHours: null,
        },
      },
    );
    expect(rate.status()).toBe(200);
    const { searchId, result } = await searchFor(request, trip);
    expect(result.price).toMatchObject({ priceType: 'ESTIMATE' });

    const finance = await as(playwright, baseURL, 'finance');
    const list = await finance.get('admin/price-calculations', {
      params: { searchId, aircraftId: trip.aircraftId },
    });
    expect(list.status()).toBe(200);
    const listed = await list.json();
    expect(listed.meta.total).toBe(1);
    const summary = listed.data[0];
    expect(summary).toMatchObject({
      searchId,
      aircraftId: trip.aircraftId,
      priceType: 'ESTIMATE',
      currency: 'INR',
    });
    expect(summary.aircraftLabel).toEqual(expect.any(String));
    expect(summary.operatorName).toEqual(expect.any(String));

    const full = (
      await (await finance.get(`admin/price-calculations/${summary.id}`)).json()
    ).data;
    expect(full.finance).toEqual({
      operatorPayableMinor: expect.any(Number),
      platformRevenueMinor: expect.any(Number),
    });
    const operating = full.breakdown.find(
      (line: { code: string }) => line.code === 'OPERATING',
    );
    expect(operating.basis).toEqual(expect.any(String));
    const hourly = full.appliedRules.find(
      (rule: { type: string }) => rule.type === 'HOURLY_RATE',
    );
    expect(hourly.config).toMatchObject({ amountMinor: 18_000_000 });
    // The breakdown adds up to the total.
    const sum = full.breakdown.reduce(
      (total: number, line: { amountMinor: number }) =>
        total + line.amountMinor,
      0,
    );
    expect(sum).toBe(full.totalMinor);
    await finance.dispose();

    const ops = await as(playwright, baseURL, 'ops');
    const limited = (
      await (await ops.get(`admin/price-calculations/${summary.id}`)).json()
    ).data;
    expect(limited.totalMinor).toBe(full.totalMinor);
    expect(limited.finance).toBeNull();
    expect(
      limited.breakdown.every(
        (line: { basis: unknown }) => line.basis === null,
      ),
    ).toBe(true);
    expect(
      limited.appliedRules.every(
        (rule: { config: unknown }) => rule.config === null,
      ),
    ).toBe(true);
    await ops.dispose();
  });

  test('customers and operators cannot open the viewer; an unknown calculation is 404', async ({
    playwright,
    baseURL,
  }) => {
    for (const account of ['customer', 'operatorAdmin'] as const) {
      const context = await as(playwright, baseURL, account);
      expect((await context.get('admin/price-calculations')).status()).toBe(
        403,
      );
      await context.dispose();
    }
    const ops = await as(playwright, baseURL, 'ops');
    const missing = await ops.get(
      'admin/price-calculations/00000000-0000-4000-8000-000000000000',
    );
    expect(missing.status()).toBe(404);
    expect(
      (await ops.get('admin/price-calculations/not-a-uuid')).status(),
    ).toBe(400);
    await ops.dispose();
  });
});
