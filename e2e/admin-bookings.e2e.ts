import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { ACCOUNTS } from './support/accounts.js';
import {
  latestLinkToken,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Bookings for Flyviman staff (M8, W3-3): search, detail, the operations
 * owner, internal notes, the status override with a reason, and the lists
 * of open change requests for operations and operators.
 */

type Contexts = Parameters<typeof listedJet>[0];

/** Charges by notice; the test trip departs 78 to 102 hours from now. */
const TIERED_TERMS = {
  version: 1,
  source: 'OPERATOR_QUOTE',
  summary: 'Free until 5 days before, 50% until 3 days before, then 100%.',
  charges: [
    { minHoursBeforeDeparture: 120, chargePercent: 0 },
    { minHoursBeforeDeparture: 72, chargePercent: 50 },
    { minHoursBeforeDeparture: 0, chargePercent: 100 },
  ],
  acceptedAt: '2026-11-20T00:00:00.000Z',
};

/**
 * A fresh customer's request on a fresh, priced jet whose operator
 * administrator is signed in on `contexts.request`.
 */
async function bookedTrip(contexts: Contexts) {
  const { request, playwright, baseURL } = contexts;
  const trip = await listedJet(contexts);
  const priced = await request.put(
    `operator/aircraft/${trip.aircraftId}/pricing`,
    {
      headers: await csrfHeaders(request),
      data: {
        hourlyRateMinor: 18_000_000,
        taxInclusive: false,
        commissionInclusive: false,
        minBillableHours: null,
      },
    },
  );
  expect(priced.status()).toBe(200);
  const searched = await searchFor(request, trip);
  const customer = await playwright.request.newContext({ baseURL });
  const { email } = await registerCustomer(customer);
  const created = await customer.post('bookings', {
    headers: {
      ...(await csrfHeaders(customer)),
      'Idempotency-Key': randomUUID(),
    },
    data: {
      searchId: searched.searchId,
      resultId: searched.result.resultId,
      expectedTotalMinor: searched.result.price.amountMinor,
      currency: 'INR',
      specialRequests: 'Wheelchair at the gate',
    },
  });
  expect(created.status()).toBe(201);
  const reference = (await created.json()).data.reference as string;
  return { customer, email, reference, trip };
}

async function staffSession(contexts: Contexts, account: 'ops' | 'finance') {
  const context = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await signIn(context, account);
  return context;
}

async function send(
  context: APIRequestContext,
  method: 'post' | 'patch',
  path: string,
  data?: unknown,
) {
  return context[method](path, {
    headers: await csrfHeaders(context),
    ...(data === undefined ? {} : { data }),
  });
}

function override(
  context: APIRequestContext,
  reference: string,
  data: unknown,
) {
  return send(context, 'patch', `admin/bookings/${reference}/status`, data);
}

function stored(reference: string) {
  return withPrisma((prisma) =>
    prisma.booking.findUniqueOrThrow({
      where: { reference },
      include: {
        holds: true,
        changeRequests: true,
        events: { orderBy: { createdAt: 'asc' } },
      },
    }),
  );
}

/** A staff member of the operator on `contexts.request`, signed in. */
async function staffMember(contexts: Contexts, capabilities: string[]) {
  const email = uniqueEmail('staff');
  const invited = await send(contexts.request, 'post', 'operator/staff', {
    email,
    allAircraft: true,
    aircraftIds: [],
    capabilities,
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

test.describe('GET /admin/bookings', () => {
  test('operations search and read everything; finance reads without passenger data or free text', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, email, reference, trip } = await bookedTrip(contexts);
    const ops = await staffSession(contexts, 'ops');
    const finance = await staffSession(contexts, 'finance');

    for (const q of [reference, email.toUpperCase()]) {
      const found = await ops.get('admin/bookings', { params: { q } });
      expect(found.status()).toBe(200);
      const body = await found.json();
      expect(
        body.data.some(
          (entry: { reference: string }) => entry.reference === reference,
        ),
      ).toBe(true);
    }
    const byEmail = await ops.get('admin/bookings', { params: { q: email } });
    const body = await byEmail.json();
    expect(body.meta).toMatchObject({ page: 1, pageSize: 20, total: 1 });
    expect(body.data[0]).toMatchObject({
      reference,
      status: 'OPERATOR_PENDING',
      paymentStatus: 'UNPAID',
      price: { priceType: 'ESTIMATE' },
      customer: { email },
      aircraftRegistration: expect.any(String),
      assignedToId: null,
    });
    const filtered = await ops.get('admin/bookings', {
      params: { q: email, status: 'CONFIRMED' },
    });
    expect((await filtered.json()).meta.total).toBe(0);
    const later = await ops.get('admin/bookings', {
      params: { q: email, from: new Date(Date.now() + 60_000).toISOString() },
    });
    expect((await later.json()).meta.total).toBe(0);
    for (const params of [
      { status: 'NOPE' } as Record<string, string>,
      { pageSize: '101' },
      { from: 'yesterday' },
    ]) {
      expect((await ops.get('admin/bookings', { params })).status()).toBe(400);
    }

    const full = (await (await ops.get(`admin/bookings/${reference}`)).json())
      .data;
    expect(full).toMatchObject({
      reference,
      itinerary: { aircraft: { id: trip.aircraftId } },
      specialRequests: 'Wheelchair at the gate',
      passengers: [],
      notes: [],
      quotes: [],
      payments: [],
    });
    expect(
      full.events.map((event: { toStatus: string }) => event.toStatus),
    ).toEqual(['REQUESTED', 'OPERATOR_PENDING']);
    // Timeline entries carry no payload.
    expect(full.events[0]).not.toHaveProperty('payload');

    const listed = await finance.get('admin/bookings', {
      params: { q: email },
    });
    expect(listed.status()).toBe(200);
    const restricted = await finance.get(`admin/bookings/${reference}`);
    expect(restricted.status()).toBe(200);
    expect((await restricted.json()).data).toMatchObject({
      reference,
      passengers: null,
      specialRequests: null,
      notes: null,
    });

    expect((await customer.get('admin/bookings')).status()).toBe(403);
    expect((await request.get(`admin/bookings/${reference}`)).status()).toBe(
      403,
    );
    expect((await ops.get('admin/bookings/FLY-BK-000000')).status()).toBe(404);
  });
});

test.describe('assign and notes', () => {
  test('operations set and remove the owner (audited) and keep internal notes', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);
    const ops = await staffSession(contexts, 'ops');
    const finance = await staffSession(contexts, 'finance');
    const [opsId, customerId] = await withPrisma(async (prisma) => [
      (
        await prisma.user.findUniqueOrThrow({
          where: { email: ACCOUNTS.ops.email },
        })
      ).id,
      (await prisma.booking.findUniqueOrThrow({ where: { reference } }))
        .customerId,
    ]);
    const assign = (who: APIRequestContext, assigneeId: unknown) =>
      send(who, 'post', `admin/bookings/${reference}/assign`, { assigneeId });

    const wrong = await assign(ops, customerId);
    expect(wrong.status()).toBe(400);
    expect((await wrong.json()).error.details).toContainEqual(
      expect.objectContaining({ field: 'assigneeId' }),
    );
    expect((await assign(ops, 'nope')).status()).toBe(400);
    expect((await assign(finance, opsId)).status()).toBe(403);
    expect((await assign(request, opsId)).status()).toBe(403);

    const assigned = await assign(ops, opsId);
    expect(assigned.status()).toBe(200);
    expect((await assigned.json()).data.assignedToId).toBe(opsId);
    const cleared = await assign(ops, null);
    expect((await cleared.json()).data.assignedToId).toBeNull();
    const audits = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      return prisma.auditLog.findMany({
        where: { entityId: booking.id, action: 'booking.assign' },
        orderBy: { createdAt: 'asc' },
      });
    });
    expect(audits.map((entry) => entry.after)).toEqual([
      { reference, assignedToId: opsId },
      { reference, assignedToId: null },
    ]);

    const path = `admin/bookings/${reference}/notes`;
    expect((await send(ops, 'post', path, { note: '' })).status()).toBe(400);
    expect(
      (await send(finance, 'post', path, { note: 'Hello' })).status(),
    ).toBe(403);
    const added = await send(ops, 'post', path, {
      note: 'Customer called about timing',
    });
    expect(added.status()).toBe(201);
    const detail = (await (await ops.get(`admin/bookings/${reference}`)).json())
      .data;
    expect(detail.notes).toEqual([
      expect.objectContaining({ body: 'Customer called about timing' }),
    ]);
    // Never the operator's or the customer's.
    const operatorView = (
      await (await request.get(`operator/booking-requests/${reference}`)).json()
    ).data;
    expect(operatorView.notes).toEqual([]);
    expect(
      JSON.stringify(
        await (await customer.get(`bookings/${reference}`)).json(),
      ),
    ).not.toContain('Customer called');
    // Stored encrypted.
    const row = await stored(reference);
    expect(JSON.stringify(row.events)).not.toContain('Customer called');
  });
});

test.describe('PATCH /admin/bookings/:reference/status', () => {
  test('overrides with a reason, audited before and after; ending statuses release the hold', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);
    const ops = await staffSession(contexts, 'ops');
    const finance = await staffSession(contexts, 'finance');

    expect(
      (await override(ops, reference, { status: 'EXPIRED' })).status(),
    ).toBe(400);
    expect(
      (
        await override(ops, reference, { status: 'EXPIRED', reason: 'x' })
      ).status(),
    ).toBe(400);
    expect(
      (
        await override(ops, reference, { status: 'NOPE', reason: 'Agreed' })
      ).status(),
    ).toBe(400);
    for (const who of [finance, request, customer]) {
      expect(
        (
          await override(who, reference, {
            status: 'EXPIRED',
            reason: 'Customer asked by phone',
          })
        ).status(),
      ).toBe(403);
    }
    const same = await override(ops, reference, {
      status: 'OPERATOR_PENDING',
      reason: 'No change',
    });
    expect(same.status()).toBe(409);
    expect((await same.json()).error.code).toBe('BOOKING_INVALID_TRANSITION');

    const moved = await override(ops, reference, {
      status: 'EXPIRED',
      reason: 'Customer asked by phone',
    });
    expect(moved.status()).toBe(200);
    const detail = (await moved.json()).data;
    expect(detail.status).toBe('EXPIRED');
    expect(detail.events.at(-1)).toMatchObject({
      fromStatus: 'OPERATOR_PENDING',
      toStatus: 'EXPIRED',
      actorRole: 'OPS',
      overrideReason: 'Customer asked by phone',
    });
    const row = await stored(reference);
    expect(row.holds[0].expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: row.id, action: 'booking.status' },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(audit).toMatchObject({
      before: { reference, status: 'OPERATOR_PENDING' },
      after: { reference, status: 'EXPIRED' },
      reason: 'Customer asked by phone',
    });
    // Finance reads the reason too, as in the audit trail.
    const restricted = (
      await (await finance.get(`admin/bookings/${reference}`)).json()
    ).data;
    expect(restricted.events.at(-1).overrideReason).toBe(
      'Customer asked by phone',
    );
  });

  test('an override to CANCELLED applies the terms and records the refund due, as a customer’s cancellation does', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference } = await bookedTrip(contexts);
    await withPrisma((prisma) =>
      prisma.booking.update({
        where: { reference },
        data: {
          status: 'AWAITING_PAYMENT',
          priceType: 'CONFIRMED',
          cancellationTerms: TIERED_TERMS,
        },
      }),
    );
    const ops = await staffSession(contexts, 'ops');
    // Not while a payment waits for the gateway's answer.
    const paymentId = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      return (
        await prisma.payment.create({
          data: {
            reference: `FLY-PY-${randomUUID().slice(0, 6).toUpperCase()}`,
            bookingId: booking.id,
            provider: 'MOCK',
            purpose: 'FULL',
            amountMinor: booking.totalMinor,
            currency: 'INR',
            status: 'PENDING',
            idempotencyKey: `e2e:${randomUUID()}`,
          },
        })
      ).id;
    });
    const waiting = await override(ops, reference, {
      status: 'CANCELLED',
      reason: 'Operator grounded the aircraft',
    });
    expect(waiting.status()).toBe(409);
    expect((await waiting.json()).error.code).toBe(
      'BOOKING_PAYMENT_IN_PROGRESS',
    );
    await withPrisma((prisma) =>
      prisma.payment.update({
        where: { id: paymentId },
        data: { status: 'FAILED' },
      }),
    );
    const response = await override(ops, reference, {
      status: 'CANCELLED',
      reason: 'Operator grounded the aircraft',
    });
    expect(response.status()).toBe(200);
    expect((await response.json()).data).toMatchObject({
      status: 'CANCELLED',
      cancelledAt: expect.any(String),
    });
    const row = await stored(reference);
    // 78 to 102 hours before departure: the 50% rule; nothing paid, so
    // nothing is due back.
    const charge = (row.totalMinor * 50n) / 100n;
    expect(row.changeRequests).toEqual([
      expect.objectContaining({
        kind: 'CANCELLATION',
        status: 'COMPLETED',
        // Encrypted at rest (S3-b), like a customer's cancellation.
        details: expect.stringMatching(/^v1\./),
        chargeMinor: charge,
        refundMinor: 0n,
      }),
    ]);
    const cancelled = row.events.find(
      (event) => event.toStatus === 'CANCELLED',
    );
    expect(cancelled?.payload).toMatchObject({
      override: true,
      reason: 'Operator grounded the aircraft',
      cancellation: {
        chargeMinor: Number(charge),
        refundMinor: 0,
        appliedCharge: { chargePercent: 50 },
      },
    });
    expect(row.holds[0].expiresAt!.getTime()).toBeLessThanOrEqual(Date.now());
    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: {
          entityId: row.id,
          action: { in: ['booking.status', 'booking.cancel'] },
        },
      }),
    );
    // The override's status record, with its reason, and the cancellation.
    expect(
      audits
        .filter(
          (entry) =>
            entry.action === 'booking.cancel' ||
            entry.reason === 'Operator grounded the aircraft',
        )
        .map((entry) => entry.action)
        .sort(),
    ).toEqual(['booking.cancel', 'booking.status']);
  });

  test('an override to CONFIRMED rechecks the held time (rule 3)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference } = await bookedTrip(contexts);
    await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
        include: { holds: true },
      });
      const hold = booking.holds[0];
      await prisma.availabilityBlock.create({
        data: {
          aircraftId: hold.aircraftId,
          startsAt: hold.startsAt,
          endsAt: hold.endsAt,
          reason: 'MAINTENANCE',
        },
      });
    });
    const ops = await staffSession(contexts, 'ops');
    const refused = await override(ops, reference, {
      status: 'CONFIRMED',
      reason: 'Confirmed with the operator by phone',
    });
    expect(refused.status()).toBe(409);
    expect((await refused.json()).error.code).toBe('BOOKING_UNAVAILABLE');
    expect((await stored(reference)).status).toBe('OPERATOR_PENDING');
  });
});

test.describe('open change-request lists', () => {
  test('operations list every open request; the operator its own; staff need MANAGE_BOOKINGS', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);
    const asked = await send(
      customer,
      'post',
      `bookings/${reference}/change-requests`,
      { details: 'Could we leave an hour later?' },
    );
    expect(asked.status()).toBe(201);
    const change = (await asked.json()).data;
    const listed = (response: { data: { id: string }[] }) =>
      response.data.some((entry) => entry.id === change.id);

    const ops = await staffSession(contexts, 'ops');
    const all = await ops.get('admin/change-requests', {
      params: { pageSize: '100' },
    });
    expect(all.status()).toBe(200);
    expect(listed(await all.json())).toBe(true);
    const decided = await ops.get('admin/change-requests', {
      params: { status: 'APPROVED', pageSize: '100' },
    });
    expect(listed(await decided.json())).toBe(false);
    const finance = await staffSession(contexts, 'finance');
    expect((await finance.get('admin/change-requests')).status()).toBe(403);
    expect((await customer.get('admin/change-requests')).status()).toBe(403);

    const own = await request.get('operator/change-requests');
    expect(own.status()).toBe(200);
    const ownBody = await own.json();
    expect(ownBody.data).toEqual([
      expect.objectContaining({
        id: change.id,
        bookingReference: reference,
        kind: 'CHANGE',
        status: 'REQUESTED',
      }),
    ]);

    // Staff with only another capability neither list nor answer.
    const fleetOnly = await staffMember(contexts, ['MANAGE_AIRCRAFT']);
    expect((await fleetOnly.get('operator/change-requests')).status()).toBe(
      403,
    );
    const refused = await send(
      fleetOnly,
      'post',
      `operator/change-requests/${change.id}/decide`,
      { decision: 'APPROVED', note: 'Fine' },
    );
    expect(refused.status()).toBe(403);

    const bookingsStaff = await staffMember(contexts, ['MANAGE_BOOKINGS']);
    expect(
      listed(
        await (await bookingsStaff.get('operator/change-requests')).json(),
      ),
    ).toBe(true);
    const answered = await send(
      bookingsStaff,
      'post',
      `operator/change-requests/${change.id}/decide`,
      { decision: 'APPROVED', note: 'We can leave at 07:00.' },
    );
    expect(answered.status()).toBe(200);
    expect(
      listed(await (await request.get('operator/change-requests')).json()),
    ).toBe(false);
    expect(
      (
        await request.get('operator/change-requests', {
          params: { status: 'NOPE' },
        })
      ).status(),
    ).toBe(400);
  });
});
