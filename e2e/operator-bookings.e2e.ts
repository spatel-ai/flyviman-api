import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { APIRequestContext, expect, test } from '@playwright/test';
import { FieldCipher } from '../src/common/crypto/field-cipher.js';
import {
  latestLinkToken,
  outbox,
  PASSWORD,
  registerCustomer,
  uniqueEmail,
} from './support/data.js';
import { withPrisma } from './support/db.js';
import { aircraftBody } from './support/fleet.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * The operator's bookings (M8-B, D-194, D-199, D-200, D-183): the list and
 * its scope, the manifest (names only), staff capabilities, the status
 * moves, and the operator's cancellation that records the refund due and
 * moves no money. Payments are made through the mock checkout, as in
 * `e2e/refunds.e2e.ts` (the two small helpers below are copied from it).
 */

type Contexts = Parameters<typeof listedJet>[0];
type Signed = { body: string; headers: Record<string, string> };

const OPERATIONS_INBOX =
  process.env.OPERATIONS_INBOX_EMAIL ?? 'operations@flyviman.test';

function newContext(contexts: Contexts) {
  return contexts.playwright.request.newContext({ baseURL: contexts.baseURL });
}

async function staffAccount(contexts: Contexts, account: 'finance' | 'ops') {
  const context = await newContext(contexts);
  await signIn(context, account);
  return context;
}

/** A customer's booking on a fresh priced jet, set to `status`. */
async function booking(
  contexts: Contexts,
  status: 'CONFIRMED' | 'AWAITING_PAYMENT' = 'CONFIRMED',
) {
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
  const searched = await searchFor(request, trip);
  const customer = await newContext(contexts);
  const { email } = await registerCustomer(customer);
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
  const reference = (await created.json()).data.reference as string;
  await withPrisma((prisma) =>
    prisma.booking.update({
      where: { reference },
      data: {
        status,
        priceType: 'CONFIRMED',
        operatorAcceptedAt: new Date(),
        paymentModel: 'B_OPERATOR_CONFIRMED',
        ...(status === 'CONFIRMED' ? { confirmedAt: new Date() } : {}),
      },
    }),
  );
  return {
    customer,
    email,
    reference,
    trip,
    totalMinor: searched.result.price.amountMinor as number,
  };
}

/** Orders what is due, pays it in the mock checkout and delivers the notice. */
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
  const delivered = await request.post('webhooks/payments/mock', {
    data: webhook.body,
    headers: webhook.headers,
  });
  expect(delivered.status()).toBe(200);
  return payment;
}

/** Invites staff to the operator on `admin`, accepts the link, signs in. */
async function staffMember(
  admin: APIRequestContext,
  contexts: Contexts,
  capabilities: string[],
  aircraftIds: string[],
) {
  const email = uniqueEmail('staff');
  const invited = await admin.post('operator/staff', {
    headers: await csrfHeaders(admin),
    data: { email, allAircraft: false, aircraftIds, capabilities },
  });
  expect(invited.status()).toBe(201);
  const staff = await newContext(contexts);
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

function patchStatus(
  who: APIRequestContext,
  reference: string,
  status: string,
) {
  return who
    .get('health') // keeps the cookie jar warm for the CSRF header
    .then(async () =>
      who.patch(`operator/bookings/${reference}/status`, {
        headers: await csrfHeaders(who),
        data: { status },
      }),
    );
}

async function cancel(
  who: APIRequestContext,
  reference: string,
  data: unknown,
  key: string = randomUUID(),
) {
  return who.post(`operator/bookings/${reference}/cancel`, {
    headers: { ...(await csrfHeaders(who)), 'Idempotency-Key': key },
    data,
  });
}

/** Sends what is queued now rather than waiting for the dispatcher. */
async function dispatch(request: APIRequestContext) {
  const response = await request.post('dev/jobs/notification-outbox', {
    headers: await csrfHeaders(request),
  });
  expect(response.status()).toBe(200);
}

function storedBooking(reference: string) {
  return withPrisma((prisma) =>
    prisma.booking.findUniqueOrThrow({
      where: { reference },
      include: { events: { orderBy: { createdAt: 'asc' } } },
    }),
  );
}

function setStatus(reference: string, status: 'COMPLETED' | 'SCHEDULED') {
  return withPrisma((prisma) =>
    prisma.booking.update({ where: { reference }, data: { status } }),
  );
}

test.describe('GET /operator/bookings', () => {
  test('lists upcoming trips of the caller’s operator only, with filters', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, trip, customer } = await booking(contexts);

    const listed = await request.get('operator/bookings');
    expect(listed.status()).toBe(200);
    const body = await listed.json();
    expect(body.meta).toMatchObject({ page: 1, total: 1 });
    expect(body.data[0]).toMatchObject({
      reference,
      status: 'CONFIRMED',
      paymentStatus: 'UNPAID',
      price: { priceType: 'CONFIRMED', currency: 'INR' },
      aircraft: { id: trip.aircraftId },
    });
    // The list carries no passenger data at all.
    expect(body.data[0]).not.toHaveProperty('passengers');

    // Default view is CONFIRMED and SCHEDULED; other statuses need a filter.
    await setStatus(reference, 'SCHEDULED');
    expect(
      (await (await request.get('operator/bookings')).json()).meta.total,
    ).toBe(1);
    await setStatus(reference, 'COMPLETED');
    expect(
      (await (await request.get('operator/bookings')).json()).meta.total,
    ).toBe(0);
    const completed = await request.get('operator/bookings', {
      params: { status: 'COMPLETED' },
    });
    expect((await completed.json()).meta.total).toBe(1);
    const confirmed = await request.get('operator/bookings', {
      params: { status: 'CONFIRMED' },
    });
    expect((await confirmed.json()).meta.total).toBe(0);

    // Aircraft and departure date filters.
    const aircraft = await request.get('operator/bookings', {
      params: { status: 'COMPLETED', aircraftId: trip.aircraftId },
    });
    expect((await aircraft.json()).meta.total).toBe(1);
    const elsewhere = await request.get('operator/bookings', {
      params: { status: 'COMPLETED', aircraftId: randomUUID() },
    });
    expect((await elsewhere.json()).meta.total).toBe(0);
    const departure = (
      await (await request.get(`operator/bookings/${reference}`)).json()
    ).data.legs[0].departureAt as string;
    const at = Date.parse(departure);
    const window = async (from: number, to: number) =>
      (
        await (
          await request.get('operator/bookings', {
            params: {
              status: 'COMPLETED',
              departureFrom: new Date(from).toISOString(),
              departureTo: new Date(to).toISOString(),
            },
          })
        ).json()
      ).meta.total as number;
    expect(await window(at - 3_600_000, at + 3_600_000)).toBe(1);
    expect(await window(at + 3_600_000, at + 7_200_000)).toBe(0);
    expect(await window(at - 7_200_000, at)).toBe(0); // the end is exclusive
    for (const params of [
      { status: 'NOPE' } as Record<string, string>,
      { departureFrom: 'yesterday' },
      { aircraftId: 'x' },
    ]) {
      expect(
        (await request.get('operator/bookings', { params })).status(),
      ).toBe(400);
    }

    // Another approved operator sees none of it, in the list or by reference.
    const other = await newContext(contexts);
    await listedJet({ request: other, playwright, baseURL });
    const none = await other.get('operator/bookings', {
      params: { status: 'COMPLETED' },
    });
    expect(none.status()).toBe(200);
    expect((await none.json()).meta.total).toBe(0);
    expect((await other.get(`operator/bookings/${reference}`)).status()).toBe(
      404,
    );

    // Customers and visitors are refused.
    expect((await customer.get('operator/bookings')).status()).toBe(403);
    const visitor = await newContext(contexts);
    expect((await visitor.get('operator/bookings')).status()).toBe(401);
  });

  test('a suspended operator sees nothing', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { reference, trip } = await booking({ request, playwright, baseURL });
    await withPrisma(async (prisma) => {
      const { operatorId } = await prisma.aircraft.findUniqueOrThrow({
        where: { id: trip.aircraftId },
        select: { operatorId: true },
      });
      await prisma.operator.update({
        where: { id: operatorId },
        data: { status: 'SUSPENDED' },
      });
    });
    for (const path of [
      'operator/bookings',
      `operator/bookings/${reference}`,
    ]) {
      const response = await request.get(path);
      expect(response.status()).toBe(409);
      expect((await response.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
    }
    const moved = await patchStatus(request, reference, 'SCHEDULED');
    expect(moved.status()).toBe(409);
    expect((await moved.json()).error.code).toBe('OPERATOR_NOT_APPROVED');
    expect((await storedBooking(reference)).status).toBe('CONFIRMED');
  });
});

test.describe('GET /operator/bookings/:reference', () => {
  test('the manifest is first and last names, and only while the operator flies the trip', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { reference } = await booking({ request, playwright, baseURL });
    await withPrisma(async (prisma) => {
      const row = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      await prisma.bookingPassenger.create({
        data: {
          bookingId: row.id,
          firstName: 'Asha',
          lastName: 'Verma',
          dateOfBirth: new Date('1985-03-14'),
          nationality: 'IN',
          documentType: 'PASSPORT',
          documentNumber: 'ZZ9988776',
          documentExpiry: new Date('2032-01-01'),
          specialAssistance: 'Oxygen on board',
        },
      });
    });
    const shown = await request.get(`operator/bookings/${reference}`);
    expect(shown.status()).toBe(200);
    const text = await shown.text();
    const data = JSON.parse(text).data;
    expect(data.passengers).toEqual([{ firstName: 'Asha', lastName: 'Verma' }]);
    expect(data.actions).toEqual({
      schedule: true,
      complete: false,
      cancel: true,
    });
    for (const secret of [
      'ZZ9988776',
      'Oxygen',
      '1985',
      'dateOfBirth',
      'documentNumber',
      'specialAssistance',
      'PASSPORT',
    ]) {
      expect(text).not.toContain(secret);
    }

    // Shown while scheduled and completed, hidden before the trip is flown.
    for (const status of ['SCHEDULED', 'COMPLETED'] as const) {
      await setStatus(reference, status);
      const later = (
        await (await request.get(`operator/bookings/${reference}`)).json()
      ).data;
      expect(later.passengers).toHaveLength(1);
    }
    await withPrisma((prisma) =>
      prisma.booking.update({
        where: { reference },
        data: { status: 'AWAITING_PAYMENT' },
      }),
    );
    const before = (
      await (await request.get(`operator/bookings/${reference}`)).json()
    ).data;
    expect(before.passengers).toBeNull();
    expect(
      (await request.get('operator/bookings/FLY-BK-000000')).status(),
    ).toBe(404);
  });
});

test.describe('operator staff on bookings', () => {
  test('staff act with MANAGE_BOOKINGS on the aircraft, not without it or on another aircraft', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { reference, trip } = await booking(contexts);
    const second = await request.post('operator/aircraft', {
      headers: await csrfHeaders(request),
      data: aircraftBody(trip.mumbai),
    });
    expect(second.status()).toBe(201);
    const secondId = (await second.json()).data.id as string;

    const allowed = await staffMember(
      request,
      contexts,
      ['MANAGE_BOOKINGS'],
      [trip.aircraftId],
    );
    const without = await staffMember(
      request,
      contexts,
      ['MANAGE_AVAILABILITY'],
      [trip.aircraftId],
    );
    const elsewhere = await staffMember(
      request,
      contexts,
      ['MANAGE_BOOKINGS'],
      [secondId],
    );

    // Without the capability: refused outright (403).
    expect((await without.get('operator/bookings')).status()).toBe(403);
    expect((await without.get(`operator/bookings/${reference}`)).status()).toBe(
      403,
    );
    expect((await patchStatus(without, reference, 'SCHEDULED')).status()).toBe(
      403,
    );
    expect(
      (await cancel(without, reference, { reason: 'No crew' })).status(),
    ).toBe(403);

    // On another aircraft: the booking does not exist for them (404).
    expect(
      (await (await elsewhere.get('operator/bookings')).json()).meta.total,
    ).toBe(0);
    expect(
      (await elsewhere.get(`operator/bookings/${reference}`)).status(),
    ).toBe(404);
    expect(
      (await patchStatus(elsewhere, reference, 'SCHEDULED')).status(),
    ).toBe(404);
    expect(
      (await cancel(elsewhere, reference, { reason: 'No crew' })).status(),
    ).toBe(404);
    expect((await storedBooking(reference)).status).toBe('CONFIRMED');

    // With it: read and act.
    expect(
      (await (await allowed.get('operator/bookings')).json()).meta.total,
    ).toBe(1);
    expect((await allowed.get(`operator/bookings/${reference}`)).status()).toBe(
      200,
    );
    const moved = await patchStatus(allowed, reference, 'SCHEDULED');
    expect(moved.status()).toBe(200);
    expect((await moved.json()).data.status).toBe('SCHEDULED');
  });
});

test.describe('PATCH /operator/bookings/:reference/status', () => {
  test('confirmed becomes scheduled as the operator; completing before the last leg departs is refused', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { reference, email } = await booking({
      request,
      playwright,
      baseURL,
    });

    // Not a move the operator may make from CONFIRMED, or at all.
    const early = await patchStatus(request, reference, 'COMPLETED');
    expect(early.status()).toBe(409);
    expect((await early.json()).error.code).toBe('BOOKING_INVALID_TRANSITION');
    for (const status of ['CANCELLED', 'CONFIRMED', 'NOPE']) {
      expect((await patchStatus(request, reference, status)).status()).toBe(
        400,
      );
    }
    expect((await storedBooking(reference)).status).toBe('CONFIRMED');

    const scheduled = await patchStatus(request, reference, 'SCHEDULED');
    expect(scheduled.status()).toBe(200);
    expect((await scheduled.json()).data).toMatchObject({
      reference,
      status: 'SCHEDULED',
      actions: { schedule: false, complete: false, cancel: true },
    });

    // The trip departs days from now: completing is refused, and so is a repeat.
    const tooSoon = await patchStatus(request, reference, 'COMPLETED');
    expect(tooSoon.status()).toBe(409);
    expect((await tooSoon.json()).error.code).toBe(
      'BOOKING_INVALID_TRANSITION',
    );
    const again = await patchStatus(request, reference, 'SCHEDULED');
    expect(again.status()).toBe(409);
    expect((await again.json()).error.code).toBe('BOOKING_INVALID_TRANSITION');

    // Audited and on the timeline as the operator, not as an override.
    const row = await storedBooking(reference);
    expect(row.status).toBe('SCHEDULED');
    const operatorId = row.events.find(
      (event) => event.toStatus === 'SCHEDULED',
    )?.actorId;
    expect(operatorId).toBeTruthy();
    const event = row.events.find((entry) => entry.toStatus === 'SCHEDULED');
    expect(event).toMatchObject({
      fromStatus: 'CONFIRMED',
      actorRole: 'OPERATOR_ADMIN',
    });
    expect(JSON.stringify(event?.payload ?? {})).not.toContain('override');
    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: row.id, action: 'booking.status' },
        orderBy: { createdAt: 'asc' },
      }),
    );
    const audit = audits.find((entry) =>
      JSON.stringify(entry.after).includes('SCHEDULED'),
    );
    expect(audit).toMatchObject({
      actorId: operatorId,
      actorRole: 'OPERATOR_ADMIN',
    });
    expect(JSON.stringify(audit?.before)).toContain('CONFIRMED');

    // The customer is told.
    await expect
      .poll(async () => {
        await dispatch(request);
        return (await outbox(request, email)).some(
          (message) =>
            message.subject?.includes(reference) &&
            message.subject.includes('scheduled'),
        );
      })
      .toBe(true);
  });
});

test.describe('POST /operator/bookings/:reference/cancel', () => {
  test('needs a reason; cancels once, waives the charge and lists everything paid as due back without refunding', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, email, reference, totalMinor } = await booking(
      contexts,
      'AWAITING_PAYMENT',
    );
    const payment = await payInFull(request, customer, reference, totalMinor);
    const afterPayment = await storedBooking(reference);
    // Payment and booking status are separate (rule 2): make it confirmed
    // the way operations would if the payment alone has not.
    if (afterPayment.status !== 'CONFIRMED') {
      const ops = await staffAccount(contexts, 'ops');
      const confirmed = await ops.patch(`admin/bookings/${reference}/status`, {
        headers: await csrfHeaders(ops),
        data: { status: 'CONFIRMED', reason: 'Confirmed for the e2e test' },
      });
      expect(confirmed.status()).toBe(200);
    }
    expect(await storedBooking(reference)).toMatchObject({
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    });
    // A traveller and a special request, which the answer must not repeat.
    // Stored encrypted, as the API stores them.
    const cipher = new FieldCipher({
      getOrThrow: () => process.env.DATA_ENCRYPTION_KEY,
    } as unknown as ConfigService);
    await withPrisma(async (prisma) => {
      const row = await prisma.booking.update({
        where: { reference },
        data: {
          specialRequests: cipher.encrypt('Wheelchair at the steps for Meera'),
        },
      });
      await prisma.bookingPassenger.create({
        data: {
          bookingId: row.id,
          firstName: 'Meera',
          lastName: 'Kapoor',
          dateOfBirth: new Date('1980-06-01'),
          nationality: 'IN',
          documentType: 'PASSPORT',
          documentNumber: cipher.encrypt('ZZ1122334'),
          documentExpiry: new Date('2032-01-01'),
        },
      });
    });

    // The reason is required, 3 to 500 characters of plain text.
    for (const data of [
      {},
      { reason: '' },
      { reason: 'ab' },
      { reason: 'x'.repeat(501) },
    ]) {
      const bad = await cancel(request, reference, data);
      expect(bad.status()).toBe(400);
      expect((await bad.json()).error.details).toContainEqual(
        expect.objectContaining({ field: 'reason' }),
      );
    }
    const keyless = await request.post(
      `operator/bookings/${reference}/cancel`,
      {
        headers: await csrfHeaders(request),
        data: { reason: 'Aircraft grounded' },
      },
    );
    expect(keyless.status()).toBe(400);
    expect((await storedBooking(reference)).status).toBe('CONFIRMED');

    // Another operator cannot cancel it.
    const other = await newContext(contexts);
    await listedJet({ request: other, playwright, baseURL });
    expect(
      (await cancel(other, reference, { reason: 'Not mine' })).status(),
    ).toBe(404);

    const reason = 'Aircraft grounded for an engine inspection';
    const key = randomUUID();
    const first = await cancel(request, reference, { reason }, key);
    expect(first.status()).toBe(200);
    // References, statuses and times only: the answer is kept for replay (D-128).
    const answer = (await first.json()).data;
    expect(answer).toEqual({
      reference,
      status: 'CANCELLED',
      paymentStatus: 'PAID',
      cancelledAt: expect.any(String),
      updatedAt: expect.any(String),
    });
    const replay = await cancel(request, reference, { reason }, key);
    expect(replay.status()).toBe(200);
    expect(replay.headers()['idempotent-replayed']).toBe('true');
    expect((await replay.json()).data).toEqual(answer);
    // The stored answer holds no passenger name and no special request.
    const kept = await withPrisma((prisma) =>
      prisma.idempotencyKey.findMany({ where: { key } }),
    );
    expect(kept).toHaveLength(1);
    expect(kept[0].responseBody).toEqual(answer);
    for (const text of ['Meera', 'Kapoor', 'Wheelchair'])
      expect(JSON.stringify(kept[0].responseBody)).not.toContain(text);
    // The detail is read again for the screen.
    expect(
      (await (await request.get(`operator/bookings/${reference}`)).json()).data,
    ).toMatchObject({ status: 'CANCELLED', actions: { cancel: false } });
    // A new key on a cancelled booking is refused.
    const second = await cancel(request, reference, { reason });
    expect(second.status()).toBe(409);
    expect((await second.json()).error.code).toBe('BOOKING_NOT_CANCELLABLE');

    // No charge: all of what was paid is due back. Nothing is refunded here (D-183).
    const row = await storedBooking(reference);
    const cancellations = row.events.filter(
      (event) => event.toStatus === 'CANCELLED',
    );
    expect(cancellations).toHaveLength(1);
    expect(cancellations[0]).toMatchObject({ actorRole: 'OPERATOR_ADMIN' });
    const finance = await staffAccount(contexts, 'finance');
    const due = await finance.get('admin/refunds/due?pageSize=100');
    expect(due.status()).toBe(200);
    const items = (await due.json()).data as {
      kind: string;
      paymentReference: string;
      bookingReference: string;
      dueMinor: number;
    }[];
    expect(
      items.filter((item) => item.paymentReference === payment.reference),
    ).toEqual([
      expect.objectContaining({
        kind: 'CANCELLATION',
        bookingReference: reference,
        dueMinor: totalMinor,
      }),
    ]);
    const refunds = await withPrisma((prisma) =>
      prisma.refund.findMany({
        where: { payment: { reference: payment.reference } },
      }),
    );
    expect(refunds).toHaveLength(0);

    // The customer sees a waived charge, and never the operator's reason.
    const seen = await customer.get(`bookings/${reference}`);
    const seenBody = await seen.text();
    expect(JSON.parse(seenBody).data.status).toBe('CANCELLED');
    // The recorded cancellation waives the charge and owes all that was paid.
    const completed = await withPrisma((prisma) =>
      prisma.changeRequest.findMany({
        where: { booking: { reference } },
      }),
    );
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({
      chargeMinor: 0n,
      refundMinor: BigInt(totalMinor),
    });
    expect(seenBody).not.toContain('engine inspection');
    const events = await (
      await customer.get(`bookings/${reference}/events`)
    ).text();
    expect(events).not.toContain('engine inspection');
    // Stored encrypted, and audited as the operator with before and after.
    expect(JSON.stringify(row.events)).not.toContain('engine inspection');
    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: row.id, action: 'booking.status' },
      }),
    );
    const audit = audits.find((entry) =>
      JSON.stringify(entry.after).includes('CANCELLED'),
    );
    expect(audit).toMatchObject({ actorRole: 'OPERATOR_ADMIN' });
    expect(JSON.stringify(audit?.before)).toContain('CONFIRMED');
    expect(JSON.stringify(audit?.before)).not.toContain('engine inspection');

    // The customer and operations are told.
    await expect
      .poll(async () => {
        await dispatch(request);
        return (await outbox(request, email)).some(
          (message) =>
            message.subject?.includes(reference) &&
            message.subject.includes('cancelled by the operator'),
        );
      })
      .toBe(true);
    await expect
      .poll(async () => {
        await dispatch(request);
        return (await outbox(request, OPERATIONS_INBOX)).some(
          (message) =>
            message.subject?.includes(reference) &&
            message.subject.includes('Operator cancelled'),
        );
      })
      .toBe(true);
  });
});
