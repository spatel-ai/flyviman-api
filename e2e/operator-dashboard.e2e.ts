import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import {
  latestLinkToken,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { addAircraftDocument, aircraftBody } from './support/fleet.js';
import { inDays, listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * The operator dashboard (W5, D-190): sections by capability, counted over
 * the aircraft in the caller's reach, never another operator's data.
 */

type Contexts = Parameters<typeof listedJet>[0];
type Trip = Awaited<ReturnType<typeof listedJet>>;

/** A second approved jet for the operator signed in on `request`. */
async function secondJet(request: APIRequestContext, trip: Trip) {
  const created = await request.post('operator/aircraft', {
    headers: await csrfHeaders(request),
    data: aircraftBody(trip.mumbai),
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
  return { ...trip, aircraftId };
}

/** A new customer's request (on request, unpriced) for the jet. */
async function requestFor(contexts: Contexts, trip: Trip) {
  const searched = await searchFor(contexts.request, trip);
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await registerCustomer(customer);
  const response = await customer.post('bookings', {
    headers: {
      ...(await csrfHeaders(customer)),
      'Idempotency-Key': randomUUID(),
    },
    data: {
      searchId: searched.searchId,
      resultId: searched.result.resultId,
      cancellationTermsVersion: searched.termsVersion,
      currency: 'INR',
    },
  });
  expect(response.status()).toBe(201);
}

async function invite(
  contexts: Contexts,
  permissions: {
    capabilities: string[];
    allAircraft: boolean;
    aircraftIds: string[];
  },
) {
  const email = uniqueEmail('staff');
  const invited = await contexts.request.post('operator/staff', {
    headers: await csrfHeaders(contexts.request),
    data: { email, ...permissions },
  });
  expect(invited.status()).toBe(201);
  const staff = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  const token = await latestLinkToken(staff, email);
  expect(
    (
      await staff.post('auth/password/reset', {
        data: { token, password: PASSWORD },
      })
    ).status(),
  ).toBe(204);
  expect(
    (
      await staff.post('auth/login', { data: { email, password: PASSWORD } })
    ).status(),
  ).toBe(200);
  return staff;
}

async function dashboard(context: APIRequestContext) {
  const response = await context.get('operator/dashboard');
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

test.describe('operator dashboard', () => {
  test('an operator administrator gets every section, settlements included', async ({
    request,
    playwright,
    baseURL,
  }) => {
    await listedJet({ request, playwright, baseURL });
    const data = await dashboard(request);
    for (const section of [
      'requests',
      'quotes',
      'trips',
      'fleet',
      'emptyLegs',
      'settlements',
    ]) {
      expect(data[section], section).not.toBeNull();
    }
    expect(data.fleet.approved).toBe(1);
    expect(data.requests).toEqual({ open: 0 });
  });

  test('staff with only the empty-leg capability get only that section and no settlements', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    await listedJet(contexts);
    const staff = await invite(contexts, {
      capabilities: ['MANAGE_EMPTY_LEGS'],
      allAircraft: true,
      aircraftIds: [],
    });
    const data = await dashboard(staff);
    expect(data.emptyLegs).not.toBeNull();
    expect(data.requests).toBeNull();
    expect(data.quotes).toBeNull();
    expect(data.trips).toBeNull();
    expect(data.fleet).toBeNull();
    expect(data.settlements).toBeNull();
  });

  test('staff counts cover only the aircraft in their reach, and never another operator', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const tripA = await listedJet(contexts);
    const tripB = await secondJet(request, tripA);
    await requestFor(contexts, tripA);
    await requestFor(contexts, tripB);

    // Another operator with its own request: never counted here.
    const other = await playwright.request.newContext({ baseURL });
    const otherContexts = { request: other, playwright, baseURL };
    await requestFor(otherContexts, await listedJet(otherContexts));

    const admin = await dashboard(request);
    expect(admin.requests.open).toBe(2);
    expect(admin.fleet.approved).toBe(2);
    expect((await dashboard(other)).requests.open).toBe(1);

    const staff = await invite(contexts, {
      capabilities: ['MANAGE_BOOKINGS', 'MANAGE_AIRCRAFT'],
      allAircraft: false,
      aircraftIds: [tripA.aircraftId],
    });
    const own = await dashboard(staff);
    expect(own.requests.open).toBe(1);
    expect(own.fleet.approved).toBe(1);
    expect(own.settlements).toBeNull();
    expect(own.emptyLegs).toBeNull();
  });

  test('customers, operations and administrators are refused, and anonymous callers are not signed in', async ({
    request,
    playwright,
    baseURL,
  }) => {
    expect((await request.get('operator/dashboard')).status()).toBe(401);
    for (const account of [
      'customer',
      'ops',
      'finance',
      'superAdmin',
    ] as const) {
      const context = await playwright.request.newContext({ baseURL });
      await signIn(context, account);
      expect((await context.get('operator/dashboard')).status(), account).toBe(
        403,
      );
    }
  });
});
