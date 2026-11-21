import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import {
  MOCK_EVENT_ID_HEADER,
  MOCK_PAYMENT_KEY_SECRET,
} from '../src/integrations/payment/mock-payment-gateway.provider.js';
import { hmacSha256Hex } from '../src/integrations/payment/payment-signature.js';
import { STORED_EVENT_FIELDS } from '../src/modules/payments/payment-rules.js';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import {
  bookingAwaitingPayment,
  bookingOf,
  type Contexts,
  created,
  deliver,
  notice,
  pay,
  paymentRow,
  setBooking,
} from './support/payments.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Payments on the mock gateway (M9, W3-4): orders, the checkout result and
 * the gateway's signed notices. The gateway's own checkout cannot be driven
 * from here, so the test signs the checkout result and the notices itself
 * with the development secrets the test server runs with.
 */

/** Runs the sweep, waiting out a run another test holds the lock for. */
async function runSweep(request: APIRequestContext) {
  await expect
    .poll(async () => {
      const response = await request.post('dev/jobs/payment-sweep', {
        headers: await csrfHeaders(request),
      });
      expect(response.status()).toBe(200);
      return (await response.json()).data.skipped as boolean;
    })
    .toBe(false);
}

function setOrderId(reference: string, providerOrderId: string) {
  return withPrisma((prisma) =>
    prisma.payment.update({ where: { reference }, data: { providerOrderId } }),
  );
}

/** The finance refunds-due rows for a payment, read through every page. */
async function refundsDueFor(
  contexts: Contexts,
  paymentReference: string,
): Promise<Record<string, unknown>[]> {
  const finance = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await signIn(finance, 'finance');
  const rows: Record<string, unknown>[] = [];
  for (let page = 1; ; page += 1) {
    const response = await finance.get(
      `admin/refunds/due?page=${page}&pageSize=100`,
    );
    expect(response.status()).toBe(200);
    const items = (await response.json()).data as Record<string, unknown>[];
    rows.push(...items.filter((i) => i.paymentReference === paymentReference));
    if (items.length < 100) return rows;
  }
}

test.describe('POST /bookings/:reference/payments', () => {
  test('orders the full total once operator-confirmed; the same key replays, a new key reuses the open order', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const key = randomUUID();

    const first = await pay(customer, reference, totalMinor, key);
    expect(first.status()).toBe(201);
    const payment = (await first.json()).data;
    expect(payment).toEqual({
      reference: expect.stringMatching(/^FLY-PY-[2-9A-HJ-NP-Z]{6}$/),
      bookingReference: reference,
      status: 'INITIATED',
      purpose: 'FULL',
      price: {
        priceType: 'CONFIRMED',
        amountMinor: totalMinor,
        currency: 'INR',
      },
      checkout: {
        provider: 'mock',
        keyId: 'rzp_mock_key',
        orderId: expect.stringMatching(/^order_mock_[0-9a-f]{8}_\d{6}$/),
      },
      paidAt: null,
      createdAt: expect.any(String),
    });

    const replay = await pay(customer, reference, totalMinor, key);
    expect(replay.status()).toBe(201);
    expect(replay.headers()['idempotent-replayed']).toBe('true');
    expect((await replay.json()).data).toEqual(payment);

    // The answer kept for replay holds references only (D-128): none of the
    // customer's own name, email or phone.
    const me = (await (await customer.get('me')).json()).data;
    const stored = await withPrisma((prisma) =>
      prisma.idempotencyKey.findMany({ where: { key } }),
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].responseBody).toEqual(payment);
    const kept = JSON.stringify(stored[0].responseBody);
    for (const value of [
      me.email,
      me.phone,
      me.profile?.firstName,
      me.profile?.lastName,
    ]) {
      if (value) expect(kept).not.toContain(value);
    }

    // Another tab: the open order again, not a second one.
    const again = await pay(customer, reference, totalMinor);
    expect(again.status()).toBe(201);
    expect((await again.json()).data.reference).toBe(payment.reference);

    const rows = await withPrisma((prisma) =>
      prisma.payment.findMany({ where: { booking: { reference } } }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      provider: 'MOCK',
      amountMinor: BigInt(totalMinor),
    });
    // Asking to pay never moves the booking (rule 2).
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentStatus: 'UNPAID',
    });
  });

  test('Model C orders the deposit: 25% rounded up to the next paisa', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment(
      { request, playwright, baseURL },
      'C_DEPOSIT',
    );
    const deposit = Math.ceil((totalMinor * 25) / 100);

    const wrong = await pay(customer, reference, totalMinor);
    expect(wrong.status()).toBe(409);
    const error = (await wrong.json()).error;
    expect(error.code).toBe('PAYMENT_AMOUNT_MISMATCH');
    expect(error.details).toEqual([
      { field: 'amountMinor', issue: String(deposit) },
      { field: 'currency', issue: 'INR' },
      { field: 'purpose', issue: 'DEPOSIT' },
    ]);

    const order = await created(customer, reference, deposit);
    expect(order).toMatchObject({
      purpose: 'DEPOSIT',
      price: { priceType: 'CONFIRMED', amountMinor: deposit },
    });
  });

  test('nothing is due before the operator confirms, for an estimate, or for someone else', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });

    await setBooking(reference, { operatorAcceptedAt: null });
    let response = await pay(customer, reference, totalMinor);
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('PAYMENT_NOT_DUE');

    await setBooking(reference, {
      operatorAcceptedAt: new Date(),
      priceType: 'ESTIMATE',
    });
    response = await pay(customer, reference, totalMinor);
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('PAYMENT_NOT_DUE');

    await setBooking(reference, { priceType: 'CONFIRMED' });
    const stranger = await playwright.request.newContext({ baseURL });
    await registerCustomer(stranger);
    response = await pay(stranger, reference, totalMinor);
    expect(response.status()).toBe(404);

    const anonymous = await playwright.request.newContext({ baseURL });
    response = await anonymous.post(`bookings/${reference}/payments`, {
      headers: { 'Idempotency-Key': randomUUID() },
      data: { expectedAmountMinor: totalMinor, currency: 'INR' },
    });
    expect(response.status()).toBe(401);

    // Without a key the request is refused before anything happens.
    response = await customer.post(`bookings/${reference}/payments`, {
      headers: await csrfHeaders(customer),
      data: { expectedAmountMinor: totalMinor, currency: 'INR' },
    });
    expect(response.status()).toBe(400);
  });
});

test.describe('POST /payments/:reference/verify', () => {
  test('a signed checkout result makes the payment PENDING, never paid; a forged one is refused', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const paymentId = `pay_e2e_${randomUUID().slice(0, 8)}`;
    const signature = hmacSha256Hex(
      MOCK_PAYMENT_KEY_SECRET,
      `${order.checkout.orderId}|${paymentId}`,
    );
    const verify = (data: Record<string, string>) =>
      csrfHeaders(customer).then((headers) =>
        customer.post(`payments/${order.reference}/verify`, { headers, data }),
      );

    for (const data of [
      {
        providerOrderId: order.checkout.orderId,
        providerPaymentId: paymentId,
        signature: 'f'.repeat(64),
      },
      {
        providerOrderId: order.checkout.orderId,
        providerPaymentId: 'pay_other',
        signature,
      },
      {
        providerOrderId: 'order_mock_other',
        providerPaymentId: paymentId,
        signature,
      },
    ]) {
      const refused = await verify(data);
      expect(refused.status()).toBe(400);
      expect((await refused.json()).error.code).toBe(
        'PAYMENT_SIGNATURE_INVALID',
      );
    }
    expect((await paymentRow(order.reference)).status).toBe('INITIATED');

    const valid = {
      providerOrderId: order.checkout.orderId,
      providerPaymentId: paymentId,
      signature,
    };
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const response = await verify(valid);
      expect(response.status()).toBe(200);
      expect((await response.json()).data.status).toBe('PENDING');
    }
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentStatus: 'UNPAID',
    });

    const stranger = await playwright.request.newContext({ baseURL });
    await registerCustomer(stranger);
    const foreign = await stranger.post(`payments/${order.reference}/verify`, {
      headers: await csrfHeaders(stranger),
      data: valid,
    });
    expect(foreign.status()).toBe(404);
  });

  test('a payment in progress keeps the aircraft held past the payment window, to its 48-hour bound (rules 3 and 5)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor, trip, searched } =
      await bookingAwaitingPayment({ request, playwright, baseURL });
    const order = await created(customer, reference, totalMinor);
    const holdOf = () =>
      withPrisma(async (prisma) => {
        const booking = await prisma.booking.findUniqueOrThrow({
          where: { reference },
        });
        return prisma.availabilityBlock.findFirstOrThrow({
          where: { bookingId: booking.id, reason: 'SOFT_HOLD' },
        });
      });
    // The payment window lapses while the customer is at the checkout: the
    // time is offered again.
    const lapsed = await holdOf();
    await withPrisma((prisma) =>
      prisma.availabilityBlock.update({
        where: { id: lapsed.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      }),
    );
    expect((await searchFor(request, trip)).result).toBeDefined();

    const paymentId = `pay_e2e_${randomUUID().slice(0, 8)}`;
    const verified = await customer.post(`payments/${order.reference}/verify`, {
      headers: await csrfHeaders(customer),
      data: {
        providerOrderId: order.checkout.orderId,
        providerPaymentId: paymentId,
        signature: hmacSha256Hex(
          MOCK_PAYMENT_KEY_SECRET,
          `${order.checkout.orderId}|${paymentId}`,
        ),
      },
    });
    expect(verified.status()).toBe(200);
    expect((await verified.json()).data.status).toBe('PENDING');

    // Kept until the payment stops being waited for (48 hours from the
    // order; the trip is further away), and audited as a renewal.
    const { createdAt } = await paymentRow(order.reference);
    const kept = await holdOf();
    expect(kept.expiresAt?.toISOString()).toBe(
      new Date(createdAt.getTime() + 48 * 3_600_000).toISOString(),
    );
    const renewals = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: kept.id, action: 'availability.block.extend' },
      }),
    );
    expect(renewals).toHaveLength(1);

    // Another customer cannot take the aircraft, nor does a search offer it.
    const other = await playwright.request.newContext({ baseURL });
    await registerCustomer(other);
    const competing = await other.post('bookings', {
      headers: {
        ...(await csrfHeaders(other)),
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
    expect(competing.status()).toBe(409);
    expect((await competing.json()).error.code).toBe('BOOKING_UNAVAILABLE');
    expect((await searchFor(request, trip)).result).toBeUndefined();
  });
  test("a checkout result is settled at once from the gateway's own status; its later notice changes nothing (rules 2 and 5)", async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const simulated = await request.post(
      `dev/payments/orders/${order.checkout.orderId}/simulate`,
      { headers: await csrfHeaders(request), data: { outcome: 'success' } },
    );
    expect(simulated.status()).toBe(200);
    const { checkout, webhook } = (await simulated.json()).data as {
      checkout: Record<string, string>;
      webhook: { body: string; headers: Record<string, string> };
    };

    // The server asks the gateway itself, so the answer is already paid.
    const verified = await customer.post(`payments/${order.reference}/verify`, {
      headers: await csrfHeaders(customer),
      data: checkout,
    });
    expect(verified.status()).toBe(200);
    expect((await verified.json()).data.status).toBe('SUCCEEDED');
    const payment = await paymentRow(order.reference);
    expect(payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: checkout.providerPaymentId,
      reviewReason: null,
    });
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    });

    // The notice, then the same result again: one success, recorded once.
    const notice = await request.post('webhooks/payments/mock', {
      data: webhook.body,
      headers: webhook.headers,
    });
    expect(notice.status()).toBe(200);
    const again = await customer.post(`payments/${order.reference}/verify`, {
      headers: await csrfHeaders(customer),
      data: checkout,
    });
    expect((await again.json()).data.status).toBe('SUCCEEDED');
    const successes = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: {
          entityId: payment.id,
          action: 'payment.status',
          after: { path: ['status'], equals: 'SUCCEEDED' },
        },
      }),
    );
    expect(successes).toHaveLength(1);
    expect(successes[0].after).toMatchObject({
      status: 'SUCCEEDED',
      source: 'checkout-fetch',
    });
  });
  test('a browser claim with a bad signature settles nothing even when the gateway has the payment; a verified one settles, and a duplicate notice adds nothing (rules 2 and 5)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const simulated = await request.post(
      `dev/payments/orders/${order.checkout.orderId}/simulate`,
      { headers: await csrfHeaders(request), data: { outcome: 'success' } },
    );
    expect(simulated.status()).toBe(200);
    const { checkout, webhook } = (await simulated.json()).data as {
      checkout: Record<string, string>;
      webhook: { body: string; headers: Record<string, string> };
    };
    const verify = async (data: Record<string, string>) =>
      customer.post(`payments/${order.reference}/verify`, {
        headers: await csrfHeaders(customer),
        data,
      });

    // The gateway holds a captured payment, but the claim is forged.
    const forged = await verify({ ...checkout, signature: 'f'.repeat(64) });
    expect(forged.status()).toBe(400);
    expect((await forged.json()).error.code).toBe('PAYMENT_SIGNATURE_INVALID');
    expect((await paymentRow(order.reference)).status).toBe('INITIATED');
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentStatus: 'UNPAID',
    });

    // The genuine claim settles from the gateway's answer.
    const settled = await verify(checkout);
    expect(settled.status()).toBe(200);
    expect((await settled.json()).data.status).toBe('SUCCEEDED');
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    });

    // The gateway's own notice afterwards, delivered twice: still one.
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await request.post('webhooks/payments/mock', {
        data: webhook.body,
        headers: webhook.headers,
      });
      expect(response.status()).toBe(200);
    }
    const payment = await paymentRow(order.reference);
    const { events, succeeded, payments } = await withPrisma(
      async (prisma) => ({
        events: await prisma.paymentEvent.findMany({
          where: { paymentId: payment.id },
        }),
        succeeded: await prisma.auditLog.count({
          where: {
            entityId: payment.id,
            action: 'payment.status',
            after: { path: ['status'], equals: 'SUCCEEDED' },
          },
        }),
        payments: await prisma.payment.count({
          where: { booking: { reference } },
        }),
      }),
    );
    expect(payments).toBe(1);
    expect(succeeded).toBe(1);
    const noticeEvents = events.filter(
      (e) => e.providerEventId === webhook.headers[MOCK_EVENT_ID_HEADER],
    );
    expect(noticeEvents).toHaveLength(1);
    // The stored payload is the allowlist: no email, contact or VPA.
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const keys = Object.keys(event.payload as Record<string, unknown>);
      for (const key of keys) {
        expect(STORED_EVENT_FIELDS as readonly string[]).toContain(key);
      }
      expect(JSON.stringify(event.payload)).not.toMatch(/email|contact|vpa|@/i);
    }
  });
});

test.describe('POST /webhooks/payments/:provider applies verified notices', () => {
  test('a capture pays an accepted booking and confirms it, once; a duplicate and a late failure change nothing', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const captured = notice('payment.captured', {
      orderId: order.checkout.orderId,
      amountMinor: totalMinor,
    });

    // Two deliveries at once and a third later: applied once (rule 5).
    const deliveries = await Promise.all([
      deliver(request, captured),
      deliver(request, captured),
    ]);
    deliveries.push(await deliver(request, captured));
    for (const response of deliveries) {
      expect(response.status()).toBe(200);
      expect((await response.json()).data).toEqual({ received: true });
    }

    const payment = await paymentRow(order.reference);
    expect(payment).toMatchObject({ status: 'SUCCEEDED', reviewReason: null });
    expect(payment.paidAt).not.toBeNull();
    // The operator's acceptance was recorded and the price is confirmed, so
    // the confirmation rule holds once the payment is in.
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    });
    const confirmations = await withPrisma((prisma) =>
      prisma.bookingEvent.findMany({
        where: { booking: { reference }, toStatus: 'CONFIRMED' },
      }),
    );
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      fromStatus: 'AWAITING_PAYMENT',
      actorId: null,
    });

    const { events, updates } = await withPrisma(async (prisma) => ({
      events: await prisma.paymentEvent.findMany({
        where: { providerEventId: captured.eventId },
      }),
      updates: await prisma.bookingEvent.findMany({
        where: { booking: { reference }, type: 'PAYMENT_UPDATE' },
      }),
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      provider: 'MOCK',
      paymentId: payment.id,
      signatureValid: true,
      type: 'payment.captured',
    });
    expect(events[0].processedAt).not.toBeNull();
    // References and amounts only: nothing of the payer's card or contact.
    const stored = JSON.stringify(events[0].payload);
    expect(stored).not.toContain('payer@example.com');
    expect(stored).not.toContain('4242');
    expect(updates).toHaveLength(1);
    expect(updates[0].payload).toMatchObject({ from: 'UNPAID', to: 'PAID' });

    // A failure notice arriving late never undoes the success.
    const failed = await deliver(
      request,
      notice('payment.failed', {
        orderId: order.checkout.orderId,
        amountMinor: totalMinor,
      }),
    );
    expect(failed.status()).toBe(200);
    expect((await paymentRow(order.reference)).status).toBe('SUCCEEDED');

    const paidAgain = await pay(customer, reference, totalMinor);
    expect(paidAgain.status()).toBe(409);
    expect((await paidAgain.json()).error.code).toBe('PAYMENT_ALREADY_PAID');
  });

  test('a payment before the operator accepted leaves the booking unconfirmed (rule 2)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    // Model A takes payment without waiting for the operator; a request-mode
    // booking still needs the operator's acceptance to be confirmed.
    const { customer, reference, totalMinor } = await bookingAwaitingPayment(
      { request, playwright, baseURL },
      'A_INSTANT',
    );
    await setBooking(reference, {
      bookingMode: 'REQUEST',
      operatorAcceptedAt: null,
    });
    const order = await created(customer, reference, totalMinor);
    const response = await deliver(
      request,
      notice('payment.captured', {
        orderId: order.checkout.orderId,
        amountMinor: totalMinor,
      }),
    );
    expect(response.status()).toBe(200);
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentStatus: 'PAID',
    });
    // Waiting for the operator is not a reason to refund.
    expect((await paymentRow(order.reference)).reviewReason).toBeNull();
  });

  test('a Model C deposit confirms an accepted booking', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment(
      { request, playwright, baseURL },
      'C_DEPOSIT',
    );
    const deposit = Math.ceil((totalMinor * 25) / 100);
    const order = await created(customer, reference, deposit);
    const response = await deliver(
      request,
      notice('payment.captured', {
        orderId: order.checkout.orderId,
        amountMinor: deposit,
      }),
    );
    expect(response.status()).toBe(200);
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CONFIRMED',
      paymentStatus: 'PARTIALLY_PAID',
    });
  });

  test('a booking whose held time was taken stays unconfirmed when paid, and operations are told (rule 3)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    // Another booking's confirmed block now covers the held time.
    const bookingId = await withPrisma(async (prisma) => {
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
      return booking.id;
    });
    const response = await deliver(
      request,
      notice('payment.captured', {
        orderId: order.checkout.orderId,
        amountMinor: totalMinor,
      }),
    );
    // The payment is recorded all the same.
    expect(response.status()).toBe(200);
    expect((await paymentRow(order.reference)).status).toBe('SUCCEEDED');
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentStatus: 'PAID',
    });
    const blocked = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: bookingId, action: 'booking.confirmation_blocked' },
      }),
    );
    expect(blocked).toHaveLength(1);
    // The money is not stranded: flagged and due in full in the finance
    // queue, while the booking still reads paid but not confirmed.
    expect((await paymentRow(order.reference)).reviewReason).toBe(
      'BOOKING_CLOSED',
    );
    expect(
      await refundsDueFor({ request, playwright, baseURL }, order.reference),
    ).toEqual([
      expect.objectContaining({
        kind: 'BOOKING_CLOSED',
        dueMinor: totalMinor,
        bookingStatus: 'AWAITING_PAYMENT',
        bookingPaymentStatus: 'PAID',
      }),
    ]);
    // Nothing more is asked of the customer.
    expect(
      (await (await customer.get(`bookings/${reference}`)).json()).data
        .amountDue,
    ).toBeNull();
  });

  test('a booking whose aircraft was grounded after acceptance stays unconfirmed when paid (rule 4)', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const bookingId = await withPrisma(async (prisma) => {
      const booking = await prisma.booking.findUniqueOrThrow({
        where: { reference },
      });
      await prisma.aircraft.update({
        where: { id: booking.aircraftId! },
        data: { availabilityStatus: 'MAINTENANCE' },
      });
      return booking.id;
    });
    const response = await deliver(
      request,
      notice('payment.captured', {
        orderId: order.checkout.orderId,
        amountMinor: totalMinor,
      }),
    );
    expect(response.status()).toBe(200);
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentStatus: 'PAID',
    });
    const blocked = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: bookingId, action: 'booking.confirmation_blocked' },
      }),
    );
    expect(blocked.after).toMatchObject({
      reason: 'the aircraft is not approved or not in service',
    });
    expect((await paymentRow(order.reference)).reviewReason).toBe(
      'BOOKING_CLOSED',
    );
  });

  test('the whole flow: request, operator accepts, customer pays, booking CONFIRMED', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const trip = await listedJet({ request, playwright, baseURL });
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
    const customer = await playwright.request.newContext({ baseURL });
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
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'OPERATOR_PENDING',
    });

    const accepted = await request.post(
      `operator/booking-requests/${reference}/accept`,
      {
        headers: {
          ...(await csrfHeaders(request)),
          'Idempotency-Key': randomUUID(),
        },
      },
    );
    expect(accepted.status()).toBe(200);
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentStatus: 'UNPAID',
    });

    // Whatever the category's payment model, pay what is due.
    const due = await withPrisma((prisma) =>
      prisma.booking.findUniqueOrThrow({ where: { reference } }),
    );
    const amount =
      due.paymentModel === 'C_DEPOSIT'
        ? Number((due.totalMinor * 25n + 99n) / 100n)
        : Number(due.totalMinor);
    const order = await created(customer, reference, amount);
    const captured = await deliver(
      request,
      notice('payment.captured', {
        orderId: order.checkout.orderId,
        amountMinor: amount,
      }),
    );
    expect(captured.status()).toBe(200);
    const confirmed = await customer.get(`bookings/${reference}`);
    expect((await confirmed.json()).data).toMatchObject({
      status: 'CONFIRMED',
      price: { priceType: 'CONFIRMED' },
    });
    const row = await withPrisma((prisma) =>
      prisma.booking.findUniqueOrThrow({
        where: { reference },
        include: { holds: true, events: { orderBy: { createdAt: 'asc' } } },
      }),
    );
    expect(row.confirmedAt).not.toBeNull();
    // The held time is kept until the trip ends.
    expect(row.holds[0].expiresAt!.getTime()).toBe(
      row.holds[0].endsAt.getTime(),
    );
    expect(
      row.events
        .filter((event) => event.type === 'STATUS_CHANGED')
        .map((event) => event.toStatus),
    ).toEqual([
      'REQUESTED',
      'OPERATOR_PENDING',
      'PRICE_CONFIRMED',
      'AWAITING_PAYMENT',
      'CONFIRMED',
    ]);
  });

  test('a bad signature is refused and stored nowhere', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const forged = notice('payment.captured', {
      orderId: order.checkout.orderId,
      amountMinor: totalMinor,
    });

    const response = await deliver(request, forged, 'a-guessed-secret');
    expect(response.status()).toBe(400);
    expect((await response.json()).error.code).toBe(
      'WEBHOOK_SIGNATURE_INVALID',
    );

    const stored = await withPrisma((prisma) =>
      prisma.paymentEvent.count({ where: { providerEventId: forged.eventId } }),
    );
    expect(stored).toBe(0);
    expect((await paymentRow(order.reference)).status).toBe('INITIATED');
    // A forged event ID cannot block the real notice later.
    expect((await deliver(request, forged)).status()).toBe(200);
    expect((await paymentRow(order.reference)).status).toBe('SUCCEEDED');
  });

  test('a failure lets the customer pay again with a new order', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const failed = await deliver(
      request,
      notice('payment.failed', {
        orderId: order.checkout.orderId,
        amountMinor: totalMinor,
      }),
    );
    expect(failed.status()).toBe(200);
    expect((await paymentRow(order.reference)).status).toBe('FAILED');
    expect((await bookingOf(customer, reference)).paymentStatus).toBe('UNPAID');

    const retry = await created(customer, reference, totalMinor);
    expect(retry.reference).not.toBe(order.reference);
    expect(retry.checkout.orderId).not.toBe(order.checkout.orderId);
  });

  test('a capture for another amount is not a success and is flagged', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const response = await deliver(
      request,
      notice('payment.captured', {
        orderId: order.checkout.orderId,
        amountMinor: totalMinor - 100,
      }),
    );
    expect(response.status()).toBe(200);
    expect(await paymentRow(order.reference)).toMatchObject({
      status: 'INITIATED',
      reviewReason: 'AMOUNT_MISMATCH',
    });
    expect((await bookingOf(customer, reference)).paymentStatus).toBe('UNPAID');

    // A mismatched notice stored before its order was known stays unlinked
    // and is applied on every redelivery: recorded once all the same.
    const earlyOrderId = `order_early_${randomUUID().slice(0, 8)}`;
    const early = notice('payment.captured', {
      orderId: earlyOrderId,
      amountMinor: totalMinor - 100,
    });
    expect((await deliver(request, early)).status()).toBe(200);
    await setOrderId(order.reference, earlyOrderId);
    for (let delivery = 0; delivery < 3; delivery += 1) {
      expect((await deliver(request, early)).status()).toBe(200);
    }
    const { id } = await paymentRow(order.reference);
    const flags = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: id, action: 'payment.flag' },
      }),
    );
    expect(flags).toHaveLength(1);
  });

  test('a late success for an expired booking is recorded and flagged for operations', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    // The payment window lapsed before the gateway's notice arrived.
    await setBooking(reference, { status: 'EXPIRED' });

    const response = await deliver(
      request,
      notice('payment.captured', {
        orderId: order.checkout.orderId,
        amountMinor: totalMinor,
      }),
    );
    expect(response.status()).toBe(200);
    expect(await paymentRow(order.reference)).toMatchObject({
      status: 'SUCCEEDED',
      reviewReason: 'BOOKING_CLOSED',
    });
    // The money is recorded; the booking stays expired.
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'EXPIRED',
      paymentStatus: 'PAID',
    });
  });

  test('a notice for an unknown order is stored and acknowledged', async ({
    request,
  }) => {
    const unknown = notice('payment.captured', {
      orderId: `order_unknown_${randomUUID().slice(0, 8)}`,
      amountMinor: 50_000,
    });
    expect((await deliver(request, unknown)).status()).toBe(200);
    const stored = await withPrisma((prisma) =>
      prisma.paymentEvent.findFirstOrThrow({
        where: { providerEventId: unknown.eventId },
      }),
    );
    expect(stored).toMatchObject({ paymentId: null, processedAt: null });
  });

  test('a notice that came before its order was recorded is applied when it is delivered again', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    // The notice names an order not recorded yet (it beat the transaction
    // that records it): stored unapplied and acknowledged.
    const earlyOrderId = `order_early_${randomUUID().slice(0, 8)}`;
    const early = notice('payment.captured', {
      orderId: earlyOrderId,
      amountMinor: totalMinor,
    });
    expect((await deliver(request, early)).status()).toBe(200);
    expect((await paymentRow(order.reference)).status).toBe('INITIATED');

    // Now the order is known under that id, and the gateway sends it again.
    await withPrisma((prisma) =>
      prisma.payment.update({
        where: { reference: order.reference },
        data: { providerOrderId: earlyOrderId },
      }),
    );
    for (let delivery = 0; delivery < 2; delivery += 1) {
      const response = await deliver(request, early);
      expect(response.status()).toBe(200);
    }

    const payment = await paymentRow(order.reference);
    expect(payment).toMatchObject({ status: 'SUCCEEDED', reviewReason: null });
    // Accepted, price confirmed and paid: the confirmation rule holds.
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    });
    const { events, audits } = await withPrisma(async (prisma) => ({
      // Append-only: the stored event stays as it was written.
      events: await prisma.paymentEvent.findMany({
        where: { providerEventId: early.eventId },
      }),
      audits: await prisma.auditLog.findMany({
        where: { entityId: payment.id, action: 'payment.status' },
      }),
    }));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ paymentId: null, processedAt: null });
    // Applied once, on the redelivery, and recorded with the event's id.
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toMatchObject({
      status: 'SUCCEEDED',
      source: 'webhook-redelivery',
      providerEventId: early.eventId,
    });
  });

  test('a second capture with another gateway payment on a paid order is flagged, never ignored', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const first = notice('payment.captured', {
      orderId: order.checkout.orderId,
      amountMinor: totalMinor,
    });
    expect((await deliver(request, first)).status()).toBe(200);
    const paid = await paymentRow(order.reference);
    expect(paid).toMatchObject({ status: 'SUCCEEDED', reviewReason: null });

    const second = notice('payment.captured', {
      orderId: order.checkout.orderId,
      amountMinor: totalMinor,
    });
    expect((await deliver(request, second)).status()).toBe(200);

    const flagged = await paymentRow(order.reference);
    expect(flagged).toMatchObject({
      status: 'SUCCEEDED',
      reviewReason: 'DUPLICATE_CAPTURE',
      // The first capture stays the payment's own.
      providerPaymentId: paid.providerPaymentId,
    });
    expect(await bookingOf(customer, reference)).toMatchObject({
      paymentStatus: 'PAID',
    });
    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: paid.id, action: 'payment.flag' },
      }),
    );
    expect(audit.after).toMatchObject({ flagged: 'DUPLICATE_CAPTURE' });

    // A third capture is money moved again: recorded too, once however
    // often its notice comes (under a new event id each time).
    const third = notice('payment.captured', {
      orderId: order.checkout.orderId,
      amountMinor: totalMinor,
    });
    const again = (eventId: string) => ({ body: third.body, eventId });
    for (const eventId of [third.eventId, `evt_e2e_${randomUUID()}`]) {
      expect((await deliver(request, again(eventId))).status()).toBe(200);
    }
    const flags = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: paid.id, action: 'payment.flag' },
      }),
    );
    expect(flags).toHaveLength(2);
  });
});

test.describe('POST /dev/jobs/payment-sweep', () => {
  test("settles a payment whose checkout result and notice were both lost, from the gateway's own status", async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    // The customer pays in the gateway's checkout; neither the checkout
    // result nor the notice reaches us. (A checkout result that does is
    // settled at once: POST /payments/:reference/verify.)
    const simulated = await request.post(
      `dev/payments/orders/${order.checkout.orderId}/simulate`,
      { headers: await csrfHeaders(request), data: { outcome: 'success' } },
    );
    expect(simulated.status()).toBe(200);
    const { checkout } = (await simulated.json()).data;

    // Not yet due: changed moments ago.
    await runSweep(request);
    expect((await paymentRow(order.reference)).status).toBe('INITIATED');

    await withPrisma(
      (prisma) => prisma.$executeRaw`
        UPDATE "Payment" SET "updatedAt" = now() - interval '20 minutes'
        WHERE "reference" = ${order.reference}`,
    );
    await runSweep(request);

    const payment = await paymentRow(order.reference);
    expect(payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: checkout.providerPaymentId,
      reviewReason: null,
    });
    // Accepted, price confirmed and paid: the confirmation rule holds.
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CONFIRMED',
      paymentStatus: 'PAID',
    });
    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: {
          entityId: payment.id,
          action: 'payment.status',
          actorId: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
    );
    expect(audit.after).toMatchObject({ status: 'SUCCEEDED', source: 'sweep' });
  });

  test('settles an unpaid-looking payment from a notice that came before its order was recorded', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const { customer, reference, totalMinor } = await bookingAwaitingPayment({
      request,
      playwright,
      baseURL,
    });
    const order = await created(customer, reference, totalMinor);
    const orderId = order.checkout.orderId;
    const simulated = await request.post(
      `dev/payments/orders/${orderId}/simulate`,
      { headers: await csrfHeaders(request), data: { outcome: 'success' } },
    );
    expect(simulated.status()).toBe(200);
    const { checkout, webhook } = (await simulated.json()).data as {
      checkout: { providerPaymentId: string };
      webhook: { body: string; headers: Record<string, string> };
    };

    // The notice arrives while the order is not recorded yet; it is stored
    // and acknowledged, so the gateway never sends it again. The checkout
    // result never comes back either.
    await setOrderId(
      order.reference,
      `order_pending_${randomUUID().slice(0, 8)}`,
    );
    const early = await request.post('webhooks/payments/mock', {
      data: webhook.body,
      headers: webhook.headers,
    });
    expect(early.status()).toBe(200);
    await setOrderId(order.reference, orderId);
    await withPrisma(
      (prisma) => prisma.$executeRaw`
        UPDATE "Payment" SET "updatedAt" = now() - interval '20 minutes'
        WHERE "reference" = ${order.reference}`,
    );
    expect(await paymentRow(order.reference)).toMatchObject({
      status: 'INITIATED',
      providerPaymentId: null,
    });

    await runSweep(request);

    const payment = await paymentRow(order.reference);
    expect(payment).toMatchObject({
      status: 'SUCCEEDED',
      providerPaymentId: checkout.providerPaymentId,
    });
    const audit = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: {
          entityId: payment.id,
          action: 'payment.status',
          actorId: null,
        },
      }),
    );
    expect(audit.after).toMatchObject({ status: 'SUCCEEDED', source: 'sweep' });
  });
});
