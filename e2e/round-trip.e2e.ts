import { APIRequestContext, expect, test } from '@playwright/test';
import { withPrisma } from './support/db.js';
import { inDays, listedJet } from './support/pricing.js';
import { csrfHeaders } from './support/session.js';

/** Round trips priced both ways (M5 slice 4b). */

type Trip = Awaited<ReturnType<typeof listedJet>>;

/** Rates for the jet, and the operator's round-trip charges. */
async function priceJet(
  request: APIRequestContext,
  trip: Trip,
  charges: { waitingHourlyMinor: number; overnightMinor: number },
) {
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
  const defaults = await request.put('operator/pricing', {
    headers: await csrfHeaders(request),
    data: {
      minBillableHours: null,
      positioningRateFactor: 0.8,
      freeWithinKm: 0,
      landingFallbackMinor: null,
      handlingFallbackMinor: null,
      waitingHourlyMinor: charges.waitingHourlyMinor,
      waitingFreeHours: 1,
      overnightMinor: charges.overnightMinor,
      crewNightMinor: 1_000_000,
    },
  });
  expect(defaults.status()).toBe(200);
}

async function roundTrip(
  request: APIRequestContext,
  trip: Trip,
  returnAt: Date,
) {
  const response = await request.post('search/charter', {
    headers: await csrfHeaders(request),
    data: {
      originId: trip.mumbai,
      destinationId: trip.goa,
      departureAt: inDays(4).toISOString(),
      passengerCount: 2,
      tripType: 'ROUND_TRIP',
      returnAt: returnAt.toISOString(),
    },
  });
  expect(response.status()).toBe(200);
  const search = (await response.json()).data;
  const result = search.results.find(
    (entry: { aircraft: { id: string } }) =>
      entry.aircraft.id === trip.aircraftId,
  );
  return { search, result };
}

async function detail(
  request: APIRequestContext,
  searchId: string,
  resultId: string,
) {
  const response = await request.get(`search/${searchId}/results/${resultId}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

/** The full stored calculation's line codes, as the admin viewer sees them. */
async function storedCodes(searchId: string, aircraftId: string) {
  const calculation = await withPrisma((prisma) =>
    prisma.priceCalculation.findFirstOrThrow({
      where: { searchId, aircraftId },
    }),
  );
  return (calculation.breakdown as { code: string }[]).map((line) => line.code);
}

test.describe('round trips', () => {
  test('a same-day return waits at the destination, with both flights and the wait in the breakdown', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    // Waiting is cheap; flying back to Mumbai and out again is not.
    await priceJet(request, trip, {
      waitingHourlyMinor: 1_000_000,
      overnightMinor: 50_000_000,
    });
    // Out at 06:00 UTC, back at 12:00 UTC the same day.
    const { search, result } = await roundTrip(request, trip, inDays(4, 12));
    expect(search.legs).toHaveLength(2);
    expect(search.legs[1]).toMatchObject({
      originId: trip.goa,
      destinationId: trip.mumbai,
      departureAt: inDays(4, 12).toISOString(),
    });
    expect(result).toMatchObject({
      tripType: 'ROUND_TRIP',
      returnAt: inDays(4, 12).toISOString(),
      roundTripStrategy: 'WAIT',
      price: { priceType: 'ESTIMATE', currency: 'INR' },
    });

    const shown = await detail(request, search.searchId, result.resultId);
    const codes = shown.breakdown.map((line: { code: string }) => line.code);
    expect(codes).toEqual(expect.arrayContaining(['FLYING', 'WAITING']));
    expect(codes).not.toContain('OPERATING_RETURN');
    expect(await storedCodes(search.searchId, trip.aircraftId)).toEqual(
      expect.arrayContaining(['OPERATING', 'OPERATING_RETURN', 'WAITING']),
    );
    expect(await storedCodes(search.searchId, trip.aircraftId)).not.toContain(
      'INTERIM_REPOSITIONING',
    );
    const sum = shown.breakdown.reduce(
      (total: number, line: { amountMinor: number }) =>
        total + line.amountMinor,
      0,
    );
    expect(sum).toBe(shown.price.amountMinor);
    expect(shown.assumptions.join(' ')).toMatch(/aircraft waits at /);
    for (const line of shown.breakdown) {
      expect(Object.keys(line).sort()).toEqual([
        'amountMinor',
        'code',
        'label',
      ]);
    }
    // The stored search reads back the same.
    const stored = (
      await (await request.get(`search/${search.searchId}`)).json()
    ).data;
    expect(stored.results[0]).toMatchObject({
      tripType: 'ROUND_TRIP',
      roundTripStrategy: 'WAIT',
    });
  });

  test('an overnight return flies back to base when that is cheaper than the night away', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    await priceJet(request, trip, {
      waitingHourlyMinor: 1_000_000,
      overnightMinor: 50_000_000,
    });
    // 20:00 UTC is 01:30 the next morning in India: one night at Goa.
    const { search, result } = await roundTrip(request, trip, inDays(4, 20));
    expect(result.roundTripStrategy).toBe('RETURN_TO_BASE');
    const shown = await detail(request, search.searchId, result.resultId);
    // The customer sees one "Flying" line, without the base's name; the
    // stored calculation keeps the flights back to base and out again.
    const codes = shown.breakdown.map((line: { code: string }) => line.code);
    expect(codes.filter((code: string) => code === 'FLYING')).toHaveLength(1);
    expect(codes).not.toContain('INTERIM_REPOSITIONING');
    expect(codes).not.toContain('OVERNIGHT');
    const sum = shown.breakdown.reduce(
      (total: number, line: { amountMinor: number }) =>
        total + line.amountMinor,
      0,
    );
    expect(sum).toBe(shown.price.amountMinor);
    expect(await storedCodes(search.searchId, trip.aircraftId)).toEqual(
      expect.arrayContaining(['INTERIM_REPOSITIONING', 'INTERIM_POSITIONING']),
    );
    expect(shown.assumptions.join(' ')).toMatch(/returns to .* between/i);
  });

  test('an aircraft not offered for the whole trip is left out', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    await priceJet(request, trip, {
      waitingHourlyMinor: 1_000_000,
      overnightMinor: 1_000_000,
    });
    // Time is offered until day 5 at 00:00 UTC; this return is after it.
    const { result } = await roundTrip(request, trip, inDays(5, 6));
    expect(result).toBeUndefined();
  });

  test('a one-way search says so on each result', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    const response = await request.post('search/charter', {
      headers: await csrfHeaders(request),
      data: {
        originId: trip.mumbai,
        destinationId: trip.goa,
        departureAt: inDays(4).toISOString(),
        passengerCount: 2,
        returnAt: null,
      },
    });
    expect(response.status()).toBe(200);
    const search = (await response.json()).data;
    expect(search.legs).toHaveLength(1);
    expect(search.results[0]).toMatchObject({
      tripType: 'ONE_WAY',
      returnAt: null,
      roundTripStrategy: null,
    });
  });

  test('a round trip that cannot be searched says why', async ({ request }) => {
    const [mumbai, goa] = await Promise.all(
      ['BOM', 'GOI'].map(async (q) => {
        const response = await request.get('locations', {
          params: { q, pageSize: 1 },
        });
        return (await response.json()).data[0].id as string;
      }),
    );
    const base = {
      originId: mumbai,
      destinationId: goa,
      departureAt: inDays(4).toISOString(),
      passengerCount: 2,
    };
    const cases: [string, Record<string, unknown>][] = [
      ['no return time', { tripType: 'ROUND_TRIP' }],
      ['a return on a one-way trip', { returnAt: inDays(5).toISOString() }],
      [
        'a return too soon',
        { tripType: 'ROUND_TRIP', returnAt: inDays(4, 6).toISOString() },
      ],
      [
        'a return too late',
        { tripType: 'ROUND_TRIP', returnAt: inDays(40).toISOString() },
      ],
      [
        'a return without an offset',
        {
          tripType: 'ROUND_TRIP',
          returnAt: inDays(5).toISOString().slice(0, 19),
        },
      ],
      ['multi-leg', { tripType: 'MULTI_LEG' }],
    ];
    for (const [name, extra] of cases) {
      const response = await request.post('search/charter', {
        data: { ...base, ...extra },
      });
      expect(response.status(), name).toBe(400);
      expect((await response.json()).error.code, name).toBe('VALIDATION_ERROR');
    }
  });

  test('operator round-trip charges are saved, kept when left out and cleared with null', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
    await priceJet(request, trip, {
      waitingHourlyMinor: 2_000_000,
      overnightMinor: 5_000_000,
    });
    const read = async () =>
      (await (await request.get('operator/pricing')).json()).data;
    expect(await read()).toMatchObject({
      waitingHourlyMinor: 2_000_000,
      waitingFreeHours: 1,
      overnightMinor: 5_000_000,
      crewNightMinor: 1_000_000,
    });

    // The original five fields only: the round-trip charges stay.
    const kept = await request.put('operator/pricing', {
      headers: await csrfHeaders(request),
      data: {
        minBillableHours: null,
        positioningRateFactor: 0.8,
        freeWithinKm: 0,
        landingFallbackMinor: null,
        handlingFallbackMinor: null,
      },
    });
    expect(kept.status()).toBe(200);
    expect((await kept.json()).data.overnightMinor).toBe(5_000_000);

    const cleared = await request.put('operator/pricing', {
      headers: await csrfHeaders(request),
      data: {
        minBillableHours: null,
        positioningRateFactor: 0.8,
        freeWithinKm: 0,
        landingFallbackMinor: null,
        handlingFallbackMinor: null,
        waitingHourlyMinor: null,
        crewNightMinor: null,
      },
    });
    expect((await cleared.json()).data).toMatchObject({
      waitingHourlyMinor: null,
      waitingFreeHours: null,
      overnightMinor: 5_000_000,
      crewNightMinor: null,
    });

    const invalid = await request.put('operator/pricing', {
      headers: await csrfHeaders(request),
      data: {
        minBillableHours: null,
        positioningRateFactor: 0.8,
        freeWithinKm: 0,
        landingFallbackMinor: null,
        handlingFallbackMinor: null,
        waitingHourlyMinor: 1_000_000,
        waitingFreeHours: 25,
      },
    });
    expect(invalid.status()).toBe(400);
  });
});
