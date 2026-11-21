import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { Redis } from 'ioredis';
import {
  MOCK_EVENT_ID_HEADER,
  MOCK_PAYMENT_WEBHOOK_SECRET,
  MOCK_SIGNATURE_HEADER,
} from '../src/integrations/payment/mock-payment-gateway.provider.js';
import { hmacSha256Hex } from '../src/integrations/payment/payment-signature.js';
import { registerCustomer } from './support/data.js';
import { addAircraftDocument, aircraftBody } from './support/fleet.js';
import { withPrisma } from './support/db.js';
import { inDays, listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Operator settlements, the reconciliation report and payment flag
 * resolution (M9, W4-2, D-197, D-198, D-207, D-210). Payments run through the
 * mock gateway's checkout; the settlement job is run on demand
 * (`POST /dev/jobs/settlement-sync`). Each test builds its own operator, so
 * tests do not share records.
 */

type Contexts = Parameters<typeof listedJet>[0];
type Signed = { body: string; headers: Record<string, string> };
type Trip = Awaited<ReturnType<typeof listedJet>>;
type Settlement = {
  id: string;
  bookingReference: string;
  operatorId: string;
  payableMinor: number;
  commissionMinor: number;
  taxMinor: number;
  keptMinor: number;
  status: string;
  notDueReason: string | null;
  paidAt: string | null;
  paymentReference: string | null;
};

function newContext(contexts: Contexts) {
  return contexts.playwright.request.newContext({ baseURL: contexts.baseURL });
}

async function staff(
  contexts: Contexts,
  account: 'finance' | 'ops' | 'superAdmin',
) {
  const context = await newContext(contexts);
  await signIn(context, account);
  return context;
}

/** An approved operator (the signed-in `request`) with a priced jet. */
async function operatorWithJet(contexts: Contexts): Promise<Trip> {
  const { request } = contexts;
  const trip = await listedJet(contexts);
  const rate = await request.put(
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
  expect(rate.status()).toBe(200);
  return trip;
}

/** Another priced jet for the same (approved) operator. */
async function anotherJet(
  request: APIRequestContext,
  trip: Trip,
): Promise<Trip> {
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
  const rate = await request.put(`operator/aircraft/${aircraftId}/pricing`, {
    headers: await csrfHeaders(request),
    data: {
      hourlyRateMinor: 18_000_000,
      taxInclusive: false,
      commissionInclusive: false,
      minBillableHours: null,
    },
  });
  expect(rate.status()).toBe(200);
  return { ...trip, aircraftId };
}

/** A booking awaiting payment on the operator's jet, for a new customer. */
async function bookingOn(contexts: Contexts, trip: Trip) {
  const { request } = contexts;
  const searched = await searchFor(request, trip);
  const customer = await newContext(contexts);
  await registerCustomer(customer);
  const booked = await customer.post('bookings', {
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
  expect(booked.status()).toBe(201);
  const reference = (await booked.json()).data.reference as string;
  await withPrisma((prisma) =>
    prisma.booking.update({
      where: { reference },
      data: {
        status: 'AWAITING_PAYMENT',
        priceType: 'CONFIRMED',
        operatorAcceptedAt: new Date(),
        paymentModel: 'B_OPERATOR_CONFIRMED',
      },
    }),
  );
  return {
    customer,
    reference,
    totalMinor: searched.result.price.amountMinor as number,
  };
}

function deliver(request: APIRequestContext, webhook: Signed) {
  return request.post('webhooks/payments/mock', {
    data: webhook.body,
    headers: webhook.headers,
  });
}

async function payInFull(
  request: APIRequestContext,
  customer: APIRequestContext,
  reference: string,
  amountMinor: number,
) {
  const ordered = await customer.post(`bookings/${reference}/payments`, {
    headers: {
      ...(await csrfHeaders(customer)),
      'Idempotency-Key': randomUUID(),
    },
    data: { expectedAmountMinor: amountMinor, currency: 'INR' },
  });
  expect(ordered.status()).toBe(201);
  const payment = (await ordered.json()).data as {
    reference: string;
    checkout: { orderId: string };
  };
  const simulated = await request.post(
    `dev/payments/orders/${payment.checkout.orderId}/simulate`,
    {
      headers: await csrfHeaders(request),
      data: { outcome: 'success' },
    },
  );
  expect(simulated.status()).toBe(200);
  const { webhook } = (await simulated.json()).data as { webhook: Signed };
  expect((await deliver(request, webhook)).status()).toBe(200);
  return payment;
}

/** A paid booking, then flown: the trip is marked completed directly. */
async function completedBooking(contexts: Contexts, trip: Trip) {
  const booking = await bookingOn(contexts, trip);
  const payment = await payInFull(
    contexts.request,
    booking.customer,
    booking.reference,
    booking.totalMinor,
  );
  await withPrisma((prisma) =>
    prisma.booking.update({
      where: { reference: booking.reference },
      data: { status: 'COMPLETED' },
    }),
  );
  return { ...booking, payment };
}

async function runSync(request: APIRequestContext) {
  return request.post('dev/jobs/settlement-sync', {
    headers: await csrfHeaders(request),
  });
}

/** The settlement job's Redis lock (`SYNC_LOCK_KEY` in settlements.service.ts). */
const SYNC_LOCK_KEY = 'payments:settlements:lock';
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/**
 * Runs `steps` while holding the settlement job's lock, so no sync started by
 * another test (they run in parallel, and each sync covers every booking) or
 * by the 5-minute schedule moves a record in between. Waits for a sync in
 * flight to finish first, and proves the lock holds (the job answers
 * `skipped`).
 */
async function withSyncPaused<T>(
  request: APIRequestContext,
  steps: () => Promise<T>,
): Promise<T> {
  const redis = new Redis(process.env.REDIS_URL!);
  const token = randomUUID();
  try {
    for (let attempt = 0; ; attempt += 1) {
      if (await redis.set(SYNC_LOCK_KEY, token, 'EX', 60, 'NX')) break;
      if (attempt >= 100) throw new Error('The settlement job never ended.');
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    const ran = await runSync(request);
    expect((await ran.json()).data).toMatchObject({ skipped: true });
    return await steps();
  } finally {
    await redis.eval(RELEASE_LOCK, 1, SYNC_LOCK_KEY, token);
    redis.disconnect();
  }
}

/**
 * Runs the settlement job until `ready` holds for the booking's record (a
 * job already running elsewhere answers `skipped`, so it is retried).
 */
async function syncUntil(
  request: APIRequestContext,
  reference: string,
  ready: (row: { status: string; payableMinor: bigint }) => boolean = () =>
    true,
) {
  for (let attempt = 0; attempt < 15; attempt += 1) {
    const ran = await runSync(request);
    expect(ran.status()).toBe(200);
    const row = await withPrisma((prisma) =>
      prisma.settlement.findFirst({ where: { booking: { reference } } }),
    );
    if (row && ready(row)) return row;
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`No settlement became ready for ${reference}.`);
}

async function change(
  finance: APIRequestContext,
  id: string,
  data: Record<string, unknown>,
  key: string = randomUUID(),
) {
  return finance.patch(`admin/settlements/${id}`, {
    headers: { ...(await csrfHeaders(finance)), 'Idempotency-Key': key },
    data,
  });
}

async function errorCode(response: Awaited<ReturnType<typeof change>>) {
  return (await response.json()).error.code as string;
}

async function adminView(finance: APIRequestContext, id: string) {
  const list = await finance.get('admin/settlements?pageSize=100');
  expect(list.status()).toBe(200);
  return ((await list.json()).data as Settlement[]).find((s) => s.id === id);
}

test.describe('settlement creation', () => {
  test('a paid, completed booking gets a DUE settlement: kept = commission + tax + payable', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await operatorWithJet(contexts);
    const booking = await completedBooking(contexts, trip);
    const finance = await staff(contexts, 'finance');

    const row = await syncUntil(request, booking.reference);
    expect(row.status).toBe('DUE');
    const shown = await adminView(finance, row.id);
    expect(shown).toMatchObject({
      bookingReference: booking.reference,
      status: 'DUE',
      keptMinor: booking.totalMinor,
      currency: 'INR',
      notDueReason: null,
      paidAt: null,
      paymentReference: null,
    });
    expect(shown!.commissionMinor + shown!.taxMinor + shown!.payableMinor).toBe(
      booking.totalMinor,
    );
    expect(shown!.commissionMinor).toBeGreaterThan(0);

    // The payable is the price calculation's operator payable.
    const calc = await withPrisma(async (prisma) => {
      const b = await prisma.booking.findUniqueOrThrow({
        where: { reference: booking.reference },
        select: { calculationId: true },
      });
      return prisma.priceCalculation.findUniqueOrThrow({
        where: { id: b.calculationId! },
      });
    });
    expect(BigInt(shown!.payableMinor)).toBe(calc.operatorPayableMinor);

    // A second run changes nothing and creates no second record.
    await runSync(request);
    const rows = await withPrisma((prisma) =>
      prisma.settlement.findMany({
        where: { booking: { reference: booking.reference } },
      }),
    );
    expect(rows).toHaveLength(1);
  });

  test('a booking that is not completed gets no settlement', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await operatorWithJet(contexts);
    const booking = await bookingOn(contexts, trip);
    await payInFull(
      request,
      booking.customer,
      booking.reference,
      booking.totalMinor,
    );
    expect((await runSync(request)).status()).toBe(200);
    const rows = await withPrisma((prisma) =>
      prisma.settlement.count({
        where: { booking: { reference: booking.reference } },
      }),
    );
    expect(rows).toBe(0);
  });
});

test.describe('PATCH /admin/settlements/:id', () => {
  test('finance holds, releases and marks paid; each guard answers its code', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await operatorWithJet(contexts);
    const booking = await completedBooking(contexts, trip);
    const row = await syncUntil(request, booking.reference);
    const finance = await staff(contexts, 'finance');
    const ops = await staff(contexts, 'ops');
    const reason = 'Checked with the operator.';
    // Payout references are unique per operator across runs.
    const utr = `UTR-${randomUUID().slice(0, 8)}`;

    // Only finance and the super administrator.
    expect(
      (await change(ops, row.id, { status: 'ON_HOLD', reason })).status(),
    ).toBe(403);
    expect(
      (await change(request, row.id, { status: 'ON_HOLD', reason })).status(),
    ).toBe(403);
    expect(
      (
        await change(booking.customer, row.id, { status: 'ON_HOLD', reason })
      ).status(),
    ).toBe(403);

    // A reason is required.
    const noReason = await change(finance, row.id, { status: 'ON_HOLD' });
    expect(noReason.status()).toBe(400);
    expect(await errorCode(noReason)).toBe('VALIDATION_ERROR');
    expect(
      (
        await change(finance, row.id, { status: 'ON_HOLD', reason: 'x' })
      ).status(),
    ).toBe(400);

    // Hold, once per key.
    const key = randomUUID();
    const held = await change(
      finance,
      row.id,
      { status: 'ON_HOLD', reason },
      key,
    );
    expect(held.status()).toBe(200);
    const heldBody = (await held.json()).data;
    expect(heldBody.status).toBe('ON_HOLD');
    const replay = await change(
      finance,
      row.id,
      { status: 'ON_HOLD', reason },
      key,
    );
    expect(replay.status()).toBe(200);
    expect(replay.headers()['idempotent-replayed']).toBe('true');
    expect((await replay.json()).data).toEqual(heldBody);
    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: row.id, action: 'settlement.status' },
      }),
    );
    expect(audits).toHaveLength(1);
    expect(audits[0].reason).toBe(reason);

    // The sync leaves a hold alone; a held record cannot be paid.
    await runSync(request);
    expect((await adminView(finance, row.id))!.status).toBe('ON_HOLD');
    const paidWhileHeld = await change(finance, row.id, {
      status: 'PAID',
      reason,
      paymentReference: 'UTR-HELD-1',
      expectedPayableMinor:
        row.payableMinor === 0n ? 0 : Number(row.payableMinor),
    });
    expect(paidWhileHeld.status()).toBe(409);
    expect(await errorCode(paidWhileHeld)).toBe(
      'SETTLEMENT_INVALID_TRANSITION',
    );

    // Release: back to what the rules give now (due).
    const released = await change(finance, row.id, { status: 'DUE', reason });
    expect(released.status()).toBe(200);
    expect((await released.json()).data.status).toBe('DUE');

    // Paying needs the reference and the payable finance saw.
    const payable = Number(row.payableMinor);
    const paid = { status: 'PAID', reason };
    const noRef = await change(finance, row.id, {
      ...paid,
      expectedPayableMinor: payable,
    });
    expect(noRef.status()).toBe(400);
    const noExpected = await change(finance, row.id, {
      ...paid,
      paymentReference: utr,
    });
    expect(noExpected.status()).toBe(400);
    const wrong = await change(finance, row.id, {
      ...paid,
      paymentReference: utr,
      expectedPayableMinor: payable + 1,
    });
    expect(wrong.status()).toBe(409);
    expect(await errorCode(wrong)).toBe('SETTLEMENT_CHANGED');

    const payKey = randomUUID();
    const done = await change(
      finance,
      row.id,
      { ...paid, paymentReference: utr, expectedPayableMinor: payable },
      payKey,
    );
    expect(done.status()).toBe(200);
    expect((await done.json()).data).toMatchObject({
      status: 'PAID',
      paymentReference: utr,
      payableMinor: payable,
      paidAt: expect.any(String),
    });
    const sameKey = await change(
      finance,
      row.id,
      { ...paid, paymentReference: utr, expectedPayableMinor: payable },
      payKey,
    );
    expect(sameKey.headers()['idempotent-replayed']).toBe('true');

    // Paid again: the same reference returns the record, another is refused.
    const again = await change(finance, row.id, {
      ...paid,
      paymentReference: utr,
      expectedPayableMinor: payable,
    });
    expect(again.status()).toBe(200);
    const other = await change(finance, row.id, {
      ...paid,
      paymentReference: `${utr}-2`,
      expectedPayableMinor: payable,
    });
    expect(other.status()).toBe(409);
    expect(await errorCode(other)).toBe('SETTLEMENT_ALREADY_PAID');
    // A paid record never moves again, and the sync leaves it alone.
    const holdPaid = await change(finance, row.id, {
      status: 'ON_HOLD',
      reason,
    });
    expect(holdPaid.status()).toBe(409);
    expect(await errorCode(holdPaid)).toBe('SETTLEMENT_INVALID_TRANSITION');
    await runSync(request);
    expect((await adminView(finance, row.id))!.status).toBe('PAID');

    // The super administrator may also read the list.
    const superAdmin = await staff(contexts, 'superAdmin');
    expect((await superAdmin.get('admin/settlements')).status()).toBe(200);
  });

  test('a refund on its way makes it not due; a refund after the trip lowers the payable', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await operatorWithJet(contexts);
    const booking = await completedBooking(contexts, trip);
    const row = await syncUntil(request, booking.reference);
    const finance = await staff(contexts, 'finance');
    const reason = 'Goodwill refund checked.';
    const part = Math.floor(booking.totalMinor / 20);

    // Not yet synced, but marking it paid rechecks the booking under its lock.
    // The job is paused so the record is still DUE when it is marked paid.
    const refundReference = await withSyncPaused(request, async () => {
      expect((await adminView(finance, row.id))!.status).toBe('DUE');
      const started = await finance.post(
        `admin/payments/${booking.payment.reference}/refunds`,
        {
          headers: {
            ...(await csrfHeaders(finance)),
            'Idempotency-Key': randomUUID(),
          },
          data: { amountMinor: part, currency: 'INR', reason },
        },
      );
      expect(started.status()).toBe(201);

      const notDue = await change(finance, row.id, {
        status: 'PAID',
        reason,
        paymentReference: `R-${randomUUID().slice(0, 8)}`,
        expectedPayableMinor: Number(row.payableMinor),
      });
      expect(notDue.status()).toBe(409);
      expect(await errorCode(notDue)).toBe('SETTLEMENT_NOT_DUE');
      expect((await notDue.json()).error.details).toContainEqual({
        field: 'reason',
        issue: 'A refund is on its way.',
      });
      return (await started.json()).data.reference as string;
    });

    // The sync marks it NOT_DUE with the reason.
    await syncUntil(request, booking.reference, (r) => r.status === 'NOT_DUE');
    const waiting = await adminView(finance, row.id);
    expect(waiting).toMatchObject({
      status: 'NOT_DUE',
      notDueReason: 'A refund is on its way.',
    });

    // Finance on a stale Due screen marks the NOT_DUE record paid: told why.
    const stalePaid = await change(finance, row.id, {
      status: 'PAID',
      reason,
      paymentReference: `R-${randomUUID().slice(0, 8)}`,
      expectedPayableMinor: Number(row.payableMinor),
    });
    expect(stalePaid.status()).toBe(409);
    expect(await errorCode(stalePaid)).toBe('SETTLEMENT_NOT_DUE');
    expect((await stalePaid.json()).error.details).toContainEqual({
      field: 'reason',
      issue: 'A refund is on its way.',
    });
    expect((await adminView(finance, row.id))!.status).toBe('NOT_DUE');

    // The refund completes: due again, with the refund out of the payable.
    const { providerRefundId } = await withPrisma((prisma) =>
      prisma.refund.findUniqueOrThrow({
        where: { reference: refundReference },
      }),
    );
    const simulated = await request.post(
      `dev/payments/refunds/${providerRefundId}/simulate`,
      { headers: await csrfHeaders(request), data: { outcome: 'processed' } },
    );
    expect(simulated.status()).toBe(200);
    expect(
      (
        await deliver(request, (await simulated.json()).data as Signed)
      ).status(),
    ).toBe(200);
    await syncUntil(request, booking.reference, (r) => r.status === 'DUE');
    const after = await adminView(finance, row.id);
    expect(after).toMatchObject({
      status: 'DUE',
      keptMinor: booking.totalMinor - part,
      payableMinor: Number(row.payableMinor) - part,
    });
    expect(after!.commissionMinor + after!.taxMinor + after!.payableMinor).toBe(
      booking.totalMinor - part,
    );
    // The operator's administrator (`request`) is told once, without figures.
    const told = (
      (await (await request.get('me/notifications?pageSize=100')).json())
        .data as { templateKey: string; body: string; href: string }[]
    ).filter(
      (n) =>
        n.templateKey === 'settlement.updated' &&
        n.body.includes(booking.reference),
    );
    expect(told).toEqual([
      expect.objectContaining({ href: '/operator/settlements' }),
    ]);
    expect(told[0].body).not.toContain(String(after!.payableMinor));

    // The payable finance saw before the refund is now wrong.
    const stale = await change(finance, row.id, {
      status: 'PAID',
      reason,
      paymentReference: `R-${randomUUID().slice(0, 8)}`,
      expectedPayableMinor: Number(row.payableMinor),
    });
    expect(stale.status()).toBe(409);
    expect(await errorCode(stale)).toBe('SETTLEMENT_CHANGED');
  });
});

test.describe('settlements by role and operator', () => {
  test('an operator administrator sees only its own settlements, with commission and tax; staff are refused', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contextsA = { request, playwright, baseURL };
    const tripA = await operatorWithJet(contextsA);
    const bookingA = await completedBooking(contextsA, tripA);
    const rowA = await syncUntil(request, bookingA.reference);

    const operatorB = await newContext(contextsA);
    const contextsB = { request: operatorB, playwright, baseURL };
    const tripB = await operatorWithJet(contextsB);
    const bookingB = await completedBooking(contextsB, tripB);
    const rowB = await syncUntil(operatorB, bookingB.reference);

    const mine = await request.get('operator/settlements');
    expect(mine.status()).toBe(200);
    const items = (await mine.json()).data as Settlement[];
    expect(items.map((s) => s.bookingReference)).toEqual([bookingA.reference]);
    expect(items[0]).toMatchObject({
      id: rowA.id,
      status: 'DUE',
      keptMinor: bookingA.totalMinor,
      currency: 'INR',
    });
    expect(items[0].commissionMinor).toBeGreaterThan(0);
    expect(
      items[0].commissionMinor + items[0].taxMinor + items[0].payableMinor,
    ).toBe(bookingA.totalMinor);
    expect(items[0]).not.toHaveProperty('operatorId');

    const theirs = (await (await operatorB.get('operator/settlements')).json())
      .data as Settlement[];
    expect(theirs.map((s) => s.id)).toEqual([rowB.id]);

    // Staff and customers are refused on the operator route.
    for (const account of ['finance', 'ops'] as const) {
      const context = await staff(contextsA, account);
      expect((await context.get('operator/settlements')).status()).toBe(403);
    }
    expect((await bookingA.customer.get('operator/settlements')).status()).toBe(
      403,
    );
    // Operators are refused on finance's routes.
    expect((await request.get('admin/settlements')).status()).toBe(403);
    expect((await request.get('admin/reconciliation')).status()).toBe(403);
    // And a signed-out caller is refused.
    const visitor = await newContext(contextsA);
    expect((await visitor.get('operator/settlements')).status()).toBe(401);
  });

  test('operations are refused the list, and see the audit trail of a settlement redacted', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await operatorWithJet(contexts);
    const booking = await completedBooking(contexts, trip);
    const row = await syncUntil(request, booking.reference);
    const finance = await staff(contexts, 'finance');
    const ops = await staff(contexts, 'ops');
    const reason = 'Held for a bank check.';
    expect(
      (await change(finance, row.id, { status: 'ON_HOLD', reason })).status(),
    ).toBe(200);

    expect((await ops.get('admin/settlements')).status()).toBe(403);

    const audit = async (who: APIRequestContext) => {
      const response = await who.get(
        `admin/audit-logs?entityType=Settlement&entityId=${row.id}&pageSize=50`,
      );
      expect(response.status()).toBe(200);
      return (await response.json()).data as {
        action: string;
        before: unknown;
        after: unknown;
        reason: string | null;
        restricted: boolean;
      }[];
    };

    const forOps = await audit(ops);
    expect(forOps.map((a) => a.action)).toEqual(
      expect.arrayContaining(['settlement.create', 'settlement.status']),
    );
    for (const entry of forOps) {
      expect(entry).toMatchObject({
        restricted: true,
        before: null,
        after: null,
        reason: null,
      });
    }

    const forFinance = await audit(finance);
    const status = forFinance.find((a) => a.action === 'settlement.status')!;
    expect(status.restricted).toBe(false);
    expect(status.reason).toBe(reason);
    expect(status.after).toMatchObject({
      bookingReference: booking.reference,
      status: 'ON_HOLD',
    });
    expect(status.before).toMatchObject({ status: 'DUE' });
  });

  test('a payout reference may repeat for the same operator but not across operators (case-insensitive)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contextsA = { request, playwright, baseURL };
    const tripA = await operatorWithJet(contextsA);
    const first = await completedBooking(contextsA, tripA);
    const rowFirst = await syncUntil(request, first.reference);

    const operatorB = await newContext(contextsA);
    const contextsB = { request: operatorB, playwright, baseURL };
    const tripB = await operatorWithJet(contextsB);
    const other = await completedBooking(contextsB, tripB);
    const rowOther = await syncUntil(operatorB, other.reference);

    const finance = await staff(contextsA, 'finance');
    const reference = `BATCH-${randomUUID().slice(0, 8)}`;
    const pay = (id: string, payable: bigint, ref: string) =>
      change(finance, id, {
        status: 'PAID',
        reason: 'Batched transfer.',
        paymentReference: ref,
        expectedPayableMinor: Number(payable),
      });

    expect(
      (await pay(rowFirst.id, rowFirst.payableMinor, reference)).status(),
    ).toBe(200);

    // Another operator cannot reuse it, even in another case.
    const refused = await pay(
      rowOther.id,
      rowOther.payableMinor,
      reference.toLowerCase(),
    );
    expect(refused.status()).toBe(409);
    expect(await errorCode(refused)).toBe('SETTLEMENT_REFERENCE_USED');
    expect((await adminView(finance, rowOther.id))!.status).toBe('DUE');

    // The same operator's second booking may share the transfer.
    const second = await completedBooking(
      contextsA,
      await anotherJet(request, tripA),
    );
    const rowSecond = await syncUntil(request, second.reference);
    const shared = await pay(rowSecond.id, rowSecond.payableMinor, reference);
    expect(shared.status()).toBe(200);
    expect((await shared.json()).data).toMatchObject({
      status: 'PAID',
      paymentReference: reference,
    });
  });
});

const PERIOD = () => ({
  from: new Date(Date.now() - 3_600_000).toISOString(),
  to: new Date(Date.now() + 3_600_000).toISOString(),
});

/** A second capture of the paid order, under another gateway payment id. */
async function duplicateCapture(
  request: APIRequestContext,
  paymentReference: string,
  amountMinor: number,
) {
  const { providerOrderId } = await withPrisma((prisma) =>
    prisma.payment.findUniqueOrThrow({
      where: { reference: paymentReference },
    }),
  );
  const body = `{ "entity": "event", "event": "payment.captured",
  "payload": { "payment": { "entity": {
    "id": "pay_dup_${randomUUID()}", "order_id": "${providerOrderId}",
    "amount": ${amountMinor}, "currency": "INR", "status": "captured" } } } }`;
  const response = await request.post('webhooks/payments/mock', {
    data: body,
    headers: {
      'Content-Type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: hmacSha256Hex(MOCK_PAYMENT_WEBHOOK_SECRET, body),
      [MOCK_EVENT_ID_HEADER]: `evt_dup_${randomUUID()}`,
    },
  });
  expect(response.status()).toBe(200);
}

async function flaggedMismatch(
  finance: APIRequestContext,
  paymentReference: string,
) {
  const period = PERIOD();
  const response = await finance.get('admin/reconciliation', {
    params: period,
  });
  expect(response.status()).toBe(200);
  const report = (await response.json()).data as {
    mismatches: { kind: string; paymentReference: string | null }[];
  };
  return report.mismatches.find(
    (m) =>
      m.kind === 'PAYMENT_FLAGGED' && m.paymentReference === paymentReference,
  );
}

test.describe('GET /admin/reconciliation', () => {
  test('finance reads a period of at most 92 days; longer, backwards, operations and operators are refused', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const finance = await staff(contexts, 'finance');
    const ops = await staff(contexts, 'ops');
    const day = 86_400_000;
    const to = new Date();

    const ok = await finance.get('admin/reconciliation', {
      params: {
        from: new Date(+to - 92 * day).toISOString(),
        to: to.toISOString(),
      },
    });
    expect(ok.status()).toBe(200);
    expect((await ok.json()).data).toMatchObject({
      totals: expect.any(Array),
      mismatches: expect.any(Array),
      mismatchTotal: expect.any(Number),
    });

    const tooLong = await finance.get('admin/reconciliation', {
      params: {
        from: new Date(+to - 93 * day).toISOString(),
        to: to.toISOString(),
      },
    });
    expect(tooLong.status()).toBe(400);
    expect((await tooLong.json()).error.code).toBe('VALIDATION_ERROR');

    const backwards = await finance.get('admin/reconciliation', {
      params: { from: to.toISOString(), to: new Date(+to - day).toISOString() },
    });
    expect(backwards.status()).toBe(400);

    expect(
      (await ops.get('admin/reconciliation', { params: PERIOD() })).status(),
    ).toBe(403);
    expect(
      (
        await request.get('admin/reconciliation', { params: PERIOD() })
      ).status(),
    ).toBe(401);
  });

  test('a duplicate capture is a mismatch until finance resolves it; a new flag reopens it (D-210)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await operatorWithJet(contexts);
    const booking = await bookingOn(contexts, trip);
    const payment = await payInFull(
      request,
      booking.customer,
      booking.reference,
      booking.totalMinor,
    );
    const finance = await staff(contexts, 'finance');
    const ops = await staff(contexts, 'ops');

    await duplicateCapture(request, payment.reference, booking.totalMinor);
    const flagged = await withPrisma((prisma) =>
      prisma.payment.findUniqueOrThrow({
        where: { reference: payment.reference },
      }),
    );
    expect(flagged.reviewReason).toBe('DUPLICATE_CAPTURE');
    expect(flagged.reviewResolvedAt).toBeNull();
    expect(await flaggedMismatch(finance, payment.reference)).toMatchObject({
      bookingReference: booking.reference,
      amountMinor: booking.totalMinor,
    });

    // Resolving needs finance, a reason and an open flag.
    const resolve = async (who: APIRequestContext, data: object) =>
      who.post(`admin/payments/${payment.reference}/resolve-flag`, {
        headers: await csrfHeaders(who),
        data,
      });
    const reason = 'Second capture refunded at the gateway dashboard.';
    expect((await resolve(ops, { reason })).status()).toBe(403);
    expect((await resolve(booking.customer, { reason })).status()).toBe(403);
    const noReason = await resolve(finance, {});
    expect(noReason.status()).toBe(400);
    expect((await noReason.json()).error.code).toBe('VALIDATION_ERROR');
    expect((await resolve(finance, { reason: 'x' })).status()).toBe(400);
    expect(await flaggedMismatch(finance, payment.reference)).toBeDefined();

    const done = await resolve(finance, { reason });
    expect(done.status()).toBe(200);
    expect((await done.json()).data).toMatchObject({
      reference: payment.reference,
      reviewReason: 'DUPLICATE_CAPTURE',
    });
    expect(await flaggedMismatch(finance, payment.reference)).toBeUndefined();
    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: flagged.id, action: 'payment.flag_resolve' },
      }),
    );
    expect(audit.reason).toBe(reason);

    const twice = await resolve(finance, { reason });
    expect(twice.status()).toBe(409);
    expect((await twice.json()).error.code).toBe('PAYMENT_FLAG_NOT_OPEN');
    expect(
      (
        await finance.post('admin/payments/FLY-PY-ZZZZZZ/resolve-flag', {
          headers: await csrfHeaders(finance),
          data: { reason },
        })
      ).status(),
    ).toBe(404);

    // Another capture, under a new gateway payment id, reopens the flag.
    await duplicateCapture(request, payment.reference, booking.totalMinor);
    expect(await flaggedMismatch(finance, payment.reference)).toBeDefined();
    const reopened = await withPrisma((prisma) =>
      prisma.payment.findUniqueOrThrow({
        where: { reference: payment.reference },
      }),
    );
    expect(reopened.reviewResolvedAt).toBeNull();
    expect((await resolve(finance, { reason })).status()).toBe(200);
    expect(await flaggedMismatch(finance, payment.reference)).toBeUndefined();
  });

  test('a payment with no flag cannot be resolved', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const trip = await operatorWithJet(contexts);
    const booking = await bookingOn(contexts, trip);
    const payment = await payInFull(
      request,
      booking.customer,
      booking.reference,
      booking.totalMinor,
    );
    const finance = await staff(contexts, 'finance');
    const response = await finance.post(
      `admin/payments/${payment.reference}/resolve-flag`,
      {
        headers: await csrfHeaders(finance),
        data: { reason: 'Nothing to resolve.' },
      },
    );
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('PAYMENT_FLAG_NOT_OPEN');
  });
});
