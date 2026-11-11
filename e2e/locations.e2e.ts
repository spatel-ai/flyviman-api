import { APIRequestContext, expect, test } from '@playwright/test';

interface Location {
  id: string;
  type: string;
  name: string;
  iata: string | null;
  icao: string | null;
  city: string | null;
}

async function search(
  request: APIRequestContext,
  params: Record<string, string | number>,
): Promise<{ data: Location[]; meta: { total: number } }> {
  const response = await request.get('locations', { params });
  expect(response.status()).toBe(200);
  return response.json();
}

test.describe('GET /locations', () => {
  test('anyone can search, and an exact IATA or ICAO code ranks first', async ({
    request,
  }) => {
    for (const q of ['BOM', 'bom', 'VABB']) {
      const { data } = await search(request, { q });
      expect(data[0]).toMatchObject({ iata: 'BOM', icao: 'VABB' });
    }
  });

  test('a city ranks places in that city first, airports before heliports, without internal fields', async ({
    request,
  }) => {
    const { data } = await search(request, { q: 'mumbai', pageSize: 50 });
    expect(data.map((location) => location.name)).toEqual([
      'Chhatrapati Shivaji Maharaj International Airport',
      'Juhu Aerodrome',
      'Mahalaxmi Race Course Helipad',
      // Matches only part of its city's name, so it ranks lower.
      'Navi Mumbai International Airport',
    ]);

    const airport = data.find((l) => l.icao === 'VABB');
    expect(airport).toMatchObject({
      country: 'IN',
      timeZone: 'Asia/Kolkata',
      capabilities: {
        runwayLengthM: expect.any(Number),
        nightOperations: true,
        helicopterApproved: true,
      },
    });
    // No lighting data in the source: unknown, not "no".
    expect(data.find((l) => l.icao === 'VAJJ')).toMatchObject({
      capabilities: { nightOperations: null },
    });
    expect(JSON.stringify(data)).not.toMatch(/charges|externalRef|isActive/);
  });

  test('filters by type and pages through the results', async ({ request }) => {
    const first = await search(request, { type: 'HELIPORT', pageSize: 5 });
    expect(first.data).toHaveLength(5);
    expect(first.data.every((l) => l.type === 'HELIPORT')).toBe(true);
    expect(first.meta).toMatchObject({ page: 1, pageSize: 5 });
    expect(first.meta.total).toBeGreaterThan(5);

    const second = await search(request, {
      type: 'HELIPORT',
      pageSize: 5,
      page: 2,
    });
    const firstIds = new Set(first.data.map((l) => l.id));
    expect(second.data.some((l) => firstIds.has(l.id))).toBe(false);
  });

  test('matches ICAO codes by prefix only for code-like terms', async ({
    request,
  }) => {
    const byCode = await search(request, { q: 'VAB', pageSize: 100 });
    expect(byCode.data.map((l) => l.icao)).toEqual(
      expect.arrayContaining(['VABB', 'VABO']),
    );

    // Every Indian ICAO code starts with V; "va" must match by name or city.
    const short = await search(request, { q: 'va', pageSize: 100 });
    for (const location of short.data) {
      expect(`${location.name} ${location.city}`.toLowerCase()).toContain('va');
    }
  });

  test('matches LIKE wildcards literally', async ({ request }) => {
    for (const q of ['%', '_', 'mum%bai']) {
      const { data, meta } = await search(request, { q });
      expect(data).toEqual([]);
      expect(meta.total).toBe(0);
    }
  });

  test('refuses an unknown type, an oversized page and a page too far', async ({
    request,
  }) => {
    const invalid: Record<string, string | number>[] = [
      { type: 'SPACEPORT' },
      { pageSize: 101 },
      { page: 10_001 },
    ];
    for (const params of invalid) {
      const response = await request.get('locations', { params });
      expect(response.status()).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
  });
});

test.describe('GET /locations/:id', () => {
  test('returns one location', async ({ request }) => {
    const { data } = await search(request, { q: 'DEL' });
    const response = await request.get(`locations/${data[0].id}`);
    expect(response.status()).toBe(200);
    expect((await response.json()).data).toMatchObject({
      id: data[0].id,
      iata: 'DEL',
      type: 'AIRPORT',
    });
  });

  test('answers 404 for an unknown location and 400 for a malformed id', async ({
    request,
  }) => {
    const unknown = await request.get(
      'locations/00000000-0000-4000-8000-000000000000',
    );
    expect(unknown.status()).toBe(404);
    expect((await unknown.json()).error.code).toBe('NOT_FOUND');
    expect((await request.get('locations/not-a-uuid')).status()).toBe(400);
  });
});
