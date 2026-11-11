import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import {
  registerCustomer,
  registerOperator,
  uploadJpeg,
  uploadPdf,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { csrfHeaders, signIn } from './support/session.js';

const COMPANY = {
  registrationNumber: 'U62200MH2015PTC123456',
  taxNumber: '27AAACS1234A1Z5',
  businessAddress: {
    line1: 'Hangar 4, Juhu Aerodrome',
    city: 'Mumbai',
    state: 'Maharashtra',
    postalCode: '400049',
    country: 'IN',
  },
  serviceCategories: ['PRIVATE_CHARTER', 'HELICOPTER'],
  operatingRegions: ['Maharashtra', 'Goa'],
};

async function addOperatorDocument(request: APIRequestContext, type: string) {
  const headers = await csrfHeaders(request);
  const fileId = await uploadPdf(request, headers, `${type.toLowerCase()}.pdf`);
  const response = await request.post('operator/documents', {
    headers,
    data: { type, fileId, expiresAt: '2030-12-31' },
  });
  expect(response.status()).toBe(201);
}

async function asReviewer(
  playwright: {
    request: { newContext(options: object): Promise<APIRequestContext> };
  },
  baseURL: string | undefined,
) {
  const reviewer = await playwright.request.newContext({ baseURL });
  await signIn(reviewer, 'ops');
  return { reviewer, headers: await csrfHeaders(reviewer) };
}

/** An approved operator on `request`, plus an active home-base location id. */
async function approvedOperator(
  request: APIRequestContext,
  playwright: {
    request: { newContext(options: object): Promise<APIRequestContext> };
  },
  baseURL: string | undefined,
) {
  await registerOperator(request);
  const patch = await request.patch('operator/profile', {
    headers: await csrfHeaders(request),
    data: COMPANY,
  });
  expect(patch.status()).toBe(200);
  const operatorId = (await patch.json()).data.id as string;
  await addOperatorDocument(request, 'AOC');
  await addOperatorDocument(request, 'INSURANCE');
  expect(
    (
      await request.post('operator/profile/submit', {
        headers: await csrfHeaders(request),
      })
    ).status(),
  ).toBe(200);

  const { reviewer, headers } = await asReviewer(playwright, baseURL);
  const detail = (
    await (await reviewer.get(`admin/operators/${operatorId}`)).json()
  ).data;
  for (const document of detail.documents) {
    expect(
      (
        await reviewer.post(`admin/documents/${document.id}/verify`, {
          headers,
          data: { decision: 'VERIFIED' },
        })
      ).status(),
    ).toBe(200);
  }
  expect(
    (
      await reviewer.post(`admin/operators/${operatorId}/approve`, { headers })
    ).status(),
  ).toBe(200);

  const locations = await request.get('locations', { params: { pageSize: 1 } });
  expect(locations.status()).toBe(200);
  const homeBaseId = (await locations.json()).data[0].id as string;
  return { homeBaseId };
}

function aircraftBody(homeBaseId: string, registration?: string) {
  return {
    registration:
      registration ?? `VT-${randomUUID().slice(0, 5).toUpperCase()}`,
    manufacturer: 'Cessna',
    model: 'Citation CJ3+',
    category: 'LIGHT_JET',
    wingType: 'FIXED_WING',
    passengerCapacity: 8,
    baggageCapacityKg: 500,
    rangeKm: 3200,
    cruiseSpeedKmh: 770,
    homeBaseId,
    pricingModel: 'HOURLY',
    specifications: { cabin: 'Light jet cabin' },
  };
}

async function addAircraftDocument(
  request: APIRequestContext,
  aircraftId: string,
  type: string,
) {
  const headers = await csrfHeaders(request);
  const fileId = await uploadPdf(
    request,
    headers,
    `${type.toLowerCase()}.pdf`,
    'AIRCRAFT_DOCUMENT',
  );
  const response = await request.post(
    `operator/aircraft/${aircraftId}/documents`,
    {
      headers,
      data: { type, fileId, expiresAt: '2030-12-31' },
    },
  );
  expect(response.status()).toBe(201);
  return (await response.json()).data as { id: string };
}

test.describe('operator aircraft', () => {
  test('create, list, detail, update, media, documents and submit', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const body = aircraftBody(homeBaseId);

    const created = await request.post('operator/aircraft', {
      headers,
      data: body,
    });
    expect(created.status()).toBe(201);
    const aircraft = (await created.json()).data;
    expect(aircraft).toMatchObject({
      registration: body.registration,
      listingStatus: 'DRAFT',
      availabilityStatus: 'AVAILABLE',
      category: 'LIGHT_JET',
    });
    expect(aircraft.missing).toEqual(
      expect.arrayContaining([
        'document:REGISTRATION',
        'document:AIRWORTHINESS',
        'document:INSURANCE',
      ]),
    );

    const list = await request.get('operator/aircraft');
    expect(list.status()).toBe(200);
    expect((await list.json()).data).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: aircraft.id,
          registration: body.registration,
        }),
      ]),
    );

    const detail = await request.get(`operator/aircraft/${aircraft.id}`);
    expect(detail.status()).toBe(200);
    expect((await detail.json()).data.specifications).toEqual({
      cabin: 'Light jet cabin',
    });

    const photoId = await uploadJpeg(request, headers);
    const media = await request.post(`operator/aircraft/${aircraft.id}/media`, {
      headers,
      data: { fileId: photoId, kind: 'PHOTO' },
    });
    expect(media.status()).toBe(201);
    const mediaRow = (await media.json()).data;

    const specs = await request.patch(`operator/aircraft/${aircraft.id}`, {
      headers,
      data: { specifications: { cabin: 'Refreshed cabin' } },
    });
    expect(specs.status()).toBe(200);
    expect((await specs.json()).data.listingStatus).toBe('DRAFT');

    for (const type of ['REGISTRATION', 'AIRWORTHINESS', 'INSURANCE']) {
      await addAircraftDocument(request, aircraft.id, type);
    }

    const ready = await request.get(`operator/aircraft/${aircraft.id}`);
    expect((await ready.json()).data.missing).toEqual([]);

    const submit = await request.post(
      `operator/aircraft/${aircraft.id}/submit`,
      {
        headers,
      },
    );
    expect(submit.status()).toBe(200);
    expect((await submit.json()).data.listingStatus).toBe('PENDING_REVIEW');

    const locked = await request.patch(`operator/aircraft/${aircraft.id}`, {
      headers,
      data: { passengerCapacity: 7 },
    });
    expect(locked.status()).toBe(409);
    expect((await locked.json()).error.code).toBe('AIRCRAFT_UNDER_REVIEW');

    const removeLocked = await request.delete(
      `operator/aircraft/${aircraft.id}/media/${mediaRow.id}`,
      { headers },
    );
    expect(removeLocked.status()).toBe(409);
  });

  test('an operator who is not approved cannot create an aircraft', async ({
    request,
  }) => {
    await registerOperator(request);
    const locations = await request.get('locations', {
      params: { pageSize: 1 },
    });
    const homeBaseId = (await locations.json()).data[0].id as string;
    const created = await request.post('operator/aircraft', {
      headers: await csrfHeaders(request),
      data: aircraftBody(homeBaseId),
    });
    expect(created.status()).toBe(409);
    expect((await created.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
  });

  test('an approved operator cannot submit an incomplete aircraft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const incomplete = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    expect(incomplete.status()).toBe(201);
    const id = (await incomplete.json()).data.id as string;
    const refused = await request.post(`operator/aircraft/${id}/submit`, {
      headers,
    });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.code).toBe(
      'AIRCRAFT_PROFILE_INCOMPLETE',
    );
  });

  test('availability status, wing match and unique registration', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    expect(created.status()).toBe(201);
    const aircraft = (await created.json()).data;

    const status = await request.patch(
      `operator/aircraft/${aircraft.id}/availability-status`,
      { headers, data: { status: 'MAINTENANCE' } },
    );
    expect(status.status()).toBe(200);
    expect((await status.json()).data.availabilityStatus).toBe('MAINTENANCE');

    const bad = await request.post('operator/aircraft', {
      headers,
      data: {
        ...aircraftBody(homeBaseId),
        category: 'HELICOPTER',
        wingType: 'FIXED_WING',
      },
    });
    expect(bad.status()).toBe(400);

    const again = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId, aircraft.registration),
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe(
      'AIRCRAFT_REGISTRATION_IN_USE',
    );
  });

  test('media can be removed while draft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const id = (await created.json()).data.id as string;
    const media = await request.post(`operator/aircraft/${id}/media`, {
      headers,
      data: {
        fileId: await uploadJpeg(request, headers),
        kind: 'PHOTO',
      },
    });
    expect(media.status()).toBe(201);
    const mediaId = (await media.json()).data.id as string;
    expect(
      (
        await request.delete(`operator/aircraft/${id}/media/${mediaId}`, {
          headers,
        })
      ).status(),
    ).toBe(204);
  });

  test('customers cannot manage aircraft', async ({ playwright, baseURL }) => {
    const customer = await playwright.request.newContext({ baseURL });
    await registerCustomer(customer);
    expect((await customer.get('operator/aircraft')).status()).toBe(403);
  });

  test('a material edit on an approved aircraft returns it to PENDING_REVIEW', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const aircraft = (await created.json()).data;
    for (const type of ['REGISTRATION', 'AIRWORTHINESS', 'INSURANCE']) {
      await addAircraftDocument(request, aircraft.id, type);
    }

    // Admin approve arrives in step 4; force APPROVED so the material-edit
    // rule can be exercised now.
    await withPrisma(async (prisma) => {
      await prisma.aircraft.update({
        where: { id: aircraft.id },
        data: { listingStatus: 'APPROVED' },
      });
    });

    const photo = await request.post(`operator/aircraft/${aircraft.id}/media`, {
      headers,
      data: {
        fileId: await uploadJpeg(request, headers),
        kind: 'PHOTO',
      },
    });
    expect(photo.status()).toBe(201);
    expect(
      (await (await request.get(`operator/aircraft/${aircraft.id}`)).json())
        .data.listingStatus,
    ).toBe('APPROVED');

    const specs = await request.patch(`operator/aircraft/${aircraft.id}`, {
      headers,
      data: { specifications: { cabin: 'Still approved' } },
    });
    expect(specs.status()).toBe(200);
    expect((await specs.json()).data.listingStatus).toBe('APPROVED');

    const material = await request.patch(`operator/aircraft/${aircraft.id}`, {
      headers,
      data: { passengerCapacity: 6 },
    });
    expect(material.status()).toBe(200);
    expect((await material.json()).data.listingStatus).toBe('PENDING_REVIEW');
  });

  test('a suspended aircraft cannot be edited back into review', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const aircraft = (await created.json()).data;
    await withPrisma(async (prisma) => {
      await prisma.aircraft.update({
        where: { id: aircraft.id },
        data: { listingStatus: 'SUSPENDED', reviewNote: 'Grounded' },
      });
    });
    const edit = await request.patch(`operator/aircraft/${aircraft.id}`, {
      headers,
      data: { cruiseSpeedKmh: 400 },
    });
    expect(edit.status()).toBe(409);
    expect((await edit.json()).error.code).toBe('AIRCRAFT_SUSPENDED');
    const detail = await request.get(`operator/aircraft/${aircraft.id}`);
    expect((await detail.json()).data).toMatchObject({
      listingStatus: 'SUSPENDED',
      reviewNote: 'Grounded',
    });
  });

  test('another operator cannot read or change this aircraft or its file', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const aircraft = (await created.json()).data;
    const media = await request.post(`operator/aircraft/${aircraft.id}/media`, {
      headers,
      data: {
        fileId: await uploadJpeg(request, headers),
        kind: 'PHOTO',
      },
    });
    const fileId = (await media.json()).data.fileId as string;

    const other = await playwright.request.newContext({ baseURL });
    await registerOperator(other);
    expect((await other.get(`operator/aircraft/${aircraft.id}`)).status()).toBe(
      404,
    );
    expect((await other.get(`documents/${fileId}/download`)).status()).toBe(
      404,
    );

    const rival = await playwright.request.newContext({ baseURL });
    await approvedOperator(rival, playwright, baseURL);
    const rivalHeaders = await csrfHeaders(rival);
    expect(
      (
        await rival.patch(`operator/aircraft/${aircraft.id}`, {
          headers: rivalHeaders,
          data: { passengerCapacity: 4 },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await rival.post(`operator/aircraft/${aircraft.id}/media`, {
          headers: rivalHeaders,
          data: {
            fileId: await uploadJpeg(rival, rivalHeaders),
            kind: 'PHOTO',
          },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await rival.post(`operator/aircraft/${aircraft.id}/documents`, {
          headers: rivalHeaders,
          data: {
            type: 'INSURANCE',
            fileId: await uploadPdf(
              rival,
              rivalHeaders,
              'insurance.pdf',
              'AIRCRAFT_DOCUMENT',
            ),
          },
        })
      ).status(),
    ).toBe(404);
    await other.dispose();
    await rival.dispose();
  });

  test('a document cannot expire before it is issued, or already be expired', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const id = (await created.json()).data.id as string;
    const fileId = await uploadPdf(
      request,
      headers,
      'insurance.pdf',
      'AIRCRAFT_DOCUMENT',
    );
    const expired = await request.post(`operator/aircraft/${id}/documents`, {
      headers,
      data: { type: 'INSURANCE', fileId, expiresAt: '2000-01-01' },
    });
    expect(expired.status()).toBe(400);
    expect((await expired.json()).error.details[0].field).toBe('expiresAt');

    const fileId2 = await uploadPdf(
      request,
      headers,
      'insurance-2.pdf',
      'AIRCRAFT_DOCUMENT',
    );
    const reversed = await request.post(`operator/aircraft/${id}/documents`, {
      headers,
      data: {
        type: 'INSURANCE',
        fileId: fileId2,
        issuedAt: '2030-12-31',
        expiresAt: '2030-01-01',
      },
    });
    expect(reversed.status()).toBe(400);
    expect((await reversed.json()).error.details[0].field).toBe('issuedAt');
  });

  test('submit refuses an expired required document, and a renewed one counts', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const id = (await created.json()).data.id as string;
    for (const type of ['REGISTRATION', 'AIRWORTHINESS', 'INSURANCE']) {
      await addAircraftDocument(request, id, type);
    }
    // The insurance lapses after it was uploaded.
    await withPrisma(async (prisma) => {
      await prisma.aircraftDocument.updateMany({
        where: { aircraftId: id, type: 'INSURANCE' },
        data: { expiresAt: new Date('2020-01-01') },
      });
    });

    const refused = await request.post(`operator/aircraft/${id}/submit`, {
      headers,
    });
    expect(refused.status()).toBe(422);
    expect((await refused.json()).error.details).toEqual([
      { field: 'document:INSURANCE', issue: 'is required' },
    ]);

    // The renewal is attached while the lapsed one is still on file.
    await addAircraftDocument(request, id, 'INSURANCE');
    const submitted = await request.post(`operator/aircraft/${id}/submit`, {
      headers,
    });
    expect(submitted.status()).toBe(200);
    expect((await submitted.json()).data.listingStatus).toBe('PENDING_REVIEW');
  });

  test('a PDF cannot be attached as a photo', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const id = (await created.json()).data.id as string;
    const media = await request.post(`operator/aircraft/${id}/media`, {
      headers,
      data: {
        fileId: await uploadPdf(
          request,
          headers,
          'photo.pdf',
          'AIRCRAFT_PHOTO',
        ),
        kind: 'PHOTO',
      },
    });
    expect(media.status()).toBe(400);
    expect((await media.json()).error.details[0].field).toBe('fileId');
  });

  test('an unchanged edit writes nothing and is not audited', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const body = aircraftBody(homeBaseId);
    const created = await request.post('operator/aircraft', {
      headers,
      data: body,
    });
    const id = (await created.json()).data.id as string;
    const audits = () =>
      withPrisma((prisma) =>
        prisma.auditLog.count({
          where: { entityId: id, action: 'aircraft.update' },
        }),
      );

    for (const data of [
      {},
      { passengerCapacity: body.passengerCapacity, rangeKm: body.rangeKm },
    ]) {
      const same = await request.patch(`operator/aircraft/${id}`, {
        headers,
        data,
      });
      expect(same.status()).toBe(200);
      expect((await same.json()).data.listingStatus).toBe('DRAFT');
    }
    expect(await audits()).toBe(0);

    const changed = await request.patch(`operator/aircraft/${id}`, {
      headers,
      data: { model: 'Citation CJ4' },
    });
    expect(changed.status()).toBe(200);
    expect(await audits()).toBe(1);
    const record = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: id, action: 'aircraft.update' },
      }),
    );
    expect(record.before).toMatchObject({ model: 'Citation CJ3+' });
    expect(record.after).toMatchObject({
      model: 'Citation CJ4',
      fields: ['model'],
    });
  });

  test('operator staff have no aircraft routes yet', async ({ request }) => {
    const { email } = await registerOperator(request);
    // Staff invitations arrive in step 7; the role is checked on every request.
    await withPrisma(async (prisma) => {
      await prisma.user.update({
        where: { email },
        data: { role: 'OPERATOR_STAFF' },
      });
    });
    expect((await request.get('operator/aircraft')).status()).toBe(403);
    expect(
      (
        await request.patch(`operator/aircraft/${randomUUID()}`, {
          headers: await csrfHeaders(request),
          data: { passengerCapacity: 4 },
        })
      ).status(),
    ).toBe(403);
  });

  test('a suspended operator can still ground an aircraft but not add one', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const created = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const id = (await created.json()).data.id as string;
    await withPrisma(async (prisma) => {
      const { operatorId } = await prisma.aircraft.findUniqueOrThrow({
        where: { id },
        select: { operatorId: true },
      });
      await prisma.operator.update({
        where: { id: operatorId },
        data: { status: 'SUSPENDED' },
      });
    });

    const grounded = await request.patch(
      `operator/aircraft/${id}/availability-status`,
      { headers, data: { status: 'MAINTENANCE' } },
    );
    expect(grounded.status()).toBe(200);
    expect((await grounded.json()).data.availabilityStatus).toBe('MAINTENANCE');

    const another = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    expect(another.status()).toBe(409);
    expect((await another.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
  });
});
