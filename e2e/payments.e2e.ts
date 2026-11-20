import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import {
  MOCK_EVENT_ID_HEADER,
  MOCK_PAYMENT_KEY_SECRET,
  MOCK_PAYMENT_WEBHOOK_SECRET,
  MOCK_SIGNATURE_HEADER,
} from '../src/integrations/payment/mock-payment-gateway.provider.js';
import { hmacSha256Hex } from '../src/integrations/payment/payment-signature.js';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders } from './support/session.js';

/**
 * Payments on the mock gateway (M9, W3-4): orders, the checkout result and
 * the gateway's signed notices. The gateway's own checkout cannot be driven
 * from here, so the test signs the checkout result and the notices itself
 * with the development secrets the test server runs with.
 */

type Contexts = Parameters<typeof listedJet>[0];
type Model = 'A_INSTANT' | 'B_OPERATOR_CONFIRMED' | 'C_DEPOSIT';

/**
 * A booking request from a real search, moved by hand to where quotes
 * (W3-1) will bring it: `AWAITING_PAYMENT` with a `CONFIRMED` price.
 */
async function bookingAwaitingPayment(
  contexts: Contexts,
  model: Model = 'B_OPERATOR_CONFIRMED',
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
  const customer = await contexts.playwright.request.newContext({
    baseURL: contexts.baseURL,
  });
  await registerCustomer(customer);
  const booked = await customer.post('bookings', {
    headers: {
      ...(await csrfHeaders(customer)),
      'Idempotency-Key': randomUUID(),
    },
    data: {
      searchId: searched.searchId,
      resultId: searched.result.resultId,
      expectedTotalMinor: searched.result.price.amountMinor,
      currency: 'INR',
    },
  });
  expect(booked.status()).toBe(201);
  const reference = (await booked.json()).data.reference as string;
  await setBooking(reference, {
    status: 'AWAITING_PAYMENT',
    priceType: 'CONFIRMED',
    operatorAcceptedAt: new Date(),
    paymentModel: model,
  });
  return {
    customer,
    reference,
    totalMinor: searched.result.price.amountMinor as number,
  };
}

function setBooking(
  reference: string,
  data: Record<string, unknown>,
): Promise<unknown> {
  return withPrisma((prisma) =>
    prisma.booking.update({ where: { reference }, data }),
  );
}

async function pay(
  customer: APIRequestContext,
  reference: string,
  expectedAmountMinor: number,
  key: string = randomUUID(),
) {
  return customer.post(`bookings/${reference}/payments`, {
    headers: { ...(await csrfHeaders(customer)), 'Idempotency-Key': key },
    data: { expectedAmountMinor, currency: 'INR' },
  });
}

async function created(
  customer: APIRequestContext,
  reference: string,
  amountMinor: number,
) {
  const response = await pay(customer, reference, amountMinor);
  expect(response.status()).toBe(201);
  return (await response.json()).data as {
    reference: string;
    status: string;
    purpose: string;
    price: { priceType: string; amountMinor: number; currency: string };
    checkout: { provider: string; keyId: string; orderId: string };
  };
}

/** A signed payment notice in Razorpay's shape, as the gateway posts it. */
function notice(
  event: 'payment.captured' | 'payment.failed',
  order: { orderId: string; amountMinor: number },
  options: { paymentId?: string; eventId?: string } = {},
) {
  const body = JSON.stringify({
    entity: 'event',
    event,
    payload: {
      payment: {
        entity: {
          id: options.paymentId ?? `pay_e2e_${randomUUID()}`,
          order_id: order.orderId,
          amount: order.amountMinor,
          currency: 'INR',
          status: event === 'payment.captured' ? 'captured' : 'failed',
          // Sent by the gateway, never stored (rule 10).
          email: 'payer@example.com',
          card: { last4: '4242', network: 'Visa' },
        },
      },
    },
  });
  return {
    body,
    eventId: options.eventId ?? `evt_e2e_${randomUUID()}`,
  };
}

function deliver(
  request: APIRequestContext,
  webhook: { body: string; eventId: string },
  secret = MOCK_PAYMENT_WEBHOOK_SECRET,
) {
  return request.post('webhooks/payments/mock', {
    data: webhook.body,
    headers: {
      'Content-Type': 'application/json',
      [MOCK_SIGNATURE_HEADER]: hmacSha256Hex(secret, webhook.body),
      [MOCK_EVENT_ID_HEADER]: webhook.eventId,
    },
  });
}

async function bookingOf(customer: APIRequestContext, reference: string) {
  const response = await customer.get(`bookings/${reference}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data as {
    status: string;
    paymentStatus: string;
  };
}

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

function paymentRow(reference: string) {
  return withPrisma((prisma) =>
    prisma.payment.findUniqueOrThrow({ where: { reference } }),
  );
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
});

test.describe('POST /webhooks/payments/:provider applies verified notices', () => {
  test('a capture pays the booking without confirming it; a duplicate and a late failure change nothing', async ({
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
    // Paid, and still not confirmed: the payment never moves the booking (rule 2).
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
      paymentStatus: 'PAID',
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
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
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
  });
});

test.describe('POST /dev/jobs/payment-sweep', () => {
  test("settles a payment whose notice never came from the gateway's own status", async ({
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
    // The customer pays in the gateway's checkout; its notice is lost.
    const simulated = await request.post(
      `dev/payments/orders/${order.checkout.orderId}/simulate`,
      { headers: await csrfHeaders(request), data: { outcome: 'success' } },
    );
    expect(simulated.status()).toBe(200);
    const { checkout } = (await simulated.json()).data;
    const verified = await customer.post(`payments/${order.reference}/verify`, {
      headers: await csrfHeaders(customer),
      data: checkout,
    });
    expect(verified.status()).toBe(200);
    expect((await paymentRow(order.reference)).status).toBe('PENDING');

    // Not yet due: changed moments ago.
    await runSweep(request);
    expect((await paymentRow(order.reference)).status).toBe('PENDING');

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
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'AWAITING_PAYMENT',
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
});
