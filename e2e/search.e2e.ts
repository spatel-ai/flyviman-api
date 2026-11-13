import { APIRequestContext, expect, test } from '@playwright/test';
import { withPrisma } from './support/db.js';
import {
  addAircraftDocument,
  aircraftBody,
  approvedOperator,
} from './support/fleet.js';
import { csrfHeaders } from './support/session.js';

/** Charter and helicopter search (M5, slice 1). */

async function locationId(request: APIRequestContext, q: string) {
  const response = await request.get('locations', {
    params: { q, pageSize: 1 },
  });
  return (await response.json()).data[0].id as string;
}

/** Midday in India `days` from now. */
function inDays(days: number, hourUtc = 6): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

/**
 * An approved light jet based in Mumbai, with time offered around the
 * departure and an hourly rate (set in the database: operators enter rates
 * from slice 2 on).
 */
async function bookableJet(contexts: {
  request: APIRequestContext;
  playwright: Parameters<typeof approvedOperator>[1];
  baseURL: string | undefined;
}) {
  const { request } = contexts;
  await approvedOperator(request, contexts.playwright, contexts.baseURL);
  const mumbai = await locationId(request, 'BOM');
  const headers = await csrfHeaders(request);
  const created = await request.post('operator/aircraft', {
    headers,
    data: aircraftBody(mumbai),
  });
  expect(created.status()).toBe(201);
  const aircraftId = (await created.json()).data.id as string;
  for (const type of ['REGISTRATION', 'AIRWORTHINESS', 'INSURANCE']) {
    await addAircraftDocument(request, aircraftId, type);
  }
  await withPrisma(async (prisma) => {
    await prisma.aircraft.update({
      where: { id: aircraftId },
      data: { listingStatus: 'APPROVED' },
    });
    await prisma.pricingRule.create({
      data: {
        scope: 'AIRCRAFT',
        scopeRef: aircraftId,
        type: 'HOURLY_RATE',
        config: { amountMinor: 18_000_000, currency: 'INR' },
      },
    });
  });
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

test.describe('charter search', () => {
  test('offers an approved, available aircraft with a labelled estimate and its breakdown', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { aircraftId, mumbai, goa } = await bookableJet({
      request,
      playwright,
      baseURL,
    });

    // Signed in (as the operator here), so the CSRF header is needed.
    const response = await request.post('search/charter', {
      headers: await csrfHeaders(request),
      data: {
        originId: mumbai,
        destinationId: goa,
        departureAt: inDays(4).toISOString(),
        passengerCount: 4,
      },
    });
    expect(response.status()).toBe(200);
    const search = (await response.json()).data;
    const ours = search.results.find(
      (result: { aircraft: { id: string } }) =>
        result.aircraft.id === aircraftId,
    );
    expect(ours).toBeTruthy();
    expect(ours.price.priceType).toBe('ESTIMATE');
    expect(ours.price.currency).toBe('INR');

    const detail = (
      await (
        await request.get(`search/${search.searchId}/results/${ours.resultId}`)
      ).json()
    ).data;
    const sum = detail.breakdown.reduce(
      (total: number, line: { amountMinor: number }) =>
        total + line.amountMinor,
      0,
    );
    expect(sum).toBe(detail.price.amountMinor);
    expect(detail.breakdown.map((line: { code: string }) => line.code)).toEqual(
      expect.arrayContaining([
        'OPERATING',
        'REPOSITIONING',
        'PLATFORM_FEE',
        'TAX',
      ]),
    );
    expect(detail.bookingMode).toBe('REQUEST');
    expect(detail.cancellationNote).toBeTruthy();
    // Operator costs and Flyviman's revenue are never in a customer answer.
    const text = JSON.stringify(detail);
    expect(text).not.toMatch(/operatorPayable|platformRevenue|calculationId/);
    // Breakdown lines carry no basis wording (it would reveal the hourly rate).
    for (const line of detail.breakdown) {
      expect(Object.keys(line).sort()).toEqual([
        'amountMinor',
        'code',
        'label',
      ]);
    }

    // The stored search answers the same results.
    const again = (
      await (await request.get(`search/${search.searchId}`)).json()
    ).data;
    expect(
      again.results.map((r: { resultId: string }) => r.resultId),
    ).toContain(ours.resultId);
  });

  test('an aircraft with no time offered on the day, or too few seats, is not offered', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { aircraftId, mumbai, goa } = await bookableJet({
      request,
      playwright,
      baseURL,
    });
    const ids = async (data: Record<string, unknown>) => {
      const response = await request.post('search/charter', {
        headers: await csrfHeaders(request),
        data: { originId: mumbai, destinationId: goa, ...data },
      });
      expect(response.status()).toBe(200);
      return (await response.json()).data.results.map(
        (result: { aircraft: { id: string } }) => result.aircraft.id,
      );
    };
    expect(
      await ids({ departureAt: inDays(10).toISOString(), passengerCount: 2 }),
    ).not.toContain(aircraftId);
    expect(
      await ids({ departureAt: inDays(4).toISOString(), passengerCount: 9 }),
    ).not.toContain(aircraftId);
    // A helicopter search never offers a jet.
    const heli = await request.post('search/helicopter', {
      headers: await csrfHeaders(request),
      data: {
        originId: mumbai,
        destinationId: goa,
        departureAt: inDays(4).toISOString(),
        passengerCount: 2,
      },
    });
    expect(JSON.stringify((await heli.json()).data.results)).not.toContain(
      aircraftId,
    );
  });

  test('a request that cannot be searched says why', async ({ request }) => {
    const mumbai = await locationId(request, 'BOM');
    const goa = await locationId(request, 'GOI');
    const same = await request.post('search/charter', {
      data: {
        originId: mumbai,
        destinationId: mumbai,
        departureAt: inDays(4).toISOString(),
        passengerCount: 2,
      },
    });
    expect(same.status()).toBe(400);
    expect((await same.json()).error.code).toBe('VALIDATION_ERROR');

    const past = await request.post('search/charter', {
      data: {
        originId: mumbai,
        destinationId: goa,
        departureAt: new Date().toISOString(),
        passengerCount: 2,
      },
    });
    expect(past.status()).toBe(400);

    // A time without an offset would be read in the server's zone.
    const local = await request.post('search/charter', {
      data: {
        originId: mumbai,
        destinationId: goa,
        departureAt: inDays(4).toISOString().slice(0, 19),
        passengerCount: 2,
      },
    });
    expect(local.status()).toBe(400);

    const missing = await request.get(
      'search/00000000-0000-4000-8000-000000000000',
    );
    expect(missing.status()).toBe(404);
  });
});

test.describe('fare calendar', () => {
  test('a day with offered time shows aircraft and the lowest estimate; past days are left out', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { mumbai, goa } = await bookableJet({ request, playwright, baseURL });
    const day = inDays(4);
    const month = day.toISOString().slice(0, 7);
    const response = await request.get('search/calendar', {
      params: {
        category: 'PRIVATE_CHARTER',
        originId: mumbai,
        destinationId: goa,
        month,
        passengerCount: 4,
      },
    });
    expect(response.status()).toBe(200);
    const calendar = (await response.json()).data;
    expect(calendar.month).toBe(month);
    const today = new Date().toISOString().slice(0, 10);
    for (const entry of calendar.days) {
      expect(entry.date >= today).toBe(true);
    }
    const offered = calendar.days.find(
      (entry: { date: string }) =>
        entry.date === day.toISOString().slice(0, 10),
    );
    expect(offered.availableCount).toBeGreaterThan(0);
    expect(offered.lowest).toMatchObject({
      priceType: 'ESTIMATE',
      currency: 'INR',
    });
  });

  test('a calendar request that cannot be answered says why', async ({
    request,
  }) => {
    const mumbai = await locationId(request, 'BOM');
    const goa = await locationId(request, 'GOI');
    const bad = await request.get('search/calendar', {
      params: {
        category: 'PRIVATE_CHARTER',
        originId: mumbai,
        destinationId: goa,
        month: '2026-13',
        passengerCount: 2,
      },
    });
    expect(bad.status()).toBe(400);
    expect((await bad.json()).error.code).toBe('VALIDATION_ERROR');
  });
});
