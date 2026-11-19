import { APIRequestContext, expect, test } from '@playwright/test';
import {
  latestLinkToken,
  outbox,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { aircraftBody, asReviewer } from './support/fleet.js';
import { inDays, listedJet } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/** M7 empty legs: operator offers, review, listing, interest and expiry. */

type Playwright = Parameters<typeof listedJet>[0]['playwright'];

function offerBody(trip: { aircraftId: string; mumbai: string; goa: string }) {
  return {
    aircraftId: trip.aircraftId,
    originId: trip.goa,
    destinationId: trip.mumbai,
    departureFrom: inDays(6, 4).toISOString(),
    departureTo: inDays(6, 12).toISOString(),
    seatsAvailable: 6,
    priceMinor: 18_500_000,
    validUntil: inDays(5, 12).toISOString(),
    conditions:
      'Subject to the aircraft repositioning as planned. Non-refundable once confirmed.',
  };
}

/** An approved operator on `request` with a draft offer on an approved jet. */
async function draftOffer(
  request: APIRequestContext,
  playwright: Playwright,
  baseURL: string | undefined,
) {
  const trip = await listedJet({ request, playwright, baseURL });
  const created = await request.post('operator/empty-legs', {
    headers: await csrfHeaders(request),
    data: offerBody(trip),
  });
  expect(created.status()).toBe(201);
  return { trip, offer: (await created.json()).data };
}

async function publish(request: APIRequestContext, id: string) {
  const response = await request.post(`operator/empty-legs/${id}/publish`, {
    headers: await csrfHeaders(request),
  });
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

async function follower(playwright: Playwright, baseURL: string | undefined) {
  const customer = await playwright.request.newContext({ baseURL });
  const { email } = await registerCustomer(customer);
  return { customer, email };
}

async function follow(customer: APIRequestContext, id: string) {
  const response = await customer.post(`empty-legs/${id}/interest`, {
    headers: await csrfHeaders(customer),
  });
  expect(response.status()).toBe(200);
  expect((await response.json()).data).toEqual({
    emptyLegId: id,
    interested: true,
  });
}

async function inbox(customer: APIRequestContext, reference: string) {
  const response = await customer.get('me/notifications');
  expect(response.status()).toBe(200);
  return (
    (await response.json()).data as { templateKey: string; body: string }[]
  )
    .filter((n) => n.body.includes(reference))
    .map((n) => n.templateKey);
}

/**
 * Listed offer ids for a query, every page: offers left by earlier runs can
 * fill the first page (D-089).
 */
async function listedIds(request: APIRequestContext, params = {}) {
  const ids: string[] = [];
  for (let page = 1; page <= 50; page += 1) {
    const response = await request.get('empty-legs', {
      params: { pageSize: 100, page, ...params },
    });
    expect(response.status()).toBe(200);
    const body = await response.json();
    ids.push(...(body.data as { id: string }[]).map((o) => o.id));
    if (page * 100 >= body.meta.total) break;
  }
  return ids;
}

test.describe('operator offers and the public listing', () => {
  test('a published offer is listed with a labelled quote, filters apply, and withdrawal ends it', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { trip, offer } = await draftOffer(request, playwright, baseURL);
    expect(offer).toMatchObject({
      status: 'DRAFT',
      seatsAvailable: 6,
      price: { amountMinor: 18_500_000, currency: 'INR', priceType: 'QUOTE' },
      aircraft: {
        category: 'LIGHT_JET',
        seats: 8,
        type: 'Cessna Citation CJ3+',
      },
      editable: true,
      publishable: true,
      withdrawable: true,
      interestCount: 0,
    });
    expect(offer.reference).toMatch(/^FLY-EL-[23456789A-HJKMNP-Z]{6}$/);
    expect(offer.origin.id).toBe(trip.goa);

    // A draft was never public.
    const anonymous = await playwright.request.newContext({ baseURL });
    expect((await anonymous.get(`empty-legs/${offer.id}`)).status()).toBe(404);

    const published = await publish(request, offer.id);
    expect(published.status).toBe('PUBLISHED');
    expect(published.publishedAt).not.toBeNull();

    const detail = await anonymous.get(`empty-legs/${offer.id}`);
    expect(detail.status()).toBe(200);
    const body = (await detail.json()).data;
    expect(body).toMatchObject({
      id: offer.id,
      status: 'PUBLISHED',
      price: { priceType: 'QUOTE', amountMinor: 18_500_000 },
      conditions: offerBody(trip).conditions,
      destination: { id: trip.mumbai, iata: 'BOM' },
    });
    // The public view leaves out the registration and review fields.
    expect(body.aircraft.registration).toBeUndefined();
    expect(body.reviewNote).toBeUndefined();

    const route = { origin: trip.goa, destination: trip.mumbai };
    expect(await listedIds(anonymous, route)).toContain(offer.id);
    expect(
      await listedIds(anonymous, {
        ...route,
        passengers: 6,
        maxPrice: 18_500_000,
      }),
    ).toContain(offer.id);
    expect(
      await listedIds(anonymous, { ...route, passengers: 7 }),
    ).not.toContain(offer.id);
    expect(
      await listedIds(anonymous, { ...route, maxPrice: 18_499_999 }),
    ).not.toContain(offer.id);
    const day = (n: number) =>
      new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(
        inDays(n, 6),
      );
    expect(
      await listedIds(anonymous, { ...route, from: day(6), to: day(6) }),
    ).toContain(offer.id);
    expect(
      await listedIds(anonymous, { ...route, from: day(7), to: day(9) }),
    ).not.toContain(offer.id);
    expect(
      (
        await anonymous.get('empty-legs', { params: { maxPrice: 'cheap' } })
      ).status(),
    ).toBe(400);

    const { customer } = await follower(playwright, baseURL);
    const interested = async (context: APIRequestContext) => {
      const response = await context.get(`empty-legs/${offer.id}`);
      expect(response.status()).toBe(200);
      return {
        interested: (await response.json()).data.interested,
        cache: response.headers()['cache-control'],
      };
    };
    expect((await interested(customer)).interested).toBe(false);
    await follow(customer, offer.id);
    await follow(customer, offer.id); // repeatable
    // The alert state is the caller's own, and kept out of shared caches.
    expect(await interested(customer)).toEqual({
      interested: true,
      cache: 'private, no-store',
    });
    expect((await interested(anonymous)).interested).toBe(false);
    expect((await interested(request)).interested).toBe(false); // operator
    expect(
      (
        await customer.delete(`empty-legs/${offer.id}/interest`, {
          headers: await csrfHeaders(customer),
        })
      ).status(),
    ).toBe(204);
    expect((await interested(customer)).interested).toBe(false);
    await follow(customer, offer.id);

    const withdrawn = await request.post(
      `operator/empty-legs/${offer.id}/withdraw`,
      { headers: await csrfHeaders(request) },
    );
    expect(withdrawn.status()).toBe(200);
    expect((await withdrawn.json()).data.status).toBe('WITHDRAWN');

    const gone = await anonymous.get(`empty-legs/${offer.id}`);
    expect(gone.status()).toBe(410);
    expect((await gone.json()).error.code).toBe('EMPTY_LEG_WITHDRAWN');
    expect(await listedIds(anonymous, route)).not.toContain(offer.id);
    expect(await inbox(customer, offer.reference)).toContain(
      'empty_leg.withdrawn',
    );

    const again = await request.post(
      `operator/empty-legs/${offer.id}/withdraw`,
      { headers: await csrfHeaders(request) },
    );
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe(
      'EMPTY_LEG_INVALID_TRANSITION',
    );

    // Following a withdrawn offer is refused; stopping is always fine.
    const late = await customer.post(`empty-legs/${offer.id}/interest`, {
      headers: await csrfHeaders(customer),
    });
    expect(late.status()).toBe(410);
    expect(
      (
        await customer.delete(`empty-legs/${offer.id}/interest`, {
          headers: await csrfHeaders(customer),
        })
      ).status(),
    ).toBe(204);
  });

  test('a change to a published offer tells followers; its aircraft and route are locked', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { offer } = await draftOffer(request, playwright, baseURL);
    await publish(request, offer.id);
    const { customer } = await follower(playwright, baseURL);
    await follow(customer, offer.id);

    const locked = await request.patch(`operator/empty-legs/${offer.id}`, {
      headers: await csrfHeaders(request),
      data: { originId: offer.destination.id },
    });
    expect(locked.status()).toBe(409);
    expect((await locked.json()).error.code).toBe('EMPTY_LEG_FIELD_LOCKED');

    const cheaper = await request.patch(`operator/empty-legs/${offer.id}`, {
      headers: await csrfHeaders(request),
      data: { priceMinor: 15_000_000 },
    });
    expect(cheaper.status()).toBe(200);
    expect((await cheaper.json()).data).toMatchObject({
      status: 'PUBLISHED',
      price: { amountMinor: 15_000_000, priceType: 'QUOTE' },
      interestCount: 1,
    });
    expect(await inbox(customer, offer.reference)).toEqual([
      'empty_leg.changed',
    ]);

    // Null never clears a field.
    const cleared = await request.patch(`operator/empty-legs/${offer.id}`, {
      headers: await csrfHeaders(request),
      data: { conditions: null },
    });
    expect(cleared.status()).toBe(400);

    // The change is audited.
    const { reviewer } = await asReviewer(playwright, baseURL);
    const audit = await reviewer.get('admin/audit-logs', {
      params: { entityType: 'EmptyLeg', entityId: offer.id },
    });
    expect(audit.status()).toBe(200);
    const actions = ((await audit.json()).data as { action: string }[]).map(
      (entry) => entry.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining([
        'empty_leg.create',
        'empty_leg.publish',
        'empty_leg.update',
      ]),
    );
  });

  test('refuses unsound terms, other operators, other roles and unapproved aircraft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { trip, offer } = await draftOffer(request, playwright, baseURL);
    const headers = await csrfHeaders(request);
    const base = offerBody(trip);
    for (const [change, field] of [
      [{ validUntil: inDays(-1).toISOString() }, 'validUntil'],
      [{ validUntil: inDays(7).toISOString() }, 'validUntil'],
      [{ seatsAvailable: 9 }, 'seatsAvailable'],
      [{ destinationId: trip.goa }, 'destinationId'],
      [{ departureTo: inDays(6, 2).toISOString() }, 'departureTo'],
    ] as const) {
      const response = await request.post('operator/empty-legs', {
        headers,
        data: { ...base, ...change },
      });
      expect(response.status(), field).toBe(400);
      const error = (await response.json()).error;
      expect(error.code).toBe('VALIDATION_ERROR');
      expect(error.details.map((d: { field: string }) => d.field)).toContain(
        field,
      );
    }
    const noOffset = await request.post('operator/empty-legs', {
      headers,
      data: { ...base, departureFrom: '2027-01-01T10:00:00' },
    });
    expect(noOffset.status()).toBe(400);

    const anonymous = await playwright.request.newContext({ baseURL });
    expect((await anonymous.get('operator/empty-legs')).status()).toBe(401);
    expect(
      (await anonymous.post(`empty-legs/${offer.id}/interest`)).status(),
    ).toBe(401);

    const customer = await playwright.request.newContext({ baseURL });
    await signIn(customer, 'customer');
    expect((await customer.get('operator/empty-legs')).status()).toBe(403);
    expect((await customer.get('admin/empty-legs')).status()).toBe(403);

    const finance = await playwright.request.newContext({ baseURL });
    await signIn(finance, 'finance');
    expect((await finance.get('admin/empty-legs')).status()).toBe(403);

    // Another operator sees nothing of this one's offers.
    const other = await playwright.request.newContext({ baseURL });
    await signIn(other, 'operatorAdmin');
    expect((await other.get(`operator/empty-legs/${offer.id}`)).status()).toBe(
      404,
    );
    expect(
      (
        await other.patch(`operator/empty-legs/${offer.id}`, {
          headers: await csrfHeaders(other),
          data: { seatsAvailable: 2 },
        })
      ).status(),
    ).toBe(404);
    const own = await other.get('operator/empty-legs', {
      params: { pageSize: 100 },
    });
    expect(
      ((await own.json()).data as { id: string }[]).map((o) => o.id),
    ).not.toContain(offer.id);

    // Rule 4: an aircraft that is not approved cannot be offered, and a
    // suspended one takes its published offer out of the listing at once.
    await withPrisma((prisma) =>
      prisma.aircraft.update({
        where: { id: trip.aircraftId },
        data: { listingStatus: 'PENDING_REVIEW' },
      }),
    );
    const refused = await request.post(
      `operator/empty-legs/${offer.id}/publish`,
      { headers },
    );
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe('AIRCRAFT_NOT_APPROVED');
    await withPrisma((prisma) =>
      prisma.aircraft.update({
        where: { id: trip.aircraftId },
        data: { listingStatus: 'APPROVED' },
      }),
    );
    await publish(request, offer.id);
    expect(await listedIds(anonymous, { origin: trip.goa })).toContain(
      offer.id,
    );
    await withPrisma((prisma) =>
      prisma.aircraft.update({
        where: { id: trip.aircraftId },
        data: { listingStatus: 'SUSPENDED' },
      }),
    );
    expect(await listedIds(anonymous, { origin: trip.goa })).not.toContain(
      offer.id,
    );
    expect((await anonymous.get(`empty-legs/${offer.id}`)).status()).toBe(404);
  });
});

test.describe('review before publication', () => {
  test('operations approve or reject with a reason; operators cannot', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { offer } = await draftOffer(request, playwright, baseURL);
    // The server runs without EMPTY_LEG_REVIEW_REQUIRED; this is where
    // publishing would put the offer when it is on (unit-tested).
    await withPrisma((prisma) =>
      prisma.emptyLeg.update({
        where: { id: offer.id },
        data: { status: 'PENDING_REVIEW', submittedAt: new Date() },
      }),
    );
    const anonymous = await playwright.request.newContext({ baseURL });
    expect((await anonymous.get(`empty-legs/${offer.id}`)).status()).toBe(404);

    const byOperator = await request.post(
      `admin/empty-legs/${offer.id}/approve`,
      { headers: await csrfHeaders(request) },
    );
    expect(byOperator.status()).toBe(403);
    const edit = await request.patch(`operator/empty-legs/${offer.id}`, {
      headers: await csrfHeaders(request),
      data: { seatsAvailable: 2 },
    });
    expect(edit.status()).toBe(409);

    const { reviewer, headers } = await asReviewer(playwright, baseURL);
    const queue = await reviewer.get('admin/empty-legs', {
      params: { status: 'PENDING_REVIEW', pageSize: 100 },
    });
    expect(queue.status()).toBe(200);
    expect(
      ((await queue.json()).data as { id: string }[]).map((o) => o.id),
    ).toContain(offer.id);

    const noReason = await reviewer.post(
      `admin/empty-legs/${offer.id}/reject`,
      {
        headers,
        data: {},
      },
    );
    expect(noReason.status()).toBe(400);
    const rejected = await reviewer.post(
      `admin/empty-legs/${offer.id}/reject`,
      {
        headers,
        data: { reason: 'The price is missing landing charges.' },
      },
    );
    expect(rejected.status()).toBe(200);
    expect((await rejected.json()).data).toMatchObject({
      status: 'DRAFT',
      reviewNote: 'The price is missing landing charges.',
      publishable: true,
    });
    const notPending = await reviewer.post(
      `admin/empty-legs/${offer.id}/approve`,
      { headers },
    );
    expect(notPending.status()).toBe(409);

    await withPrisma((prisma) =>
      prisma.emptyLeg.update({
        where: { id: offer.id },
        data: { status: 'PENDING_REVIEW' },
      }),
    );
    const approved = await reviewer.post(
      `admin/empty-legs/${offer.id}/approve`,
      { headers },
    );
    expect(approved.status()).toBe(200);
    expect((await approved.json()).data).toMatchObject({
      status: 'PUBLISHED',
      reviewNote: null,
    });
    expect((await anonymous.get(`empty-legs/${offer.id}`)).status()).toBe(200);
  });
});

test.describe('expiry', () => {
  test('an offer past its validity leaves the listing at once, and the job expires it and tells followers', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { trip, offer } = await draftOffer(request, playwright, baseURL);
    await publish(request, offer.id);
    const { customer, email } = await follower(playwright, baseURL);
    await follow(customer, offer.id);

    await withPrisma((prisma) =>
      prisma.emptyLeg.update({
        where: { id: offer.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );
    const anonymous = await playwright.request.newContext({ baseURL });
    expect(await listedIds(anonymous, { origin: trip.goa })).not.toContain(
      offer.id,
    );
    const stale = await anonymous.get(`empty-legs/${offer.id}`);
    expect(stale.status()).toBe(410);
    expect((await stale.json()).error.code).toBe('EMPTY_LEG_EXPIRED');

    // Another run may hold the job's lock for a moment.
    await expect(async () => {
      const run = await anonymous.post('dev/jobs/empty-leg-expiry');
      expect(run.status()).toBe(200);
      expect((await run.json()).data.skipped).toBe(false);
    }).toPass({ timeout: 15_000 });

    const detail = await request.get(`operator/empty-legs/${offer.id}`);
    expect((await detail.json()).data).toMatchObject({
      status: 'EXPIRED',
      editable: false,
      withdrawable: false,
    });
    expect(await inbox(customer, offer.reference)).toContain(
      'empty_leg.expired',
    );
    // And by email, through the outbox.
    const emails = await outbox(anonymous, email);
    expect(
      emails.some((message) => message.body.includes(offer.reference)),
    ).toBe(true);
    const expired = await anonymous.get(`empty-legs/${offer.id}`);
    expect((await expired.json()).error.code).toBe('EMPTY_LEG_EXPIRED');
  });
});

test.describe('operator staff', () => {
  /** Invites staff with these permissions and signs them in. */
  async function staffMember(
    admin: APIRequestContext,
    playwright: Playwright,
    baseURL: string | undefined,
    permissions: { capabilities: string[]; aircraftIds: string[] },
  ) {
    const email = uniqueEmail('staff');
    const invited = await admin.post('operator/staff', {
      headers: await csrfHeaders(admin),
      data: { email, allAircraft: false, ...permissions },
    });
    expect(invited.status()).toBe(201);
    const staff = await playwright.request.newContext({ baseURL });
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

  test('staff need "manage empty legs" and reach only offers on their aircraft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { trip, offer } = await draftOffer(request, playwright, baseURL);
    const other = await request.post('operator/aircraft', {
      headers: await csrfHeaders(request),
      data: aircraftBody(trip.mumbai),
    });
    expect(other.status()).toBe(201);
    const otherId = (await other.json()).data.id as string;

    const withoutCapability = await staffMember(request, playwright, baseURL, {
      capabilities: ['MANAGE_AVAILABILITY'],
      aircraftIds: [trip.aircraftId],
    });
    expect(
      (await withoutCapability.get(`operator/empty-legs/${offer.id}`)).status(),
    ).toBe(403);

    const elsewhere = await staffMember(request, playwright, baseURL, {
      capabilities: ['MANAGE_EMPTY_LEGS'],
      aircraftIds: [otherId],
    });
    expect(
      (await elsewhere.get(`operator/empty-legs/${offer.id}`)).status(),
    ).toBe(404);
    const listed = await elsewhere.get('operator/empty-legs');
    expect((await listed.json()).meta.total).toBe(0);
    const outOfReach = await elsewhere.post('operator/empty-legs', {
      headers: await csrfHeaders(elsewhere),
      data: offerBody(trip),
    });
    expect(outOfReach.status()).toBe(404);

    const assigned = await staffMember(request, playwright, baseURL, {
      capabilities: ['MANAGE_EMPTY_LEGS'],
      aircraftIds: [trip.aircraftId],
    });
    expect(
      (await assigned.get(`operator/empty-legs/${offer.id}`)).status(),
    ).toBe(200);
    // Staff with only "manage empty legs" can pick an aircraft and offer
    // it, but have no fleet access.
    const options = await assigned.get('operator/empty-legs/aircraft');
    expect(options.status()).toBe(200);
    expect((await options.json()).data).toEqual([
      expect.objectContaining({ id: trip.aircraftId, seats: 8 }),
    ]);
    const created = await assigned.post('operator/empty-legs', {
      headers: await csrfHeaders(assigned),
      data: offerBody(trip),
    });
    expect(created.status()).toBe(201);
    const edit = await assigned.patch(`operator/aircraft/${trip.aircraftId}`, {
      headers: await csrfHeaders(assigned),
      data: { baggageCapacityKg: 400 },
    });
    expect(edit.status()).toBe(403);
    expect(
      (await withoutCapability.get('operator/empty-legs/aircraft')).status(),
    ).toBe(403);

    const published = await assigned.post(
      `operator/empty-legs/${offer.id}/publish`,
      { headers: await csrfHeaders(assigned) },
    );
    expect(published.status()).toBe(200);
    expect((await published.json()).data.status).toBe('PUBLISHED');
  });
});
