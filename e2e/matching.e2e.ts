import {
  APIRequestContext,
  expect,
  test,
  type PlaywrightWorkerArgs,
} from '@playwright/test';
import { registerOperator } from './support/data.js';
import { withPrisma } from './support/db.js';
import {
  addAircraftDocument,
  aircraftBody,
  approvedOperator,
} from './support/fleet.js';
import { inDays, listedJet, locationId, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Operator restrictions and Flyviman's matching limits (M5 slice 4a). Unit
 * tests in `matching/criteria.spec.ts` cover each criterion; these prove the
 * stored settings reach a real search.
 *
 * Other tests search at the same time against platform rules, so the
 * category limit here is set on heavy jets, which no other test prices.
 */

const CATEGORY = 'HEAVY_JET';

async function as(
  playwright: PlaywrightWorkerArgs['playwright'],
  baseURL: string | undefined,
  account: 'finance' | 'customer',
): Promise<APIRequestContext> {
  const context = await playwright.request.newContext({ baseURL });
  await signIn(context, account);
  return context;
}

async function exclusionsOf(searchId: string, aircraftId: string) {
  const search = await withPrisma((prisma) =>
    prisma.search.findUniqueOrThrow({ where: { id: searchId } }),
  );
  return (
    (search.exclusions as { aircraftId: string; reasons: string[] }[]).find(
      (entry) => entry.aircraftId === aircraftId,
    )?.reasons ?? null
  );
}

async function putRestrictions(request: APIRequestContext, data: unknown) {
  return request.put('operator/restrictions', {
    headers: await csrfHeaders(request),
    data,
  });
}

/** Ends any heavy-jet matching limit an interrupted run left in force. */
async function clearCategory() {
  await withPrisma((prisma) =>
    prisma.pricingRule.updateMany({
      where: {
        scope: 'CATEGORY',
        scopeRef: CATEGORY,
        type: 'MATCHING_LIMITS',
        isActive: true,
      },
      data: { isActive: false, validTo: new Date() },
    }),
  );
}

test.describe('operator restrictions', () => {
  test('an approved operator administrator replaces, reads and clears them, each change audited', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await approvedOperator(request, playwright, baseURL);
    const operatorId = (await (await request.get('operator/me')).json()).data
      .operatorId as string;
    const goa = await locationId(request, 'GOI');

    const empty = await request.get('operator/restrictions');
    expect(empty.status()).toBe(200);
    expect((await empty.json()).data).toEqual({ restrictions: null });

    const restrictions = {
      operatingHours: { start: '06:00', end: '20:00' },
      excludedLocationIds: [goa],
      minimumNoticeMinutes: 180,
    };
    const set = await putRestrictions(request, { restrictions });
    expect(set.status()).toBe(200);
    expect((await set.json()).data).toEqual({ restrictions });

    // PUT replaces the whole object: what is left out is gone.
    const replaced = await putRestrictions(request, {
      restrictions: { minimumNoticeMinutes: 60 },
    });
    expect((await replaced.json()).data).toEqual({
      restrictions: { minimumNoticeMinutes: 60 },
    });
    expect(
      (await (await request.get('operator/restrictions')).json()).data,
    ).toEqual({ restrictions: { minimumNoticeMinutes: 60 } });

    const cleared = await putRestrictions(request, { restrictions: null });
    expect((await cleared.json()).data).toEqual({ restrictions: null });

    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: operatorId, action: 'operator.restrictions.update' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audits.map((a) => [a.before, a.after])).toEqual([
      [{ restrictions: null }, { restrictions }],
      [{ restrictions }, { restrictions: { minimumNoticeMinutes: 60 } }],
      [{ restrictions: { minimumNoticeMinutes: 60 } }, { restrictions: null }],
    ]);
    expect(audits[0].actorRole).toBe('OPERATOR_ADMIN');
  });

  test('refuses a missing object, malformed values and unknown keys', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await approvedOperator(request, playwright, baseURL);
    for (const data of [
      {},
      { restrictions: { operatingHours: { start: '25:00', end: '06:00' } } },
      { restrictions: { operatingHours: { start: '06:00', end: '06:00' } } },
      { restrictions: { excludedLocationIds: ['not-a-uuid'] } },
      { restrictions: { minimumNoticeMinutes: 10_081 } },
      { restrictions: { regions: ['Goa'] } },
    ]) {
      const response = await putRestrictions(request, data);
      expect(response.status(), JSON.stringify(data)).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('is refused to other roles, without a session and before approval', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const anonymous = await playwright.request.newContext({ baseURL });
    expect((await anonymous.get('operator/restrictions')).status()).toBe(401);

    const customer = await as(playwright, baseURL, 'customer');
    expect((await customer.get('operator/restrictions')).status()).toBe(403);
    expect(
      (await putRestrictions(customer, { restrictions: null })).status(),
    ).toBe(403);

    await registerOperator(request);
    for (const response of [
      await request.get('operator/restrictions'),
      await putRestrictions(request, { restrictions: null }),
    ]) {
      expect(response.status()).toBe(409);
      expect((await response.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
    }
  });

  test('search leaves out an aircraft its operator restricts, and offers it again once cleared', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    expect((await searchFor(request, trip)).result).toBeDefined();

    await putRestrictions(request, {
      restrictions: { excludedLocationIds: [trip.goa] },
    });
    const excluded = await searchFor(request, trip);
    expect(excluded.result).toBeUndefined();
    expect(await exclusionsOf(excluded.searchId, trip.aircraftId)).toEqual([
      'excludedLocation',
    ]);

    // The search departs at 11:30 in India.
    await putRestrictions(request, {
      restrictions: { operatingHours: { start: '13:00', end: '18:00' } },
    });
    const outOfHours = await searchFor(request, trip);
    expect(outOfHours.result).toBeUndefined();
    expect(await exclusionsOf(outOfHours.searchId, trip.aircraftId)).toEqual([
      'operatingHours',
    ]);

    await putRestrictions(request, { restrictions: null });
    expect((await searchFor(request, trip)).result).toBeDefined();
  });
});

test.describe.serial('matching limits', () => {
  test.beforeEach(clearCategory);
  test.afterAll(clearCategory);

  test('a category distance limit set by finance leaves out an otherwise-eligible aircraft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await approvedOperator(request, playwright, baseURL);
    const mumbai = await locationId(request, 'BOM');
    const goa = await locationId(request, 'GOI');
    const created = await request.post('operator/aircraft', {
      headers: await csrfHeaders(request),
      data: { ...aircraftBody(mumbai), category: CATEGORY },
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
    const trip = { aircraftId, mumbai, goa };
    expect((await searchFor(request, trip)).result).toBeDefined();

    const finance = await as(playwright, baseURL, 'finance');
    const refused = await finance.post('admin/pricing-rules', {
      headers: await csrfHeaders(finance),
      data: {
        type: 'MATCHING_LIMITS',
        scope: 'CATEGORY',
        scopeRef: CATEGORY,
        config: { minLegKm: 500, maxLegKm: 100 },
        reason: 'Heavy jets on short legs only',
      },
    });
    expect(refused.status()).toBe(400);

    const rule = await finance.post('admin/pricing-rules', {
      headers: await csrfHeaders(finance),
      data: {
        type: 'MATCHING_LIMITS',
        scope: 'CATEGORY',
        scopeRef: CATEGORY,
        config: { maxLegKm: 100 },
        reason: 'Heavy jets on short legs only',
      },
    });
    expect(rule.status()).toBe(201);

    // Searching every fixed-wing category: other categories can fly it,
    // so only this aircraft is left out.
    const limited = await searchFor(request, trip);
    expect(limited.result).toBeUndefined();
    expect(await exclusionsOf(limited.searchId, aircraftId)).toEqual([
      'distance',
    ]);

    // Searching heavy jets only: the trip itself is outside the limit.
    const heavyOnly = async (departureAt: Date) =>
      request.post('search/charter', {
        headers: await csrfHeaders(request),
        data: {
          originId: mumbai,
          destinationId: goa,
          departureAt: departureAt.toISOString(),
          passengerCount: 2,
          category: CATEGORY,
        },
      });
    const tooFar = await heavyOnly(inDays(4));
    expect(tooFar.status()).toBe(400);
    expect((await tooFar.json()).error).toMatchObject({
      code: 'VALIDATION_ERROR',
      details: [{ field: 'destinationId' }],
    });

    const noticeRule = await finance.patch(
      `admin/pricing-rules/${(await rule.json()).data.id}`,
      {
        headers: await csrfHeaders(finance),
        data: {
          config: { minimumNoticeMinutes: 10_080 },
          reason: 'Heavy jets need a week',
        },
      },
    );
    expect(noticeRule.status()).toBe(200);
    const tooSoon = await heavyOnly(inDays(4));
    expect(tooSoon.status()).toBe(400);
    const error = (await tooSoon.json()).error;
    expect(error.details).toEqual([
      {
        field: 'departureAt',
        issue: 'must be at least 168 hours from now for this trip',
      },
    ]);

    // The fare calendar leaves those days without an estimate, not an error.
    const calendar = await request.get('search/calendar', {
      params: {
        category: 'PRIVATE_CHARTER',
        originId: mumbai,
        destinationId: goa,
        passengerCount: 2,
        month: inDays(4).toISOString().slice(0, 7),
        aircraftCategory: CATEGORY,
      },
    });
    expect(calendar.status()).toBe(200);
    const day = inDays(4).toISOString().slice(0, 10);
    expect(
      (await calendar.json()).data.days.find(
        (entry: { date: string }) => entry.date === day,
      ),
    ).toMatchObject({ availableCount: 0, lowest: null });
  });
});
