import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Operations' escalation flag on a booking (M8-C, D-200): who may set and
 * clear it, the conflict codes, the list filter, the encrypted reason, what
 * the customer never sees, and the audit trail.
 */

type Contexts = Parameters<typeof listedJet>[0];

const ESCALATE_REASON = 'Operator unreachable since Monday, Ref Q7 chase';
const RESOLVE_REASON = 'Operator confirmed the crew by phone, Ref Q9';

function newContext(contexts: Contexts) {
  return contexts.playwright.request.newContext({ baseURL: contexts.baseURL });
}

async function staffAccount(
  contexts: Contexts,
  account: 'ops' | 'finance' | 'superAdmin',
) {
  const context = await newContext(contexts);
  await signIn(context, account);
  return context;
}

/** A customer's request on a fresh priced jet. */
async function bookedTrip(contexts: Contexts) {
  const { request } = contexts;
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
  const customer = await newContext(contexts);
  await registerCustomer(customer);
  const created = await customer.post('bookings', {
    headers: {
      ...(await csrfHeaders(customer)),
      'Idempotency-Key': randomUUID(),
    },
    data: {
      searchId: searched.searchId,
      resultId: searched.result.resultId,
      cancellationTermsVersion: searched.termsVersion,
      expectedTotalMinor: searched.result.price.amountMinor,
      currency: 'INR',
    },
  });
  expect(created.status()).toBe(201);
  return {
    customer,
    reference: (await created.json()).data.reference as string,
  };
}

async function post(
  who: APIRequestContext,
  reference: string,
  action: 'escalate' | 'resolve-escalation',
  data: unknown,
) {
  return who.post(`admin/bookings/${reference}/${action}`, {
    headers: await csrfHeaders(who),
    data,
  });
}

async function escalatedList(who: APIRequestContext) {
  const response = await who.get('admin/bookings', {
    params: { escalated: 'true', pageSize: '100' },
  });
  expect(response.status()).toBe(200);
  return ((await response.json()).data as { reference: string }[]).map(
    (entry) => entry.reference,
  );
}

test.describe('booking escalation', () => {
  test('only operations and the super administrator escalate and resolve, with a reason', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);
    const ops = await staffAccount(contexts, 'ops');
    const finance = await staffAccount(contexts, 'finance');
    const superAdmin = await staffAccount(contexts, 'superAdmin');

    for (const who of [finance, request, customer]) {
      expect(
        (
          await post(who, reference, 'escalate', { reason: ESCALATE_REASON })
        ).status(),
      ).toBe(403);
    }
    const visitor = await newContext(contexts);
    expect(
      (
        await visitor.post(`admin/bookings/${reference}/escalate`, {
          data: { reason: ESCALATE_REASON },
        })
      ).status(),
    ).toBe(401);

    // The reason is required, 3 to 500 characters.
    for (const data of [
      {},
      { reason: '' },
      { reason: 'ab' },
      { reason: 'x'.repeat(501) },
    ]) {
      const bad = await post(ops, reference, 'escalate', data);
      expect(bad.status()).toBe(400);
      expect((await bad.json()).error.details).toContainEqual(
        expect.objectContaining({ field: 'reason' }),
      );
    }
    expect(
      (
        await post(ops, 'FLY-BK-000000', 'escalate', {
          reason: ESCALATE_REASON,
        })
      ).status(),
    ).toBe(404);

    // Resolving what is not escalated is a conflict.
    const early = await post(ops, reference, 'resolve-escalation', {
      reason: RESOLVE_REASON,
    });
    expect(early.status()).toBe(409);
    expect((await early.json()).error.code).toBe('BOOKING_ESCALATION_CONFLICT');
    expect(await escalatedList(ops)).not.toContain(reference);

    const escalated = await post(ops, reference, 'escalate', {
      reason: ESCALATE_REASON,
    });
    expect(escalated.status()).toBe(200);
    const detail = (await escalated.json()).data;
    expect(detail).toMatchObject({
      reference,
      status: 'OPERATOR_PENDING',
      escalation: { reason: ESCALATE_REASON },
    });
    expect(detail.escalatedAt).toEqual(expect.any(String));
    expect(await escalatedList(ops)).toContain(reference);
    expect(await escalatedList(superAdmin)).toContain(reference);

    // A second escalation while escalated: 409, and nothing is added.
    const again = await post(superAdmin, reference, 'escalate', {
      reason: ESCALATE_REASON,
    });
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('BOOKING_ESCALATION_CONFLICT');

    // Finance and the rest cannot resolve; the super administrator can.
    for (const who of [finance, request, customer]) {
      expect(
        (
          await post(who, reference, 'resolve-escalation', {
            reason: RESOLVE_REASON,
          })
        ).status(),
      ).toBe(403);
    }
    expect(await escalatedList(ops)).toContain(reference);
    const resolved = await post(superAdmin, reference, 'resolve-escalation', {
      reason: RESOLVE_REASON,
    });
    expect(resolved.status()).toBe(200);
    expect((await resolved.json()).data).toMatchObject({
      reference,
      status: 'OPERATOR_PENDING',
      escalatedAt: null,
      escalation: null,
    });
    expect(await escalatedList(ops)).not.toContain(reference);
    const twice = await post(ops, reference, 'resolve-escalation', {
      reason: RESOLVE_REASON,
    });
    expect(twice.status()).toBe(409);
    expect((await twice.json()).error.code).toBe('BOOKING_ESCALATION_CONFLICT');
  });

  test('the reason is stored encrypted, shown to operations, and hidden from the customer; both moves are audited', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference } = await bookedTrip(contexts);
    const ops = await staffAccount(contexts, 'ops');

    expect(
      (
        await post(ops, reference, 'escalate', { reason: ESCALATE_REASON })
      ).status(),
    ).toBe(200);

    // Reads back for operations on the detail and the timeline entry.
    const read = (await (await ops.get(`admin/bookings/${reference}`)).json())
      .data;
    expect(read.escalation).toMatchObject({ reason: ESCALATE_REASON });
    expect(read.events).toContainEqual(
      expect.objectContaining({
        type: 'ESCALATED',
        overrideReason: ESCALATE_REASON,
        actorRole: 'OPS',
      }),
    );

    // Stored encrypted: the plain text is nowhere in the event payload.
    const row = await withPrisma((prisma) =>
      prisma.booking.findUniqueOrThrow({
        where: { reference },
        include: { events: true },
      }),
    );
    const event = row.events.find((entry) => entry.type === 'ESCALATED');
    expect(event).toBeTruthy();
    expect(JSON.stringify(event?.payload)).not.toContain(
      'Operator unreachable',
    );
    expect(JSON.stringify(event?.payload)).not.toContain('Q7');
    expect(row.status).toBe('OPERATOR_PENDING');

    // The customer sees no sign of it, before or after it is resolved.
    expect(
      (
        await post(ops, reference, 'resolve-escalation', {
          reason: RESOLVE_REASON,
        })
      ).status(),
    ).toBe(200);
    const customerView = [
      await (await customer.get(`bookings/${reference}`)).text(),
      await (await customer.get(`bookings/${reference}/events`)).text(),
      await (await customer.get('me/bookings')).text(),
    ];
    for (const text of customerView) {
      expect(text).not.toContain('Operator unreachable');
      expect(text).not.toContain('Operator confirmed the crew');
      expect(text.toLowerCase()).not.toContain('escalat');
    }
    // Nor does the operator.
    const operatorView = [
      await (
        await request.get(`operator/booking-requests/${reference}`)
      ).text(),
    ];
    for (const text of operatorView) {
      expect(text).not.toContain('Operator unreachable');
      expect(text.toLowerCase()).not.toContain('escalat');
    }

    // Audited, with actor, before and after, and the reason (rule 6).
    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: {
          entityId: row.id,
          action: { in: ['booking.escalate', 'booking.escalation_resolve'] },
        },
        orderBy: { createdAt: 'asc' },
      }),
    );
    expect(audits.map((entry) => entry.action)).toEqual([
      'booking.escalate',
      'booking.escalation_resolve',
    ]);
    expect(audits[0]).toMatchObject({
      actorRole: 'OPS',
      reason: ESCALATE_REASON,
      before: { reference, escalatedAt: null },
    });
    expect((audits[0].after as { escalatedAt: string }).escalatedAt).toEqual(
      expect.any(String),
    );
    expect(audits[0].actorId).toBeTruthy();
    expect(audits[1]).toMatchObject({
      actorRole: 'OPS',
      reason: RESOLVE_REASON,
      after: { reference, escalatedAt: null },
    });
    expect((audits[1].before as { escalatedAt: string }).escalatedAt).toEqual(
      expect.any(String),
    );
  });
});
