import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect } from '@playwright/test';
import { registerOperator, uploadPdf } from './data.js';
import { csrfHeaders, signIn } from './session.js';

/** Shared fleet helpers for the aircraft, availability and staff journeys. */

export const COMPANY = {
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

export async function addOperatorDocument(
  request: APIRequestContext,
  type: string,
) {
  const headers = await csrfHeaders(request);
  const fileId = await uploadPdf(request, headers, `${type.toLowerCase()}.pdf`);
  const response = await request.post('operator/documents', {
    headers,
    data: { type, fileId, expiresAt: '2030-12-31' },
  });
  expect(response.status()).toBe(201);
}

export async function asReviewer(
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
export async function approvedOperator(
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

export function aircraftBody(homeBaseId: string, registration?: string) {
  return {
    registration:
      registration ?? `VT-${randomUUID().slice(0, 13).toUpperCase()}`,
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

export async function addAircraftDocument(
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
