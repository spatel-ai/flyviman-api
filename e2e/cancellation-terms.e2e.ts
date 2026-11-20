import {
  APIRequestContext,
  expect,
  test,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { withPrisma } from './support/db.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Flyviman's cancellation tier table (D-172): `/admin/cancellation-terms`.
 *
 * Every booking request in the other API tests snapshots the table in force
 * and names its version, so these tests never change it: finance's access
 * is proven through identical saves (which write nothing), refusals and a
 * stale version. A real version change is covered by
 * `cancellation-terms.service.spec.ts`.
 */

type Account = 'finance' | 'superAdmin' | 'ops' | 'customer' | 'operatorAdmin';

async function as(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
  account: Account,
): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL });
  await signIn(context, account);
  return context;
}

async function put(context: APIRequestContext, data: unknown) {
  return context.put('admin/cancellation-terms', {
    headers: await csrfHeaders(context),
    data,
  });
}

function versions() {
  return withPrisma((prisma) =>
    prisma.pricingRule.count({ where: { type: 'CANCELLATION_TIERS' } }),
  );
}

test.describe('admin cancellation terms', () => {
  test('finance and super admins read the tiers in force; the starting table is seeded', async ({
    playwright,
    baseURL,
  }) => {
    for (const account of ['finance', 'superAdmin'] as const) {
      const context = await as(playwright, baseURL, account);
      const response = await context.get('admin/cancellation-terms');
      expect(response.status(), account).toBe(200);
      const terms = (await response.json()).data;
      expect(terms).toMatchObject({
        version: expect.any(Number),
        summary: expect.stringContaining('the same for every operator'),
        validFrom: expect.any(String),
      });
      expect(terms).not.toHaveProperty('ruleId');
      const tiers = terms.tiers as {
        minHoursBeforeDeparture: number;
        chargePercent: number;
      }[];
      expect(tiers.at(-1)?.minHoursBeforeDeparture).toBe(0);
    }
    const seeded = await withPrisma((prisma) =>
      prisma.pricingRule.findFirstOrThrow({
        where: { type: 'CANCELLATION_TIERS', version: 1 },
      }),
    );
    expect(seeded).toMatchObject({
      scope: 'PLATFORM',
      scopeRef: null,
      config: {
        tiers: [
          { minHoursBeforeDeparture: 72, chargePercent: 10 },
          { minHoursBeforeDeparture: 24, chargePercent: 50 },
          { minHoursBeforeDeparture: 0, chargePercent: 100 },
        ],
      },
    });
  });

  test('operations, operators, customers and visitors are refused', async ({
    playwright,
    baseURL,
    request,
  }) => {
    const finance = await as(playwright, baseURL, 'finance');
    const current = (
      await (await finance.get('admin/cancellation-terms')).json()
    ).data;
    const body = {
      tiers: current.tiers,
      baseVersion: current.version,
      reason: 'Not allowed',
    };
    for (const account of ['ops', 'operatorAdmin', 'customer'] as const) {
      const context = await as(playwright, baseURL, account);
      expect(
        (await context.get('admin/cancellation-terms')).status(),
        account,
      ).toBe(403);
      expect((await put(context, body)).status(), account).toBe(403);
    }
    expect((await request.get('admin/cancellation-terms')).status()).toBe(401);
    // The generic rule list never shows the tier table.
    const rules = (
      await (
        await finance.get('admin/pricing-rules', {
          params: { active: 'false', pageSize: '100' },
        })
      ).json()
    ).data as { type: string }[];
    expect(rules.some((rule) => rule.type === 'CANCELLATION_TIERS')).toBe(
      false,
    );
  });

  test('finance saves are checked: identical tiers write nothing, a stale version and bad tiers are refused', async ({
    playwright,
    baseURL,
  }) => {
    const finance = await as(playwright, baseURL, 'finance');
    const current = (
      await (await finance.get('admin/cancellation-terms')).json()
    ).data;
    const before = await versions();

    const same = await put(finance, {
      tiers: current.tiers,
      baseVersion: current.version,
      reason: 'Checking the table',
    });
    expect(same.status()).toBe(200);
    expect((await same.json()).data.version).toBe(current.version);

    const stale = await put(finance, {
      tiers: current.tiers,
      baseVersion: current.version + 1000,
      reason: 'From an old screen',
    });
    expect(stale.status()).toBe(409);
    expect((await stale.json()).error.code).toBe('PRICING_RULE_NOT_CURRENT');

    const bad: [unknown, string][] = [
      [
        [
          { minHoursBeforeDeparture: 24, chargePercent: 50 },
          { minHoursBeforeDeparture: 72, chargePercent: 10 },
          { minHoursBeforeDeparture: 0, chargePercent: 100 },
        ],
        'tiers.1.minHoursBeforeDeparture',
      ],
      [
        [{ minHoursBeforeDeparture: 72, chargePercent: 10 }],
        'tiers.0.minHoursBeforeDeparture',
      ],
      [
        [
          { minHoursBeforeDeparture: 72, chargePercent: 60 },
          { minHoursBeforeDeparture: 0, chargePercent: 50 },
        ],
        'tiers.1.chargePercent',
      ],
    ];
    for (const [tiers, field] of bad) {
      const response = await put(finance, {
        tiers,
        baseVersion: current.version,
        reason: 'Bad table',
      });
      expect(response.status(), field).toBe(400);
      expect(
        (await response.json()).error.details.map(
          (d: { field: string }) => d.field,
        ),
      ).toContain(field);
    }
    for (const data of [
      { tiers: current.tiers, baseVersion: current.version },
      { tiers: current.tiers, baseVersion: current.version, reason: 'x' },
      { tiers: [], baseVersion: current.version, reason: 'No tiers' },
      {
        tiers: [{ minHoursBeforeDeparture: 0, chargePercent: 101 }],
        baseVersion: current.version,
        reason: 'Over 100',
      },
    ]) {
      expect((await put(finance, data)).status(), JSON.stringify(data)).toBe(
        400,
      );
    }
    expect(await versions()).toBe(before);
  });
});
