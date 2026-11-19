import 'dotenv/config';
import { APIRequestContext, expect, test } from '@playwright/test';
import { withPrisma } from './support/db.js';

/** Scheduled airline search against the airline mock (M6). */

async function airport(request: APIRequestContext, iata: string) {
  const response = await request.get('locations', {
    params: { q: iata, pageSize: 10 },
  });
  const found = (
    (await response.json()).data as { id: string; iata: string }[]
  ).find((l) => l.iata === iata);
  expect(found, `seeded airport ${iata}`).toBeTruthy();
  return found!.id;
}

/** A date in India `days` from today, `YYYY-MM-DD`. */
function inDays(days: number): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(Date.now() + days * 86_400_000));
}

interface Offer {
  offerId: string;
  direction: 'OUTBOUND' | 'RETURN';
  segments: {
    from: { iata: string; timeZone: string };
    to: { iata: string };
    departAt: string;
    arriveAt: string;
    flightNumber: string;
  }[];
  fare: {
    amountMinor: number;
    currency: string;
    priceType: string;
    fareFamily: string;
  };
  refundable: boolean;
  validUntil: string;
}

interface SearchBody {
  searchId: string;
  partial: boolean;
  providers: { name: string; status: string }[];
  passengers: { adults: number; children: number; infants: number };
  results: Offer[];
}

async function search(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<SearchBody> {
  const response = await request.post('search/scheduled', { data: body });
  expect(response.status(), await response.text()).toBe(200);
  return (await response.json()).data as SearchBody;
}

test.describe('scheduled search', () => {
  let del: string;
  let bom: string;
  let blr: string;

  test.beforeAll(async ({ request }) => {
    del = await airport(request, 'DEL');
    bom = await airport(request, 'BOM');
    blr = await airport(request, 'BLR');
  });

  const party = { adults: 2, children: 1, infants: 1 };

  test('finds live fares for a one-way trip and stores the search', async ({
    request,
  }) => {
    const before = Date.now();
    const body = await search(request, {
      originId: del,
      destinationId: blr,
      departureDate: inDays(20),
      passengers: party,
      cabin: 'ECONOMY',
    });
    expect(body.partial).toBe(false);
    expect(body.providers).toEqual([{ name: 'mock', status: 'OK' }]);
    // The party comes back, so a page reading the search by id knows it.
    expect(body.passengers).toEqual(party);
    expect(body.results.length).toBeGreaterThan(0);
    for (const offer of body.results) {
      expect(offer.direction).toBe('OUTBOUND');
      expect(offer.fare.priceType).toBe('LIVE_FARE');
      expect(offer.fare.currency).toBe('INR');
      expect(Number.isInteger(offer.fare.amountMinor)).toBe(true);
      expect(offer.segments[0].from.iata).toBe('DEL');
      expect(offer.segments[0].to.iata).toBe('BLR');
      expect(offer.segments[0].departAt).toMatch(/\+05:30$/);
      expect(offer.segments[0].departAt.startsWith(inDays(20))).toBe(true);
      const ttl = Date.parse(offer.validUntil) - before;
      expect(ttl).toBeGreaterThan(14 * 60_000);
      expect(ttl).toBeLessThan(16 * 60_000);
      // Supplier references never leave the API.
      expect(Object.keys(offer)).not.toContain('providerOfferId');
      expect(Object.keys(offer)).not.toContain('provider');
    }

    const stored = await request.get(`search/scheduled/${body.searchId}`);
    expect(stored.status()).toBe(200);
    expect((await stored.json()).data).toEqual(body);
  });

  test('a return search holds both directions', async ({ request }) => {
    const body = await search(request, {
      originId: del,
      destinationId: bom,
      departureDate: inDays(21),
      returnDate: inDays(25),
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'ECONOMY',
    });
    const outbound = body.results.filter((o) => o.direction === 'OUTBOUND');
    const back = body.results.filter((o) => o.direction === 'RETURN');
    expect(outbound.length).toBeGreaterThan(0);
    expect(back.length).toBeGreaterThan(0);
    expect(back[0].segments[0].from.iata).toBe('BOM');
    // Outbound first.
    expect(body.results.indexOf(back[0])).toBe(outbound.length);
  });

  test('an airport the supplier does not serve gives no flights, not a failure', async ({
    request,
  }) => {
    const body = await search(request, {
      originId: await airport(request, 'IXC'),
      destinationId: await airport(request, 'VNS'),
      departureDate: inDays(14),
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'ECONOMY',
    });
    expect(body.partial).toBe(false);
    expect(body.providers).toEqual([{ name: 'mock', status: 'OK' }]);
    expect(body.results).toEqual([]);
  });

  test('refuses invalid searches', async ({ request }) => {
    const valid = {
      originId: del,
      destinationId: bom,
      departureDate: inDays(10),
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'ECONOMY',
    };
    const cases: [Record<string, unknown>, string][] = [
      [{ ...valid, departureDate: inDays(-2) }, 'departureDate'],
      [{ ...valid, departureDate: inDays(400) }, 'departureDate'],
      [{ ...valid, returnDate: inDays(5) }, 'returnDate'],
      [{ ...valid, destinationId: del }, 'destinationId'],
      [
        { ...valid, passengers: { adults: 2, children: 8, infants: 0 } },
        'passengers.children',
      ],
      [
        { ...valid, passengers: { adults: 1, children: 0, infants: 2 } },
        'passengers.infants',
      ],
    ];
    for (const [data, field] of cases) {
      const response = await request.post('search/scheduled', { data });
      expect(response.status()).toBe(400);
      const error = (await response.json()).error;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(JSON.stringify(error.details)).toContain(field);
    }
    for (const data of [
      { ...valid, cabin: 'FIRST' },
      { ...valid, departureDate: `${inDays(10)}T10:00:00Z` },
      { ...valid, passengers: { adults: 0, children: 0, infants: 0 } },
      { ...valid, extra: true },
    ]) {
      const response = await request.post('search/scheduled', { data });
      expect(response.status()).toBe(400);
    }
  });

  test('a supplier that times out or fails gives a partial result', async ({
    request,
  }) => {
    // Its own route, so parallel tests on other routes are unaffected.
    const goi = await airport(request, 'GOI');
    const jai = await airport(request, 'JAI');
    const route = { origin: 'GOI', destination: 'JAI' };
    const body = {
      originId: goi,
      destinationId: jai,
      departureDate: inDays(12),
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'ECONOMY',
    };
    try {
      for (const behaviour of ['TIMEOUT', 'ERROR']) {
        const set = await request.put('dev/airline/behaviour', {
          data: { ...route, behaviour },
        });
        expect(set.status()).toBe(204);
        const result = await search(request, body);
        expect(result.partial).toBe(true);
        expect(result.providers).toEqual([{ name: 'mock', status: behaviour }]);
        expect(result.results).toEqual([]);
        const stored = await request.get(`search/scheduled/${result.searchId}`);
        expect((await stored.json()).data.partial).toBe(true);
      }
    } finally {
      await request.put('dev/airline/behaviour', {
        data: { ...route, behaviour: 'NORMAL' },
      });
    }
    const recovered = await search(request, body);
    expect(recovered.partial).toBe(false);
  });

  test('revalidation reports available, a changed price and sold out', async ({
    request,
  }) => {
    test.setTimeout(60_000);
    const seen = new Map<
      string,
      {
        shown: number;
        body: Record<string, unknown>;
        searchId: string;
        offer: Offer;
      }
    >();
    for (let day = 30; day < 40 && seen.size < 3; day += 1) {
      const body = await search(request, {
        originId: del,
        destinationId: bom,
        departureDate: inDays(day),
        passengers: { adults: 1, children: 0, infants: 0 },
        cabin: 'ECONOMY',
      });
      for (const offer of body.results) {
        const response = await request.post('search/scheduled/revalidate', {
          data: { searchId: body.searchId, offerId: offer.offerId },
        });
        expect(response.status()).toBe(200);
        const result = (await response.json()).data;
        if (!seen.has(result.status)) {
          seen.set(result.status, {
            shown: offer.fare.amountMinor,
            body: result,
            searchId: body.searchId,
            offer,
          });
        }
        if (seen.size === 3) break;
      }
    }
    expect([...seen.keys()].sort()).toEqual([
      'AVAILABLE',
      'PRICE_CHANGED',
      'SOLD_OUT',
    ]);
    const available = seen.get('AVAILABLE')!;
    expect(available.body.fare).toMatchObject({
      amountMinor: available.shown,
      priceType: 'LIVE_FARE',
      currency: 'INR',
    });
    expect(Date.parse(available.body.validUntil as string)).toBeGreaterThan(
      Date.now(),
    );
    const changed = seen.get('PRICE_CHANGED')!;
    expect(
      (changed.body.fare as { amountMinor: number }).amountMinor,
    ).toBeGreaterThan(changed.shown);
    expect(changed.body.fare).toMatchObject({ priceType: 'LIVE_FARE' });
    expect(seen.get('SOLD_OUT')!.body).toEqual({ status: 'SOLD_OUT' });

    const recheck = async (searchId: string, offerId: string) => {
      const response = await request.post('search/scheduled/revalidate', {
        data: { searchId, offerId },
      });
      expect(response.status()).toBe(200);
      return (await response.json()).data;
    };
    const stored = async (searchId: string) =>
      (await (await request.get(`search/scheduled/${searchId}`)).json())
        .data as SearchBody;

    // The changed fare is stored: a second recheck is AVAILABLE at it, the
    // search shows it, and its validity never outlasts the search.
    const newFare = changed.body.fare as Offer['fare'];
    const second = await recheck(changed.searchId, changed.offer.offerId);
    expect(second.status).toBe('AVAILABLE');
    expect(second.fare).toEqual(newFare);
    const searchExpiry = Date.parse(changed.offer.validUntil);
    expect(Date.parse(second.validUntil)).toBeLessThanOrEqual(searchExpiry);
    expect(Date.parse(changed.body.validUntil as string)).toBeLessThanOrEqual(
      searchExpiry,
    );
    const after = (await stored(changed.searchId)).results.find(
      (o) => o.offerId === changed.offer.offerId,
    )!;
    expect(after.fare).toEqual(newFare);
    expect(after.validUntil).toBe(second.validUntil);

    // A sold-out offer leaves the results and stays sold out.
    const sold = seen.get('SOLD_OUT')!;
    const listed = (await stored(sold.searchId)).results.map((o) => o.offerId);
    expect(listed).not.toContain(sold.offer.offerId);
    expect(await recheck(sold.searchId, sold.offer.offerId)).toEqual({
      status: 'SOLD_OUT',
    });
  });

  test('business and premium economy are sold on some metro flights', async ({
    request,
  }) => {
    for (const cabin of ['BUSINESS', 'PREMIUM_ECONOMY']) {
      let found = 0;
      for (let day = 40; day < 50 && found === 0; day += 1) {
        const body = await search(request, {
          originId: del,
          destinationId: bom,
          departureDate: inDays(day),
          passengers: { adults: 1, children: 0, infants: 0 },
          cabin,
        });
        found = body.results.length;
        for (const offer of body.results) {
          expect(offer.fare.priceType).toBe('LIVE_FARE');
        }
      }
      expect(found, cabin).toBeGreaterThan(0);
    }
  });

  test('fare rules show cancellation and change conditions', async ({
    request,
  }) => {
    const body = await search(request, {
      originId: del,
      destinationId: bom,
      departureDate: inDays(15),
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'ECONOMY',
    });
    const saver = body.results.find((o) => o.fare.fareFamily === 'SAVER')!;
    const flexi = body.results.find((o) => o.fare.fareFamily === 'FLEXI')!;
    const rules = async (offerId: string) => {
      const response = await request.get(
        `search/scheduled/${body.searchId}/offers/${offerId}/fare-rules`,
      );
      expect(response.status()).toBe(200);
      return (await response.json()).data;
    };
    const s = await rules(saver.offerId);
    expect(s.offerId).toBe(saver.offerId);
    expect(s.cancellation).toEqual({ refundable: false });
    expect(s.change).toEqual({ allowed: true, feeMinor: 350000 });
    expect(s.rules.map((r: { title: string }) => r.title)).toEqual([
      'Baggage',
      'Cancellation',
      'Changes',
    ]);
    const f = await rules(flexi.offerId);
    expect(f.cancellation).toEqual({ refundable: true, feeMinor: 300000 });
    expect(f.change).toEqual({ allowed: true, feeMinor: 0 });

    const unknown = await request.get(
      `search/scheduled/${body.searchId}/offers/${crypto.randomUUID()}/fare-rules`,
    );
    expect(unknown.status()).toBe(404);
  });

  test('an unknown or expired search answers 404', async ({ request }) => {
    const unknown = await request.get(
      `search/scheduled/${crypto.randomUUID()}`,
    );
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error.code).toBe('NOT_FOUND');

    const body = await search(request, {
      originId: bom,
      destinationId: blr,
      departureDate: inDays(18),
      passengers: { adults: 1, children: 0, infants: 0 },
      cabin: 'ECONOMY',
    });
    const offerId = body.results[0].offerId;
    await withPrisma(async (prisma) => {
      const row = await prisma.search.findUniqueOrThrow({
        where: { id: body.searchId },
      });
      await prisma.search.update({
        where: { id: body.searchId },
        data: {
          preferences: {
            ...(row.preferences as Record<string, unknown>),
            validUntil: new Date(Date.now() - 1000).toISOString(),
          },
        },
      });
    });
    for (const response of [
      await request.get(`search/scheduled/${body.searchId}`),
      await request.get(
        `search/scheduled/${body.searchId}/offers/${offerId}/fare-rules`,
      ),
      await request.post('search/scheduled/revalidate', {
        data: { searchId: body.searchId, offerId },
      }),
    ]) {
      expect(response.status()).toBe(404);
    }
  });

  test('a charter search id is not a scheduled search', async ({ request }) => {
    const id = crypto.randomUUID();
    await withPrisma((prisma) =>
      prisma.search.create({
        data: {
          id,
          category: 'PRIVATE_CHARTER',
          tripType: 'ONE_WAY',
          legs: [],
          passengerCount: 1,
          results: [],
          resultCount: 0,
          durationMs: 0,
        },
      }),
    );
    const response = await request.get(`search/scheduled/${id}`);
    expect(response.status()).toBe(404);
  });
});
