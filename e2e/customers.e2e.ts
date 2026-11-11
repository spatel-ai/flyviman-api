import { expect, test } from '@playwright/test';
import { registerCustomer } from './support/data.js';
import { csrfHeaders, signIn } from './support/session.js';

const PASSENGER = {
  firstName: 'Kavya',
  lastName: 'Rao',
  dateOfBirth: '1990-04-12',
  gender: 'FEMALE',
  nationality: 'IN',
  documentType: 'PASSPORT',
  documentNumber: 'P1234567',
  documentExpiry: '2031-01-31',
  specialAssistance: 'Wheelchair to the aircraft',
};

test.describe('PATCH /me', () => {
  test('updates the customer profile', async ({ request }) => {
    await registerCustomer(request);
    const response = await request.patch('me', {
      headers: await csrfHeaders(request),
      data: { lastName: 'Menon', dateOfBirth: '1988-02-29', nationality: 'IN' },
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).data).toEqual({
      firstName: 'Asha',
      lastName: 'Menon',
      dateOfBirth: '1988-02-29',
      nationality: 'IN',
    });
    expect((await (await request.get('me')).json()).data.profile.lastName).toBe(
      'Menon',
    );
  });

  test('rejects an impossible date and an unknown field', async ({
    request,
  }) => {
    await registerCustomer(request);
    const headers = await csrfHeaders(request);
    const badDate = await request.patch('me', {
      headers,
      data: { dateOfBirth: '1990-02-30' },
    });
    expect(badDate.status()).toBe(400);
    const extra = await request.patch('me', {
      headers,
      data: { role: 'SUPER_ADMIN' },
    });
    expect(extra.status()).toBe(400);
    expect((await extra.json()).error.code).toBe('VALIDATION_ERROR');
  });

  test('is for customers only', async ({ request }) => {
    await signIn(request, 'ops');
    const response = await request.patch('me', {
      headers: await csrfHeaders(request),
      data: { firstName: 'Nope' },
    });
    expect(response.status()).toBe(403);
  });

  test('refuses a caller who is not signed in', async ({ request }) => {
    expect(
      (await request.patch('me', { data: { firstName: 'X' } })).status(),
    ).toBe(401);
  });
});

test.describe('saved passengers', () => {
  test('a customer adds, lists, updates and removes a passenger', async ({
    request,
  }) => {
    await registerCustomer(request);
    const headers = await csrfHeaders(request);

    const created = await request.post('me/passengers', {
      headers,
      data: PASSENGER,
    });
    expect(created.status()).toBe(201);
    const passenger = (await created.json()).data;
    expect(passenger).toMatchObject(PASSENGER);

    const list = await (await request.get('me/passengers')).json();
    expect(list.data).toHaveLength(1);
    // The owner sees their own document number in full.
    expect(list.data[0].documentNumber).toBe('P1234567');

    const updated = await request.patch(`me/passengers/${passenger.id}`, {
      headers,
      data: { specialAssistance: null, documentNumber: 'Z7654321' },
    });
    expect(updated.status()).toBe(200);
    expect((await updated.json()).data).toMatchObject({
      firstName: 'Kavya',
      specialAssistance: null,
      documentNumber: 'Z7654321',
    });

    const removed = await request.delete(`me/passengers/${passenger.id}`, {
      headers,
    });
    expect(removed.status()).toBe(204);
    expect((await (await request.get('me/passengers')).json()).data).toEqual(
      [],
    );
    const again = await request.delete(`me/passengers/${passenger.id}`, {
      headers,
    });
    expect(again.status()).toBe(404);
  });

  test('another customer cannot see, change or remove it', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await registerCustomer(request);
    const created = await request.post('me/passengers', {
      headers: await csrfHeaders(request),
      data: PASSENGER,
    });
    const { id } = (await created.json()).data;

    const other = await playwright.request.newContext({ baseURL });
    await registerCustomer(other);
    const headers = await csrfHeaders(other);

    expect((await (await other.get('me/passengers')).json()).data).toEqual([]);
    const patch = await other.patch(`me/passengers/${id}`, {
      headers,
      data: { firstName: 'Mine' },
    });
    expect(patch.status()).toBe(404);
    expect((await patch.json()).error.code).toBe('NOT_FOUND');
    expect(
      (await other.delete(`me/passengers/${id}`, { headers })).status(),
    ).toBe(404);
    await other.dispose();

    // Untouched for its owner.
    expect(
      (await (await request.get('me/passengers')).json()).data[0].firstName,
    ).toBe('Kavya');
  });

  test('rejects invalid details', async ({ request }) => {
    await registerCustomer(request);
    const response = await request.post('me/passengers', {
      headers: await csrfHeaders(request),
      data: {
        firstName: '',
        lastName: 'Rao',
        nationality: 'India',
        documentNumber: '<script>',
      },
    });
    expect(response.status()).toBe(400);
    const fields = (await response.json()).error.details.map(
      (d: { field: string }) => d.field,
    );
    expect(fields).toEqual(
      expect.arrayContaining(['firstName', 'nationality', 'documentNumber']),
    );
  });

  test('a name cannot be set to null', async ({ request }) => {
    await registerCustomer(request);
    const headers = await csrfHeaders(request);
    const created = await request.post('me/passengers', {
      headers,
      data: PASSENGER,
    });
    const { id } = (await created.json()).data;
    const response = await request.patch(`me/passengers/${id}`, {
      headers,
      data: { firstName: null },
    });
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  test('is closed to callers who are not signed in and to other roles', async ({
    request,
  }) => {
    expect((await request.get('me/passengers')).status()).toBe(401);
    await signIn(request, 'operatorAdmin');
    expect((await request.get('me/passengers')).status()).toBe(403);
    await signIn(request, 'ops');
    // Operations staff have no route to a customer's saved passengers.
    expect((await request.get('me/passengers')).status()).toBe(403);
  });
});

test.describe('POST /me/consents', () => {
  test('records terms at the published version, whatever the client sends', async ({
    request,
  }) => {
    await registerCustomer(request);
    const published = (
      await (await request.get('content/policies/terms')).json()
    ).data.version;
    const response = await request.post('me/consents', {
      headers: await csrfHeaders(request),
      data: { type: 'TERMS', version: 'made-up' },
    });
    expect(response.status()).toBe(201);
    expect((await response.json()).data).toMatchObject({
      type: 'TERMS',
      version: published,
    });
  });

  test('needs a version for marketing consent', async ({ request }) => {
    await registerCustomer(request);
    const headers = await csrfHeaders(request);
    expect(
      (
        await request.post('me/consents', {
          headers,
          data: { type: 'MARKETING' },
        })
      ).status(),
    ).toBe(400);
    const ok = await request.post('me/consents', {
      headers,
      data: { type: 'MARKETING', version: 'v1' },
    });
    expect(ok.status()).toBe(201);
  });
});

test.describe('in-app notifications', () => {
  test('a new customer has a welcome notification and can mark it read', async ({
    request,
  }) => {
    await registerCustomer(request);
    const list = await (await request.get('me/notifications')).json();
    expect(list.meta.total).toBe(1);
    expect(list.data[0]).toMatchObject({
      templateKey: 'customer.welcome',
      readAt: null,
    });
    expect(list.data[0].title).toBe('Welcome to Flyviman');

    const read = await request.patch(
      `me/notifications/${list.data[0].id}/read`,
      {
        headers: await csrfHeaders(request),
      },
    );
    expect(read.status()).toBe(200);
    expect((await read.json()).data.readAt).toBeTruthy();
  });

  test('another user cannot mark it read', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await registerCustomer(request);
    const { id } = (await (await request.get('me/notifications')).json())
      .data[0];

    const other = await playwright.request.newContext({ baseURL });
    await registerCustomer(other);
    const response = await other.patch(`me/notifications/${id}/read`, {
      headers: await csrfHeaders(other),
    });
    expect(response.status()).toBe(404);
    await other.dispose();
  });

  test('refuses a caller who is not signed in', async ({ request }) => {
    expect((await request.get('me/notifications')).status()).toBe(401);
  });
});
