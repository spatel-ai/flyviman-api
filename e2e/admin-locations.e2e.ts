import { randomInt, randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { csrfHeaders, signIn } from './support/session.js';

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** A code of `length` letters that no location holds yet. */
async function freeCode(
  request: APIRequestContext,
  length: 3 | 4,
): Promise<string> {
  for (;;) {
    const code = Array.from(
      { length },
      () => LETTERS[randomInt(LETTERS.length)],
    ).join('');
    const response = await request.get('admin/locations', {
      params: { q: code },
    });
    const { data } = await response.json();
    if (
      !data.some((l: { iata: string; icao: string }) =>
        [l.iata, l.icao].includes(code),
      )
    ) {
      return code;
    }
  }
}

function newHelipad(overrides: Record<string, unknown> = {}) {
  return {
    type: 'LANDING_SITE',
    name: `Test Helipad ${randomUUID()}`,
    city: 'Kedarnath',
    state: 'Uttarakhand',
    country: 'in',
    latitude: 30.7346,
    longitude: 79.0669,
    timeZone: 'Asia/Kolkata',
    capabilities: {
      runwayLengthM: null,
      nightOperations: false,
      helicopterApproved: true,
    },
    ...overrides,
  };
}

async function audits(request: APIRequestContext, id: string, action: string) {
  const response = await request.get('admin/audit-logs', {
    params: { entityType: 'Location', entityId: id, action },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

test.describe('POST /admin/locations', () => {
  test('operations add a location that anyone can then find, and it is audited', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const icao = await freeCode(request, 4);
    const body = newHelipad({ icao: icao.toLowerCase() });

    const created = await request.post('admin/locations', {
      headers: await csrfHeaders(request),
      data: body,
    });
    expect(created.status()).toBe(201);
    const location = (await created.json()).data;
    expect(location).toMatchObject({
      name: body.name,
      icao,
      iata: null,
      country: 'IN',
      isActive: true,
      charges: null,
      externalRef: null,
    });

    const found = await request.get('locations', {
      params: { q: body.name },
    });
    expect((await found.json()).data).toEqual([
      expect.objectContaining({ id: location.id, icao }),
    ]);

    const [entry] = await audits(request, location.id, 'location.create');
    expect(entry).toMatchObject({
      actorRole: 'OPS',
      after: { name: body.name, icao },
    });
  });

  test('refuses a code another location holds', async ({ request }) => {
    await signIn(request, 'superAdmin');
    const response = await request.post('admin/locations', {
      headers: await csrfHeaders(request),
      data: newHelipad({ iata: 'bom', icao: 'VABB' }),
    });
    expect(response.status()).toBe(409);
    const { error } = await response.json();
    expect(error.code).toBe('LOCATION_CODE_IN_USE');
    expect(error.details).toEqual([
      { field: 'iata', issue: 'is already in use' },
      { field: 'icao', issue: 'is already in use' },
    ]);
  });

  test('validates codes, coordinates, time zone and charges', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const headers = await csrfHeaders(request);
    const charge = {
      category: 'HELICOPTER',
      landingMinor: 500000,
      parkingMinor: 0,
      handlingMinor: 250000,
    };
    const invalid = [
      { iata: 'BO' },
      { icao: 'VAB1' },
      { latitude: 91 },
      { timeZone: 'India/Mumbai' },
      { country: 'India' },
      { charges: { currency: 'USD', categories: [charge] } },
      { charges: { currency: 'INR', categories: [charge, charge] } },
      {
        charges: {
          currency: 'INR',
          categories: [{ ...charge, landingMinor: -1 }],
        },
      },
      {
        charges: {
          currency: 'INR',
          categories: [{ ...charge, landingMinor: 10.5 }],
        },
      },
      { capabilities: { runwayLengthM: 0, helicopterApproved: true } },
      {
        capabilities: {
          helicopterApproved: true,
        },
      },
      { charges: { currency: 'INR', categories: [] } },
      { externalRef: 'ourairports:FAKE' },
    ];
    for (const overrides of invalid) {
      const response = await request.post('admin/locations', {
        headers,
        data: newHelipad(overrides),
      });
      expect(response.status(), JSON.stringify(overrides)).toBe(400);
      expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
    }
  });

  test('is for operations and super administrators only', async ({
    request,
  }) => {
    expect(
      (await request.post('admin/locations', { data: newHelipad() })).status(),
    ).toBe(401);
    for (const account of ['customer', 'operatorAdmin', 'finance'] as const) {
      await signIn(request, account);
      const headers = await csrfHeaders(request);
      expect(
        (
          await request.post('admin/locations', {
            headers,
            data: newHelipad(),
          })
        ).status(),
        account,
      ).toBe(403);
      expect((await request.get('admin/locations')).status(), account).toBe(
        403,
      );
    }
  });
});

test.describe('PATCH /admin/locations/:id', () => {
  test('sets charges and capabilities, auditing only what changed; charges stay internal', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const headers = await csrfHeaders(request);
    const created = await (
      await request.post('admin/locations', { headers, data: newHelipad() })
    ).json();
    const id = created.data.id;
    const charges = {
      currency: 'INR',
      categories: [
        {
          category: 'HELICOPTER',
          landingMinor: 500000,
          parkingMinor: 100000,
          handlingMinor: 250000,
        },
      ],
    };

    const updated = await request.patch(`admin/locations/${id}`, {
      headers,
      data: {
        charges,
        capabilities: {
          runwayLengthM: null,
          nightOperations: true,
          helicopterApproved: true,
        },
        name: created.data.name,
      },
    });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).data).toMatchObject({
      charges,
      capabilities: { nightOperations: true },
    });

    const [entry] = await audits(request, id, 'location.update');
    expect(entry.before).toEqual({
      charges: null,
      capabilities: {
        runwayLengthM: null,
        nightOperations: false,
        helicopterApproved: true,
      },
    });
    expect(entry.after).toMatchObject({ charges });
    expect(Object.keys(entry.after).sort()).toEqual([
      'capabilities',
      'charges',
    ]);

    // Sending the same values again changes nothing and writes no record.
    await request.patch(`admin/locations/${id}`, {
      headers,
      data: { charges },
    });
    expect(await audits(request, id, 'location.update')).toHaveLength(1);

    const detail = await (await request.get(`admin/locations/${id}`)).json();
    expect(detail.data.charges).toEqual(charges);
    const publicDetail = await request.get(`locations/${id}`);
    expect(JSON.stringify(await publicDetail.json())).not.toMatch(
      /charges|landingMinor/,
    );
  });

  test('a deactivated location leaves public search and returns when reactivated', async ({
    request,
  }) => {
    await signIn(request, 'superAdmin');
    const headers = await csrfHeaders(request);
    const body = newHelipad();
    const { data } = await (
      await request.post('admin/locations', { headers, data: body })
    ).json();

    const off = await request.patch(`admin/locations/${data.id}`, {
      headers,
      data: { isActive: false },
    });
    expect((await off.json()).data.isActive).toBe(false);
    expect((await request.get(`locations/${data.id}`)).status()).toBe(404);
    const search = await (
      await request.get('locations', { params: { q: body.name } })
    ).json();
    expect(search.data).toEqual([]);

    const inactive = await (
      await request.get('admin/locations', {
        params: { q: body.name, isActive: 'false' },
      })
    ).json();
    expect(inactive.data.map((l: { id: string }) => l.id)).toEqual([data.id]);

    await request.patch(`admin/locations/${data.id}`, {
      headers,
      data: { isActive: true },
    });
    expect((await request.get(`locations/${data.id}`)).status()).toBe(200);
  });

  test('can clear a code, refuses one in use and a null where a value is required', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const headers = await csrfHeaders(request);
    const iata = await freeCode(request, 3);
    const { data } = await (
      await request.post('admin/locations', {
        headers,
        data: newHelipad({ iata }),
      })
    ).json();
    expect(data.iata).toBe(iata);

    const taken = await request.patch(`admin/locations/${data.id}`, {
      headers,
      data: { iata: 'DEL' },
    });
    expect(taken.status()).toBe(409);
    expect((await taken.json()).error.code).toBe('LOCATION_CODE_IN_USE');

    for (const field of ['name', 'country', 'timeZone', 'isActive']) {
      const response = await request.patch(`admin/locations/${data.id}`, {
        headers,
        data: { [field]: null },
      });
      expect(response.status(), field).toBe(400);
    }

    const cleared = await request.patch(`admin/locations/${data.id}`, {
      headers,
      data: { iata: null },
    });
    expect((await cleared.json()).data.iata).toBeNull();
  });

  test('answers 404 for an unknown location', async ({ request }) => {
    await signIn(request, 'ops');
    const response = await request.patch(
      'admin/locations/00000000-0000-4000-8000-000000000000',
      { headers: await csrfHeaders(request), data: { isActive: false } },
    );
    expect(response.status()).toBe(404);
    expect((await response.json()).error.code).toBe('NOT_FOUND');
  });
});

test.describe('GET /admin/locations', () => {
  test('lists seeded and added locations with internal fields, filtered', async ({
    request,
  }) => {
    await signIn(request, 'ops');
    const response = await request.get('admin/locations', {
      params: { q: 'bom' },
    });
    expect(response.status()).toBe(200);
    const { data } = await response.json();
    expect(data[0]).toMatchObject({
      iata: 'BOM',
      externalRef: 'ourairports:VABB',
      isActive: true,
      createdAt: expect.any(String),
    });

    const heliports = await (
      await request.get('admin/locations', {
        params: { type: 'HELIPORT', pageSize: 100 },
      })
    ).json();
    expect(
      heliports.data.every((l: { type: string }) => l.type === 'HELIPORT'),
    ).toBe(true);
  });
});
