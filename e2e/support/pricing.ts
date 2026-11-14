import { APIRequestContext, expect } from '@playwright/test';
import { withPrisma } from './db.js';
import {
  addAircraftDocument,
  aircraftBody,
  approvedOperator,
} from './fleet.js';
import { csrfHeaders } from './session.js';

/** Shared set-up for the pricing tests (operator inputs, admin rules). */

export async function locationId(request: APIRequestContext, q: string) {
  const response = await request.get('locations', {
    params: { q, pageSize: 1 },
  });
  return (await response.json()).data[0].id as string;
}

export function inDays(days: number, hourUtc = 6): Date {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + days);
  date.setUTCHours(hourUtc, 0, 0, 0);
  return date;
}

/** An approved jet in Mumbai with time offered, and no rate yet. */
export async function listedJet(contexts: {
  request: APIRequestContext;
  playwright: Parameters<typeof approvedOperator>[1];
  baseURL: string | undefined;
}) {
  const { request } = contexts;
  await approvedOperator(request, contexts.playwright, contexts.baseURL);
  const mumbai = await locationId(request, 'BOM');
  const created = await request.post('operator/aircraft', {
    headers: await csrfHeaders(request),
    data: aircraftBody(mumbai),
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
  return { aircraftId, mumbai, goa: await locationId(request, 'GOI') };
}

/** Searches Mumbai to Goa in four days and returns this aircraft's result. */
export async function searchFor(
  request: APIRequestContext,
  trip: { aircraftId: string; mumbai: string; goa: string },
) {
  const response = await request.post('search/charter', {
    headers: await csrfHeaders(request),
    data: {
      originId: trip.mumbai,
      destinationId: trip.goa,
      departureAt: inDays(4).toISOString(),
      passengerCount: 2,
    },
  });
  expect(response.status()).toBe(200);
  const data = (await response.json()).data;
  return {
    searchId: data.searchId as string,
    result: data.results.find(
      (result: { aircraft: { id: string } }) =>
        result.aircraft.id === trip.aircraftId,
    ),
  };
}
