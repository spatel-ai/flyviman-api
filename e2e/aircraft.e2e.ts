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

  test('operations verify the documents, then approve, and the operator is told', async ({
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
    expect(
      (
        await request.post(`operator/aircraft/${aircraft.id}/submit`, {
          headers,
        })
      ).status(),
    ).toBe(200);

    const { reviewer, headers: reviewHeaders } = await asReviewer(
      playwright,
      baseURL,
    );
    const early = await reviewer.post(`admin/aircraft/${aircraft.id}/approve`, {
      headers: reviewHeaders,
    });
    expect(early.status()).toBe(422);
    expect((await early.json()).error.code).toBe(
      'AIRCRAFT_DOCUMENTS_UNVERIFIED',
    );

    const detail = await reviewer.get(`admin/aircraft/${aircraft.id}`);
    expect(detail.status()).toBe(200);
    for (const document of (await detail.json()).data.documents) {
      expect(
        (
          await reviewer.post(
            `admin/aircraft/documents/${document.id}/verify`,
            { headers: reviewHeaders, data: { decision: 'VERIFIED' } },
          )
        ).status(),
      ).toBe(200);
    }
    const approved = await reviewer.post(
      `admin/aircraft/${aircraft.id}/approve`,
      { headers: reviewHeaders },
    );
    expect(approved.status()).toBe(200);
    expect((await approved.json()).data.listingStatus).toBe('APPROVED');

    const inbox = (await (await request.get('me/notifications')).json()).data;
    expect(
      inbox.map((item: { templateKey: string }) => item.templateKey),
    ).toContain('aircraft.approved');
  });
});

/** Days from now as an ISO timestamp in UTC, so tests never go stale. */
function inDays(days: number, hours = 0): string {
  const at = new Date();
  at.setUTCHours(0, 0, 0, 0);
  return new Date(
    at.getTime() + days * 86_400_000 + hours * 3_600_000,
  ).toISOString();
}

type Contexts = {
  request: APIRequestContext;
  playwright: {
    request: { newContext(options: object): Promise<APIRequestContext> };
  };
  baseURL: string | undefined;
};

/** An aircraft with its three documents, submitted for review. */
async function submittedAircraft({ request, playwright, baseURL }: Contexts) {
  const { homeBaseId } = await approvedOperator(request, playwright, baseURL);
  const headers = await csrfHeaders(request);
  const created = await request.post('operator/aircraft', {
    headers,
    data: aircraftBody(homeBaseId),
  });
  const aircraft = (await created.json()).data as {
    id: string;
    registration: string;
  };
  for (const type of ['REGISTRATION', 'AIRWORTHINESS', 'INSURANCE']) {
    await addAircraftDocument(request, aircraft.id, type);
  }
  expect(
    (
      await request.post(`operator/aircraft/${aircraft.id}/submit`, { headers })
    ).status(),
  ).toBe(200);
  const { reviewer, headers: reviewHeaders } = await asReviewer(
    playwright,
    baseURL,
  );
  return { ...aircraft, homeBaseId, headers, reviewer, reviewHeaders };
}

/** Verifies every document and approves the aircraft through the API. */
async function approve(
  reviewer: APIRequestContext,
  reviewHeaders: Record<string, string>,
  aircraftId: string,
) {
  const detail = await reviewer.get(`admin/aircraft/${aircraftId}`);
  for (const document of (await detail.json()).data.documents) {
    expect(
      (
        await reviewer.post(`admin/aircraft/documents/${document.id}/verify`, {
          headers: reviewHeaders,
          data: { decision: 'VERIFIED' },
        })
      ).status(),
    ).toBe(200);
  }
  const approved = await reviewer.post(`admin/aircraft/${aircraftId}/approve`, {
    headers: reviewHeaders,
  });
  expect(approved.status()).toBe(200);
  return (await approved.json()).data as {
    documents: { id: string; type: string }[];
  };
}

async function setOperatorStatus(aircraftId: string, status: string) {
  await withPrisma(async (prisma) => {
    const { operatorId } = await prisma.aircraft.findUniqueOrThrow({
      where: { id: aircraftId },
      select: { operatorId: true },
    });
    await prisma.operator.update({
      where: { id: operatorId },
      data: { status: status as 'APPROVED' | 'SUSPENDED' },
    });
  });
}

async function templateKeys(request: APIRequestContext): Promise<string[]> {
  const inbox = (await (await request.get('me/notifications')).json()).data;
  return inbox.map((item: { templateKey: string }) => item.templateKey);
}

test.describe('aircraft review decisions', () => {
  test('a rejection needs a reason, which the operator sees and is told about', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, reviewer, reviewHeaders } = await submittedAircraft(contexts);
    const bare = await reviewer.post(`admin/aircraft/${id}/reject`, {
      headers: reviewHeaders,
      data: {},
    });
    expect(bare.status()).toBe(400);

    const rejected = await reviewer.post(`admin/aircraft/${id}/reject`, {
      headers: reviewHeaders,
      data: { reason: 'The airworthiness certificate is illegible.' },
    });
    expect(rejected.status()).toBe(200);
    expect((await rejected.json()).data).toMatchObject({
      listingStatus: 'REJECTED',
      reviewNote: 'The airworthiness certificate is illegible.',
    });
    const mine = await request.get(`operator/aircraft/${id}`);
    expect((await mine.json()).data).toMatchObject({
      listingStatus: 'REJECTED',
      reviewNote: 'The airworthiness certificate is illegible.',
    });
    expect(await templateKeys(request)).toContain('aircraft.rejected');
  });

  test('suspend needs a reason; reinstate needs an approved operator', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, reviewer, reviewHeaders } = await submittedAircraft(contexts);
    await approve(reviewer, reviewHeaders, id);

    expect(
      (
        await reviewer.post(`admin/aircraft/${id}/suspend`, {
          headers: reviewHeaders,
          data: {},
        })
      ).status(),
    ).toBe(400);
    const suspended = await reviewer.post(`admin/aircraft/${id}/suspend`, {
      headers: reviewHeaders,
      data: { reason: 'Insurance under query.' },
    });
    expect(suspended.status()).toBe(200);
    expect((await suspended.json()).data.listingStatus).toBe('SUSPENDED');
    expect(await templateKeys(contexts.request)).toContain(
      'aircraft.suspended',
    );

    await setOperatorStatus(id, 'SUSPENDED');
    const refused = await reviewer.post(`admin/aircraft/${id}/reinstate`, {
      headers: reviewHeaders,
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe('OPERATOR_NOT_APPROVED');

    await setOperatorStatus(id, 'APPROVED');
    const reinstated = await reviewer.post(`admin/aircraft/${id}/reinstate`, {
      headers: reviewHeaders,
    });
    expect(reinstated.status()).toBe(200);
    expect((await reinstated.json()).data.listingStatus).toBe('APPROVED');
  });

  test('an aircraft of a suspended operator cannot be approved', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, reviewer, reviewHeaders } = await submittedAircraft(contexts);
    await setOperatorStatus(id, 'SUSPENDED');
    const detail = await reviewer.get(`admin/aircraft/${id}`);
    for (const document of (await detail.json()).data.documents) {
      await reviewer.post(`admin/aircraft/documents/${document.id}/verify`, {
        headers: reviewHeaders,
        data: { decision: 'VERIFIED' },
      });
    }
    const refused = await reviewer.post(`admin/aircraft/${id}/approve`, {
      headers: reviewHeaders,
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
    const after = await reviewer.get(`admin/aircraft/${id}`);
    expect((await after.json()).data.listingStatus).toBe('PENDING_REVIEW');
  });

  test('rejecting a required document suspends an approved aircraft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, reviewer, reviewHeaders } = await submittedAircraft(contexts);
    const approved = await approve(reviewer, reviewHeaders, id);
    const insurance = approved.documents.find((d) => d.type === 'INSURANCE')!;
    const rejected = await reviewer.post(
      `admin/aircraft/documents/${insurance.id}/verify`,
      {
        headers: reviewHeaders,
        data: { decision: 'REJECTED', reason: 'Policy number not valid.' },
      },
    );
    expect(rejected.status()).toBe(200);
    const detail = await reviewer.get(`admin/aircraft/${id}`);
    expect((await detail.json()).data.listingStatus).toBe('SUSPENDED');
    expect(await templateKeys(contexts.request)).toContain(
      'aircraft.suspended',
    );
  });

  test('approval counts a renewed document beside the expired one', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, reviewer, reviewHeaders } = await submittedAircraft(contexts);
    // The first insurance lapses while under review; a renewal is added.
    await withPrisma(async (prisma) => {
      await prisma.aircraft.update({
        where: { id },
        data: { listingStatus: 'DRAFT' },
      });
      await prisma.aircraftDocument.updateMany({
        where: { aircraftId: id, type: 'INSURANCE' },
        data: { expiresAt: new Date('2020-01-01') },
      });
    });
    await addAircraftDocument(request, id, 'INSURANCE');
    await request.post(`operator/aircraft/${id}/submit`, {
      headers: await csrfHeaders(request),
    });
    await approve(reviewer, reviewHeaders, id);
  });

  test('finance staff and operators cannot use the review routes', async ({
    playwright,
    baseURL,
    request,
  }) => {
    const finance = await playwright.request.newContext({ baseURL });
    await signIn(finance, 'finance');
    const financeHeaders = await csrfHeaders(finance);
    const someId = randomUUID();
    expect((await finance.get('admin/aircraft')).status()).toBe(403);
    const file = await withPrisma((prisma) =>
      prisma.aircraftDocument.findFirst({ select: { fileId: true } }),
    );
    if (file) {
      expect(
        (await finance.get(`documents/${file.fileId}/download`)).status(),
      ).toBe(404);
    }
    expect((await finance.get(`admin/aircraft/${someId}`)).status()).toBe(403);
    expect(
      (
        await finance.post(`admin/aircraft/${someId}/approve`, {
          headers: financeHeaders,
        })
      ).status(),
    ).toBe(403);

    await registerOperator(request);
    expect((await request.get('admin/aircraft')).status()).toBe(403);
    await finance.dispose();
  });

  test('releasing a registration needs a reason and only frees a draft or rejected aircraft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, registration, homeBaseId, headers, reviewer, reviewHeaders } =
      await submittedAircraft(contexts);

    for (const data of [{}, { reason: '     ' }]) {
      const noReason = await reviewer.post(
        `admin/aircraft/${id}/release-registration`,
        { headers: reviewHeaders, data },
      );
      expect(noReason.status()).toBe(400);
    }
    const underReview = await reviewer.post(
      `admin/aircraft/${id}/release-registration`,
      { headers: reviewHeaders, data: { reason: 'Claimed in error.' } },
    );
    expect(underReview.status()).toBe(409);
    expect((await underReview.json()).error.code).toBe(
      'AIRCRAFT_REGISTRATION_LOCKED',
    );

    await reviewer.post(`admin/aircraft/${id}/reject`, {
      headers: reviewHeaders,
      data: { reason: 'Registration belongs to another operator.' },
    });
    const released = await reviewer.post(
      `admin/aircraft/${id}/release-registration`,
      { headers: reviewHeaders, data: { reason: 'Claimed in error.' } },
    );
    expect(released.status()).toBe(204);
    expect((await request.get(`operator/aircraft/${id}`)).status()).toBe(404);
    const reused = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId, registration),
    });
    expect(reused.status()).toBe(201);
  });
});

test.describe('aircraft availability', () => {
  test('an approved aircraft is offered on the calendar and soft holds that overlap are listed', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, reviewer, reviewHeaders, headers } =
      await submittedAircraft(contexts);
    await approve(reviewer, reviewHeaders, id);

    const slot = await request.post(
      `operator/aircraft/${id}/availability/slots`,
      {
        headers,
        data: { startsAt: inDays(5, 6), endsAt: inDays(5, 10), kind: 'OPEN' },
      },
    );
    expect(slot.status()).toBe(201);
    const slotId = (await slot.json()).data.id as string;

    const calendar = await request.get(`operator/aircraft/${id}/availability`, {
      params: { from: inDays(5), to: inDays(6) },
    });
    expect(calendar.status()).toBe(200);
    expect(
      (await calendar.json()).data.slots.map((s: { id: string }) => s.id),
    ).toEqual([slotId]);

    const moved = await request.patch(
      `operator/aircraft/${id}/availability/slots/${slotId}`,
      { headers, data: { endsAt: inDays(5, 12) } },
    );
    expect(moved.status()).toBe(200);
    expect((await moved.json()).data.endsAt).toBe(inDays(5, 12));

    for (const [from, to] of [
      [7, 9],
      [8, 10],
    ]) {
      const hold = await request.post(
        `operator/aircraft/${id}/availability/blocks`,
        {
          headers,
          data: {
            startsAt: inDays(from),
            endsAt: inDays(to),
            reason: 'SOFT_HOLD',
            expiresAt: inDays(3),
          },
        },
      );
      expect(hold.status()).toBe(201);
    }
    // A lapsed pair is not a conflict.
    await withPrisma(async (prisma) => {
      await prisma.availabilityBlock.createMany({
        data: [12, 13].map((day) => ({
          aircraftId: id,
          startsAt: new Date(inDays(day)),
          endsAt: new Date(inDays(day + 2)),
          reason: 'SOFT_HOLD' as const,
          expiresAt: new Date(inDays(-1)),
        })),
      });
    });
    const conflicts = await request.get('operator/availability/conflicts');
    expect(conflicts.status()).toBe(200);
    expect((await conflicts.json()).data).toHaveLength(1);

    expect(
      (
        await request.delete(
          `operator/aircraft/${id}/availability/slots/${slotId}`,
          { headers },
        )
      ).status(),
    ).toBe(204);
  });

  test('overlapping confirmed holds are refused by the database', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, reviewer, reviewHeaders, headers, homeBaseId } =
      await submittedAircraft(contexts);
    await approve(reviewer, reviewHeaders, id);
    const second = await request.post('operator/aircraft', {
      headers,
      data: aircraftBody(homeBaseId),
    });
    const other = (await second.json()).data as { id: string };

    const booking = await withPrisma((prisma) =>
      prisma.availabilityBlock.create({
        data: {
          aircraftId: id,
          startsAt: new Date(inDays(20)),
          endsAt: new Date(inDays(22)),
          reason: 'BOOKING',
        },
      }),
    );
    await withPrisma(async (prisma) => {
      const book = (aircraftId: string, from: number, to: number) =>
        prisma.availabilityBlock.create({
          data: {
            aircraftId,
            startsAt: new Date(inDays(from)),
            endsAt: new Date(inDays(to)),
            reason: 'BOOKING',
          },
        });
      await expect(book(id, 21, 23)).rejects.toThrow(
        /AvailabilityBlock_booking_no_overlap|23P01/,
      );
      // Touching ranges and another aircraft are fine.
      await book(id, 22, 24);
      await book(other.id, 20, 22);
      // An empty range cannot slip past the exclusion constraint.
      await expect(book(id, 30, 30)).rejects.toThrow(
        /AvailabilityBlock_ends_after_starts|23514/,
      );
    });
    // A soft hold may sit over a booking; conflicts are reviewed by people.
    const hold = await request.post(
      `operator/aircraft/${id}/availability/blocks`,
      {
        headers,
        data: {
          startsAt: inDays(20),
          endsAt: inDays(21),
          reason: 'SOFT_HOLD',
          expiresAt: inDays(2),
        },
      },
    );
    expect(hold.status()).toBe(201);

    const removeBooking = await request.delete(
      `operator/aircraft/${id}/availability/blocks/${booking.id}`,
      { headers },
    );
    expect(removeBooking.status()).toBe(409);
    const forged = await request.post(
      `operator/aircraft/${id}/availability/blocks`,
      {
        headers,
        data: { startsAt: inDays(40), endsAt: inDays(41), reason: 'BOOKING' },
      },
    );
    expect(forged.status()).toBe(400);
  });

  test('dates must be UTC, ordered and within the limits', async ({
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
    const slots = `operator/aircraft/${id}/availability/slots`;
    const blocks = `operator/aircraft/${id}/availability/blocks`;

    const cases: [string, object][] = [
      [slots, { startsAt: inDays(2, 10), endsAt: inDays(2, 8), kind: 'OPEN' }],
      [slots, { startsAt: inDays(2), endsAt: inDays(2), kind: 'OPEN' }],
      [slots, { startsAt: inDays(2), endsAt: inDays(200), kind: 'OPEN' }],
      [slots, { startsAt: inDays(-3), endsAt: inDays(-2), kind: 'OPEN' }],
      [
        slots,
        {
          startsAt: inDays(2).replace('Z', ''),
          endsAt: inDays(3).replace('Z', ''),
          kind: 'OPEN',
        },
      ],
      [blocks, { startsAt: inDays(2), endsAt: inDays(3), reason: 'SOFT_HOLD' }],
      [
        blocks,
        {
          startsAt: inDays(2),
          endsAt: inDays(3),
          reason: 'SOFT_HOLD',
          expiresAt: inDays(45),
        },
      ],
      [
        blocks,
        {
          startsAt: inDays(2),
          endsAt: inDays(3),
          reason: 'MAINTENANCE',
          expiresAt: inDays(1),
        },
      ],
      [
        blocks,
        {
          startsAt: inDays(2),
          endsAt: inDays(3),
          reason: 'SOFT_HOLD',
          expiresAt: inDays(4),
        },
      ],
    ];
    for (const [path, data] of cases) {
      const response = await request.post(path, { headers, data });
      expect(response.status(), JSON.stringify(data)).toBe(400);
    }
    const wide = await request.get(`operator/aircraft/${id}/availability`, {
      params: { from: inDays(0), to: inDays(120) },
    });
    expect(wide.status()).toBe(400);
  });

  test('another operator, operator staff and a suspended operator are limited', async ({
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
    const slot = await request.post(
      `operator/aircraft/${id}/availability/slots`,
      {
        headers,
        data: { startsAt: inDays(4), endsAt: inDays(5), kind: 'OPEN' },
      },
    );
    const slotId = (await slot.json()).data.id as string;

    const rival = await playwright.request.newContext({ baseURL });
    await approvedOperator(rival, playwright, baseURL);
    const rivalHeaders = await csrfHeaders(rival);
    expect(
      (
        await rival.get(`operator/aircraft/${id}/availability`, {
          params: { from: inDays(0), to: inDays(10) },
        })
      ).status(),
    ).toBe(404);
    expect(
      (
        await rival.delete(
          `operator/aircraft/${id}/availability/slots/${slotId}`,
          { headers: rivalHeaders },
        )
      ).status(),
    ).toBe(404);
    await rival.dispose();

    const staff = await playwright.request.newContext({ baseURL });
    const { email } = await registerOperator(staff);
    await withPrisma((prisma) =>
      prisma.user.update({
        where: { email },
        data: { role: 'OPERATOR_STAFF' },
      }),
    );
    expect(
      (
        await staff.get(`operator/aircraft/${id}/availability`, {
          params: { from: inDays(0), to: inDays(10) },
        })
      ).status(),
    ).toBe(403);
    await staff.dispose();

    // A suspended operator can still ground the aircraft, but not offer time.
    await setOperatorStatus(id, 'SUSPENDED');
    const grounded = await request.post(
      `operator/aircraft/${id}/availability/blocks`,
      {
        headers,
        data: { startsAt: inDays(6), endsAt: inDays(8), reason: 'MAINTENANCE' },
      },
    );
    expect(grounded.status()).toBe(201);
    const offered = await request.post(
      `operator/aircraft/${id}/availability/slots`,
      {
        headers,
        data: { startsAt: inDays(9), endsAt: inDays(10), kind: 'OPEN' },
      },
    );
    expect(offered.status()).toBe(409);
    expect((await offered.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
  });
});

test.describe('fleet availability', () => {
  test('M3 done: an approved aircraft has availability on a calendar and overlapping confirmed holds are refused', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { id, registration, reviewer, reviewHeaders, headers } =
      await submittedAircraft(contexts);
    await approve(reviewer, reviewHeaders, id);

    const slot = await request.post(
      `operator/aircraft/${id}/availability/slots`,
      {
        headers,
        data: { startsAt: inDays(3, 4), endsAt: inDays(3, 12), kind: 'OPEN' },
      },
    );
    expect(slot.status()).toBe(201);
    const slotId = (await slot.json()).data.id as string;

    // The slot is on the aircraft's calendar and on the fleet timeline.
    const own = await request.get(`operator/aircraft/${id}/availability`, {
      params: { from: inDays(0), to: inDays(7) },
    });
    expect(
      (await own.json()).data.slots.map((s: { id: string }) => s.id),
    ).toContain(slotId);
    const fleet = await request.get('operator/availability', {
      params: { from: inDays(0), to: inDays(7) },
    });
    expect(fleet.status()).toBe(200);
    const body = (await fleet.json()).data;
    expect(body.truncated).toBe(false);
    expect(body.aircraft).toEqual([
      expect.objectContaining({
        id,
        registration,
        listingStatus: 'APPROVED',
        availabilityStatus: 'AVAILABLE',
        homeBase: expect.objectContaining({
          timeZone: expect.any(String),
          name: expect.any(String),
        }),
      }),
    ]);
    expect(body.slots.map((s: { id: string }) => s.id)).toContain(slotId);

    // A booking holds the slot; a second, overlapping booking is refused.
    await withPrisma(async (prisma) => {
      await prisma.availabilityBlock.create({
        data: {
          aircraftId: id,
          startsAt: new Date(inDays(3, 6)),
          endsAt: new Date(inDays(3, 10)),
          reason: 'BOOKING',
        },
      });
      await expect(
        prisma.availabilityBlock.create({
          data: {
            aircraftId: id,
            startsAt: new Date(inDays(3, 8)),
            endsAt: new Date(inDays(3, 11)),
            reason: 'BOOKING',
          },
        }),
      ).rejects.toThrow(/AvailabilityBlock_booking_no_overlap|23P01/);
    });
    const after = await request.get('operator/availability', {
      params: { from: inDays(0), to: inDays(7) },
    });
    expect(
      (await after.json()).data.blocks.filter(
        (b: { reason: string }) => b.reason === 'BOOKING',
      ),
    ).toHaveLength(1);
  });

  test('the fleet read is bounded, scoped to the operator, and closed to staff', async ({
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
    const mine = (await created.json()).data as {
      id: string;
      homeBase: { id: string; timeZone: string } | null;
    };
    // Aircraft responses name the home base and its zone.
    expect(mine.homeBase).toMatchObject({ id: homeBaseId });

    const wide = await request.get('operator/availability', {
      params: { from: inDays(0), to: inDays(43) },
    });
    expect(wide.status()).toBe(400);
    const naive = await request.get('operator/availability', {
      params: {
        from: inDays(0).replace('Z', ''),
        to: inDays(7).replace('Z', ''),
      },
    });
    expect(naive.status()).toBe(400);

    const rival = await playwright.request.newContext({ baseURL });
    await approvedOperator(rival, playwright, baseURL);
    const theirs = await rival.get('operator/availability', {
      params: { from: inDays(0), to: inDays(7) },
    });
    expect(theirs.status()).toBe(200);
    expect(
      (await theirs.json()).data.aircraft.map((a: { id: string }) => a.id),
    ).not.toContain(mine.id);
    await rival.dispose();

    const staff = await playwright.request.newContext({ baseURL });
    const { email } = await registerOperator(staff);
    await withPrisma((prisma) =>
      prisma.user.update({
        where: { email },
        data: { role: 'OPERATOR_STAFF' },
      }),
    );
    expect(
      (
        await staff.get('operator/availability', {
          params: { from: inDays(0), to: inDays(7) },
        })
      ).status(),
    ).toBe(403);
    await staff.dispose();
  });
});
