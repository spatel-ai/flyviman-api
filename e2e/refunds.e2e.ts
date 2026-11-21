import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { APIRequestContext, expect, test } from '@playwright/test';
import { registerCustomer } from './support/data.js';
import { withPrisma } from './support/db.js';
import { listedJet, searchFor } from './support/pricing.js';
import { csrfHeaders, signIn } from './support/session.js';

/**
 * Refunds, receipts and the Model C balance on the mock gateway (M9, W4-1).
 * Payments are made through the mock's checkout (`dev/payments/.../simulate`)
 * so the gateway knows them and can refund them; its signed notices are
 * delivered by the test, as often as the test chooses.
 */

type Contexts = Parameters<typeof listedJet>[0];
type Model = 'B_OPERATOR_CONFIRMED' | 'C_DEPOSIT';
type Signed = { body: string; headers: Record<string, string> };

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
        paymentModel: model,
      },
    }),
  );
  return {
    customer,
    reference,
    totalMinor: searched.result.price.amountMinor as number,
  };
}

function newContext(contexts: Contexts) {
  return contexts.playwright.request.newContext({ baseURL: contexts.baseURL });
}

async function staff(contexts: Contexts, account: 'finance' | 'ops') {
  const context = await newContext(contexts);
  await signIn(context, account);
  return context;
}

/** Orders what is due, pays it in the mock checkout and delivers the notice. */
async function payInFull(
  request: APIRequestContext,
  customer: APIRequestContext,
  reference: string,
  amountMinor: number,
  method?: 'card' | 'upi' | 'netbanking',
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
    purpose: string;
    checkout: { orderId: string };
  };
  const simulated = await request.post(
    `dev/payments/orders/${payment.checkout.orderId}/simulate`,
    {
      headers: await csrfHeaders(request),
      data: { outcome: 'success', ...(method ? { method } : {}) },
    },
  );
  expect(simulated.status()).toBe(200);
  const { webhook } = (await simulated.json()).data as { webhook: Signed };
  expect((await deliver(request, webhook)).status()).toBe(200);
  return payment;
}

function deliver(request: APIRequestContext, webhook: Signed) {
  return request.post('webhooks/payments/mock', {
    data: webhook.body,
    headers: webhook.headers,
  });
}

async function refund(
  finance: APIRequestContext,
  paymentReference: string,
  amountMinor: number,
  key: string = randomUUID(),
) {
  return finance.post(`admin/payments/${paymentReference}/refunds`, {
    headers: { ...(await csrfHeaders(finance)), 'Idempotency-Key': key },
    data: { amountMinor, currency: 'INR', reason: 'Customer cancelled.' },
  });
}

/** The refund's notice from the mock gateway, not yet delivered. */
async function settleInGateway(
  request: APIRequestContext,
  refundReference: string,
  outcome: 'processed' | 'failed',
): Promise<Signed> {
  const { providerRefundId } = await withPrisma((prisma) =>
    prisma.refund.findUniqueOrThrow({ where: { reference: refundReference } }),
  );
  const simulated = await request.post(
    `dev/payments/refunds/${providerRefundId}/simulate`,
    { headers: await csrfHeaders(request), data: { outcome } },
  );
  expect(simulated.status()).toBe(200);
  return (await simulated.json()).data as Signed;
}

async function bookingOf(customer: APIRequestContext, reference: string) {
  const response = await customer.get(`bookings/${reference}`);
  expect(response.status()).toBe(200);
  return (await response.json()).data as {
    status: string;
    paymentStatus: string;
  };
}

test.describe('POST /admin/payments/:reference/refunds', () => {
  test('a refund is created once per key, refused over the remainder, and its notice applies once', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference, totalMinor } =
      await bookingAwaitingPayment(contexts);
    const payment = await payInFull(request, customer, reference, totalMinor);
    const finance = await staff(contexts, 'finance');
    const ops = await staff(contexts, 'ops');

    // Only finance and the super administrator refund.
    expect((await refund(customer, payment.reference, 100)).status()).toBe(403);
    expect((await refund(ops, payment.reference, 100)).status()).toBe(403);

    // More than was paid is refused, and nothing is recorded.
    const over = await refund(finance, payment.reference, totalMinor + 1);
    expect(over.status()).toBe(409);
    const overError = (await over.json()).error;
    expect(overError.code).toBe('REFUND_EXCEEDS_REMAINDER');
    expect(overError.details).toContainEqual({
      field: 'refundableMinor',
      issue: String(totalMinor),
    });

    // A partial refund, twice with the same key: one refund.
    const part = Math.floor(totalMinor / 4);
    const key = randomUUID();
    const first = await refund(finance, payment.reference, part, key);
    expect(first.status()).toBe(201);
    const started = (await first.json()).data;
    expect(started).toMatchObject({
      reference: expect.stringMatching(/^FLY-RF-[2-9A-HJ-NP-Z]{6}$/),
      paymentReference: payment.reference,
      bookingReference: reference,
      amountMinor: part,
      currency: 'INR',
      status: 'PENDING',
      paymentStatus: 'REFUND_PENDING',
      refundableMinor: totalMinor - part,
    });
    const replay = await refund(finance, payment.reference, part, key);
    expect(replay.status()).toBe(201);
    expect(replay.headers()['idempotent-replayed']).toBe('true');
    expect((await replay.json()).data).toEqual(started);
    const rows = await withPrisma((prisma) =>
      prisma.refund.findMany({
        where: { payment: { reference: payment.reference } },
      }),
    );
    expect(rows).toHaveLength(1);
    expect(await bookingOf(customer, reference)).toMatchObject({
      paymentStatus: 'REFUND_PENDING',
    });

    // The rest is refundable; more than the rest is not.
    const tooMuch = await refund(
      finance,
      payment.reference,
      totalMinor - part + 1,
    );
    expect(tooMuch.status()).toBe(409);
    expect((await tooMuch.json()).error.code).toBe('REFUND_EXCEEDS_REMAINDER');

    // The gateway's notice, delivered twice, and once more under a new
    // event id: the refund completes once.
    const notice = await settleInGateway(
      request,
      started.reference,
      'processed',
    );
    expect((await deliver(request, notice)).status()).toBe(200);
    expect((await deliver(request, notice)).status()).toBe(200);
    const again = {
      body: notice.body,
      headers: {
        ...notice.headers,
        'x-razorpay-event-id': `evt_${randomUUID()}`,
      },
    };
    expect((await deliver(request, again)).status()).toBe(200);

    const completed = await withPrisma((prisma) =>
      prisma.refund.findUniqueOrThrow({
        where: { reference: started.reference },
        include: { payment: true },
      }),
    );
    expect(completed.status).toBe('COMPLETED');
    expect(completed.payment.status).toBe('PARTIALLY_REFUNDED');
    const audits = await withPrisma((prisma) =>
      prisma.auditLog.findMany({
        where: { entityId: completed.id, action: 'refund.status' },
      }),
    );
    // REQUESTED → PENDING (gateway) and PENDING → COMPLETED (notice), once.
    expect(audits.map((a) => (a.after as { status: string }).status)).toEqual(
      expect.arrayContaining(['PENDING', 'COMPLETED']),
    );
    expect(audits).toHaveLength(2);
    const created = await withPrisma((prisma) =>
      prisma.auditLog.findFirstOrThrow({
        where: { entityId: completed.id, action: 'refund.create' },
      }),
    );
    expect(created.reason).toBe('Customer cancelled.');

    // Booking summary: a partial refund on a live paid booking is money
    // returned, not money owed, so it stays PAID with nothing due (W5-9d);
    // only a closed booking reads REFUNDED with money kept.
    const after = (await (await customer.get(`bookings/${reference}`)).json())
      .data as { paymentStatus: string; amountDue: unknown };
    expect(after).toMatchObject({ paymentStatus: 'PAID', amountDue: null });

    // Finance's lists; not for customers.
    const refunds = await finance.get('admin/refunds?pageSize=100');
    expect(refunds.status()).toBe(200);
    expect((await refunds.json()).data).toContainEqual(
      expect.objectContaining({
        reference: started.reference,
        status: 'COMPLETED',
        reason: 'Customer cancelled.',
      }),
    );
    const listed = await finance.get(
      `admin/payments?bookingReference=${reference}`,
    );
    expect(listed.status()).toBe(200);
    expect((await listed.json()).data).toEqual([
      expect.objectContaining({
        reference: payment.reference,
        status: 'PARTIALLY_REFUNDED',
        reviewReason: null,
        refundedMinor: part,
      }),
    ]);
    expect((await customer.get('admin/refunds')).status()).toBe(403);
    expect((await customer.get('admin/payments')).status()).toBe(403);

    // The customer sees the refund on the payment, without the reason.
    const detail = await customer.get(`payments/${payment.reference}`);
    expect(detail.status()).toBe(200);
    const shown = (await detail.json()).data;
    expect(shown).toMatchObject({
      status: 'PARTIALLY_REFUNDED',
      refundedMinor: part,
      refunds: [{ reference: started.reference, status: 'COMPLETED' }],
    });
    expect(shown.refunds[0]).not.toHaveProperty('reason');
  });

  test('a failed refund frees its amount; the full rest then refunds the payment', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference, totalMinor } =
      await bookingAwaitingPayment(contexts);
    const payment = await payInFull(request, customer, reference, totalMinor);
    const finance = await staff(contexts, 'finance');

    const failed = (
      await (await refund(finance, payment.reference, totalMinor)).json()
    ).data;
    expect(failed.status).toBe('PENDING');
    const notice = await settleInGateway(request, failed.reference, 'failed');
    expect((await deliver(request, notice)).status()).toBe(200);
    const row = await withPrisma((prisma) =>
      prisma.payment.findUniqueOrThrow({
        where: { reference: payment.reference },
        include: { refunds: true },
      }),
    );
    expect(row.status).toBe('SUCCEEDED');
    expect(row.refunds[0].status).toBe('FAILED');
    expect(await bookingOf(customer, reference)).toMatchObject({
      paymentStatus: 'PAID',
    });

    const full = await refund(finance, payment.reference, totalMinor);
    expect(full.status()).toBe(201);
    const done = await settleInGateway(
      request,
      (await full.json()).data.reference,
      'processed',
    );
    expect((await deliver(request, done)).status()).toBe(200);
    expect(
      (
        await withPrisma((prisma) =>
          prisma.payment.findUniqueOrThrow({
            where: { reference: payment.reference },
          }),
        )
      ).status,
    ).toBe('REFUNDED');
    expect(await bookingOf(customer, reference)).toMatchObject({
      paymentStatus: 'REFUNDED',
    });
  });

  test('a payment whose money never arrived is not refundable', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference, totalMinor } =
      await bookingAwaitingPayment(contexts);
    const ordered = await customer.post(`bookings/${reference}/payments`, {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: { expectedAmountMinor: totalMinor, currency: 'INR' },
    });
    const paymentReference = (await ordered.json()).data.reference as string;
    const finance = await staff(contexts, 'finance');
    const response = await refund(finance, paymentReference, 100);
    expect(response.status()).toBe(409);
    expect((await response.json()).error.code).toBe('PAYMENT_NOT_REFUNDABLE');
    expect((await refund(finance, 'FLY-PY-ZZZZZZ', 100)).status()).toBe(404);
  });
});

test.describe('GET /admin/refunds/due', () => {
  test('a paid booking cancelled by its customer shows its refund due until it is refunded', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference, totalMinor } =
      await bookingAwaitingPayment(contexts);
    const payment = await payInFull(request, customer, reference, totalMinor);

    // The refund due is now known (paid less the charge), not null.
    const quoted = await customer.get(
      `bookings/${reference}/cancellation-quote`,
    );
    expect(quoted.status()).toBe(200);
    const quote = (await quoted.json()).data;
    expect(quote.paidMinor).toBe(totalMinor);
    expect(quote.refundMinor).toBe(Math.max(0, totalMinor - quote.chargeMinor));
    const cancelled = await customer.post(`bookings/${reference}/cancel`, {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: { expectedChargeMinor: quote.chargeMinor, currency: 'INR' },
    });
    expect(cancelled.status()).toBe(200);
    expect((await cancelled.json()).data.cancellation.refundMinor).toBe(
      quote.refundMinor,
    );
    // The trip is days ahead: the charge leaves money to refund.
    expect(quote.refundMinor).toBeGreaterThan(0);

    const finance = await staff(contexts, 'finance');
    const dueFor = async () => {
      const response = await finance.get('admin/refunds/due?pageSize=100');
      expect(response.status()).toBe(200);
      const items = (await response.json()).data as {
        kind: string;
        paymentReference: string;
        dueMinor: number;
      }[];
      return items.filter((i) => i.paymentReference === payment.reference);
    };
    expect(await dueFor()).toEqual([
      expect.objectContaining({
        kind: 'CANCELLATION',
        bookingReference: reference,
        bookingStatus: 'CANCELLED',
        dueMinor: quote.refundMinor,
        refundableMinor: totalMinor,
      }),
    ]);
    // Customers and operations do not see the queue.
    expect((await customer.get('admin/refunds/due')).status()).toBe(403);
    const ops = await staff(contexts, 'ops');
    expect((await ops.get('admin/refunds/due')).status()).toBe(403);

    // A refund that fails at the gateway: the booking stays cancelled, the
    // money counts as kept again, and the refund is due again.
    const first = await refund(finance, payment.reference, quote.refundMinor);
    expect(first.status()).toBe(201);
    expect(await dueFor()).toEqual([]);
    const failed = await settleInGateway(
      request,
      (await first.json()).data.reference,
      'failed',
    );
    expect((await deliver(request, failed)).status()).toBe(200);
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CANCELLED',
      paymentStatus: 'PAID',
    });
    expect(await dueFor()).toEqual([
      expect.objectContaining({ dueMinor: quote.refundMinor }),
    ]);

    // Again, and the gateway returns it: refunded, still cancelled.
    const second = await refund(finance, payment.reference, quote.refundMinor);
    expect(second.status()).toBe(201);
    const processed = await settleInGateway(
      request,
      (await second.json()).data.reference,
      'processed',
    );
    expect((await deliver(request, processed)).status()).toBe(200);
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CANCELLED',
      paymentStatus: 'REFUNDED',
    });
    expect(await dueFor()).toEqual([]);
  });

  test('a late success for an expired booking is due in full', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference, totalMinor } =
      await bookingAwaitingPayment(contexts);
    const ordered = await customer.post(`bookings/${reference}/payments`, {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: { expectedAmountMinor: totalMinor, currency: 'INR' },
    });
    const order = (await ordered.json()).data;
    await withPrisma((prisma) =>
      prisma.booking.update({
        where: { reference },
        data: { status: 'EXPIRED' },
      }),
    );
    const simulated = await request.post(
      `dev/payments/orders/${order.checkout.orderId}/simulate`,
      { headers: await csrfHeaders(request), data: { outcome: 'success' } },
    );
    const { webhook } = (await simulated.json()).data as { webhook: Signed };
    expect((await deliver(request, webhook)).status()).toBe(200);

    const finance = await staff(contexts, 'finance');
    const response = await finance.get('admin/refunds/due?pageSize=100');
    const items = (await response.json()).data as {
      kind: string;
      paymentReference: string;
      dueMinor: number;
    }[];
    expect(items.filter((i) => i.paymentReference === order.reference)).toEqual(
      [
        expect.objectContaining({
          kind: 'BOOKING_CLOSED',
          dueMinor: totalMinor,
        }),
      ],
    );
  });
});

test.describe('GET /payments/:reference/receipt', () => {
  test('the payer, finance and the super administrator read it; another customer cannot', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference, totalMinor } =
      await bookingAwaitingPayment(contexts);

    // No receipt before the money arrives.
    const ordered = await customer.post(`bookings/${reference}/payments`, {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: { expectedAmountMinor: totalMinor, currency: 'INR' },
    });
    const early = await customer.get(
      `payments/${(await ordered.json()).data.reference}/receipt`,
    );
    expect(early.status()).toBe(409);
    expect((await early.json()).error.code).toBe('PAYMENT_NOT_SUCCEEDED');

    const payment = await payInFull(
      request,
      customer,
      reference,
      totalMinor,
      'card',
    );
    const response = await customer.get(
      `payments/${payment.reference}/receipt`,
    );
    expect(response.status()).toBe(200);
    const receipt = (await response.json()).data;
    expect(receipt).toMatchObject({
      documentType: 'PAYMENT_RECEIPT',
      notice: 'This is a payment receipt, not a GST tax invoice.',
      receiptNumber: payment.reference,
      issuer: { name: 'Flyviman' },
      bookingReference: reference,
      category: 'PRIVATE_CHARTER',
      purpose: 'FULL',
      amount: {
        priceType: 'CONFIRMED',
        amountMinor: totalMinor,
        currency: 'INR',
      },
      method: { type: 'card', label: 'Card' },
      paidAt: expect.any(String),
      refunds: [],
      refundedMinor: 0,
      netPaidMinor: totalMinor,
    });
    // The method type only: no card details (rule 10).
    expect(JSON.stringify(receipt)).not.toMatch(/last4|network|4242/);

    const other = await newContext(contexts);
    await registerCustomer(other);
    expect(
      (await other.get(`payments/${payment.reference}/receipt`)).status(),
    ).toBe(404);
    expect((await other.get(`payments/${payment.reference}`)).status()).toBe(
      404,
    );
    const finance = await staff(contexts, 'finance');
    expect(
      (await finance.get(`payments/${payment.reference}/receipt`)).status(),
    ).toBe(200);
    const ops = await staff(contexts, 'ops');
    expect((await ops.get(`payments/${payment.reference}`)).status()).toBe(403);
  });
});

test.describe('Model C balance', () => {
  test('after the deposit, the balance is ordered and paid, and the booking is PAID', async ({
    request,
    playwright,
    baseURL,
  }) => {
    const contexts = { request, playwright, baseURL };
    const { customer, reference, totalMinor } = await bookingAwaitingPayment(
      contexts,
      'C_DEPOSIT',
    );
    const deposit = Math.ceil((totalMinor * 25) / 100);
    const amountDue = async () =>
      ((await (await customer.get(`bookings/${reference}`)).json()).data
        .amountDue as unknown) ?? null;
    expect(await amountDue()).toEqual({
      amountMinor: deposit,
      currency: 'INR',
      priceType: 'CONFIRMED',
      kind: 'DEPOSIT',
      overOnlineLimit: false,
    });
    const first = await payInFull(request, customer, reference, deposit);
    expect(first.purpose).toBe('DEPOSIT');
    expect(await bookingOf(customer, reference)).toMatchObject({
      paymentStatus: 'PARTIALLY_PAID',
    });

    expect(await amountDue()).toEqual({
      amountMinor: totalMinor - deposit,
      currency: 'INR',
      priceType: 'CONFIRMED',
      kind: 'BALANCE',
      overOnlineLimit: false,
    });

    // A goodwill refund of part of the deposit is money returned, not money
    // owed: the balance does not grow (W5-9d).
    const finance = await staff(contexts, 'finance');
    const goodwill = await refund(finance, first.reference, 100);
    expect(goodwill.status()).toBe(201);
    const goodwillRef = (await goodwill.json()).data.reference as string;
    expect(
      (
        await deliver(
          request,
          await settleInGateway(request, goodwillRef, 'processed'),
        )
      ).status(),
    ).toBe(200);
    expect(await bookingOf(customer, reference)).toMatchObject({
      status: 'CONFIRMED',
      paymentStatus: 'PARTIALLY_PAID',
    });
    expect(await amountDue()).toEqual({
      amountMinor: totalMinor - deposit,
      currency: 'INR',
      priceType: 'CONFIRMED',
      kind: 'BALANCE',
      overOnlineLimit: false,
    });

    // Asking for the deposit again shows the balance due.
    const wrong = await customer.post(`bookings/${reference}/payments`, {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: { expectedAmountMinor: deposit, currency: 'INR' },
    });
    expect(wrong.status()).toBe(409);
    expect((await wrong.json()).error.details).toContainEqual({
      field: 'amountMinor',
      issue: String(totalMinor - deposit),
    });

    const balance = await payInFull(
      request,
      customer,
      reference,
      totalMinor - deposit,
    );
    expect(balance.purpose).toBe('BALANCE');
    expect(await bookingOf(customer, reference)).toMatchObject({
      paymentStatus: 'PAID',
    });
    const row = await withPrisma((prisma) =>
      prisma.payment.findFirstOrThrow({
        where: { reference: balance.reference },
      }),
    );
    // The balance is expected, not a second payment to refund.
    expect(row).toMatchObject({ status: 'SUCCEEDED', reviewReason: null });

    expect(await amountDue()).toBeNull();
    const listed = await customer.get(`bookings/${reference}/payments`);
    expect(listed.status()).toBe(200);
    const payments = (await listed.json()).data as {
      reference: string;
      purpose: string;
      receipt: { purpose: string; amount: { amountMinor: number } } | null;
    }[];
    expect(
      payments.map((p) => [p.purpose, p.receipt?.amount.amountMinor]),
    ).toEqual([
      ['BALANCE', totalMinor - deposit],
      ['DEPOSIT', deposit],
    ]);
    const stranger = await newContext(contexts);
    await registerCustomer(stranger);
    expect(
      (await stranger.get(`bookings/${reference}/payments`)).status(),
    ).toBe(404);

    // Nothing more is due.
    const more = await customer.post(`bookings/${reference}/payments`, {
      headers: {
        ...(await csrfHeaders(customer)),
        'Idempotency-Key': randomUUID(),
      },
      data: { expectedAmountMinor: 100, currency: 'INR' },
    });
    expect(more.status()).toBe(409);
    expect((await more.json()).error.code).toBe('PAYMENT_ALREADY_PAID');
  });
});
