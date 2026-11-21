import { Logger } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PaymentGatewayError } from './payment-gateway.provider.js';
import { hmacSha256Hex } from './payment-signature.js';
import {
  RAZORPAY_API_URL,
  RazorpayPaymentGatewayProvider,
} from './razorpay-payment-gateway.provider.js';
import {
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
} from './razorpay-webhook.js';

const KEY_ID = 'rzp_test_UnitTestKey01';
const KEY_SECRET = 'unit-test-key-secret-0001';
const WEBHOOK_SECRET = 'unit-test-webhook-secret-01';

/** Personal details Razorpay puts in payment answers and notices. */
const EMAIL = 'gaurav.kumar@example.com';
const CONTACT = '+919876543210';
const VPA = 'gaurav.kumar@exampleupi';
const LAST4 = '4366';

type FetchStub = ReturnType<typeof vi.fn<typeof fetch>>;

function answer(status: number, body: unknown): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function razorpayError(description: string) {
  return {
    error: {
      code: 'BAD_REQUEST_ERROR',
      description,
      source: 'business',
      reason: 'input_validation_failed',
      field: null,
    },
  };
}

/** A payment as `GET /payments/:id` answers, personal fields included. */
function paymentAnswer(overrides: Record<string, unknown> = {}) {
  return {
    id: 'pay_29QQoUBi66xm2f',
    entity: 'payment',
    amount: 50000,
    currency: 'INR',
    status: 'captured',
    order_id: 'order_9A33XWu170gUtm',
    method: 'upi',
    amount_refunded: 0,
    refund_status: null,
    captured: true,
    email: EMAIL,
    contact: CONTACT,
    vpa: VPA,
    upi: { vpa: VPA, payer_account_type: 'bank_account' },
    card: { last4: LAST4, network: 'Visa', name: 'Gaurav Kumar' },
    notes: { name: 'Gaurav Kumar' },
    acquirer_data: { rrn: '123456789012' },
    created_at: 1567674606,
    ...overrides,
  };
}

/** `webhookSecret: null` builds the gateway with no webhook secret. */
function gateway(
  fetchStub: FetchStub,
  webhookSecret: string | null = WEBHOOK_SECRET,
) {
  return new RazorpayPaymentGatewayProvider({
    keyId: KEY_ID,
    keySecret: KEY_SECRET,
    webhookSecret: webhookSecret ?? undefined,
    fetch: fetchStub,
  });
}

function stub(...answers: (Response | Error)[]): FetchStub {
  const fn = vi.fn<typeof fetch>();
  for (const next of answers) {
    if (next instanceof Error) fn.mockRejectedValueOnce(next);
    else fn.mockResolvedValueOnce(next);
  }
  return fn;
}

function requestOf(fetchStub: FetchStub, call = 0) {
  // The adapter passes a URL string and a JSON string body.
  const [url, init] = fetchStub.mock.calls[call] as [string, RequestInit];
  return {
    url,
    method: init.method,
    headers: init.headers as Record<string, string>,
    body: init.body ? (JSON.parse(init.body as string) as unknown) : undefined,
    init,
  };
}

async function reasonOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(
    () => null,
    (caught: unknown) => caught,
  );
  expect(error).toBeInstanceOf(PaymentGatewayError);
  return (error as PaymentGatewayError).reason;
}

describe('RazorpayPaymentGatewayProvider', () => {
  let warn: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    warn.mockRestore();
  });

  /** Everything the adapter logged, to check nothing private is in it. */
  function logged(): string {
    return JSON.stringify(warn.mock.calls);
  }

  it('is named razorpay and opens the checkout with the public key ID only', () => {
    const razorpay = gateway(stub());
    expect(razorpay.name).toBe('razorpay');
    expect(razorpay.checkoutKeyId).toBe(KEY_ID);
    expect(JSON.stringify(razorpay)).not.toContain(KEY_SECRET);
    expect(JSON.stringify(razorpay)).not.toContain(WEBHOOK_SECRET);
  });

  describe('createOrder', () => {
    const input = {
      amountMinor: 1_250_000,
      currency: 'INR',
      receipt: 'FLY-ABC123',
    };

    it('posts the amount in paise, INR and our reference as receipt, with Basic auth and a timeout', async () => {
      const fetchStub = stub(
        answer(200, {
          id: 'order_RB58MiP5SPFYyM',
          entity: 'order',
          amount: 1_250_000,
          amount_paid: 0,
          amount_due: 1_250_000,
          currency: 'INR',
          receipt: 'FLY-ABC123',
          status: 'created',
          attempts: 0,
          notes: {},
          created_at: 1756455561,
        }),
      );
      const order = await gateway(fetchStub).createOrder(input);

      expect(order).toEqual({
        providerOrderId: 'order_RB58MiP5SPFYyM',
        amountMinor: 1_250_000,
        currency: 'INR',
        receipt: expect.stringMatching(/^FLY-ABC123-[0-9a-f]{8}$/),
        status: 'created',
        checkoutKeyId: KEY_ID,
      });
      const request = requestOf(fetchStub);
      expect(request.url).toBe(`${RAZORPAY_API_URL}/orders`);
      expect(request.method).toBe('POST');
      expect(request.body).toEqual({
        amount: 1_250_000,
        currency: 'INR',
        receipt: order.receipt,
      });
      expect(request.headers.authorization).toBe(
        `Basic ${Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64')}`,
      );
      expect(request.headers['content-type']).toBe('application/json');
      expect(request.init.signal).toBeInstanceOf(AbortSignal);
      expect(request.init.redirect).toBe('error');
    });

    it("gives each attempt its own receipt, within Razorpay's 40 characters", async () => {
      const order = (receipt: string) => ({
        id: 'order_X',
        amount: 1_250_000,
        currency: 'INR',
        receipt,
        status: 'created',
      });
      const fetchStub = vi.fn<typeof fetch>((_url, init) =>
        Promise.resolve(
          answer(
            200,
            order(
              (JSON.parse(init!.body as string) as { receipt: string }).receipt,
            ),
          ),
        ),
      );
      const razorpay = gateway(fetchStub);
      const first = await razorpay.createOrder(input);
      const second = await razorpay.createOrder(input);
      expect(first.receipt).not.toBe(second.receipt);
      expect(first.receipt.startsWith('FLY-ABC123-')).toBe(true);

      const long = await razorpay.createOrder({
        ...input,
        receipt: 'R'.repeat(60),
      });
      expect(long.receipt).toHaveLength(40);
      expect(long.receipt).toMatch(/^R{31}-[0-9a-f]{8}$/);
    });

    it('refuses an answer for another amount or currency (an existing order handed back)', async () => {
      for (const other of [
        { amount: 500_000, currency: 'INR' },
        { amount: 1_250_000, currency: 'USD' },
      ]) {
        const fetchStub = stub(
          answer(200, { id: 'order_X', status: 'created', ...other }),
        );
        expect(await reasonOf(gateway(fetchStub).createOrder(input))).toBe(
          'INVALID_REQUEST',
        );
      }
    });

    it('refuses fractional, too small or non-INR amounts without calling Razorpay', async () => {
      const fetchStub = stub();
      for (const bad of [
        { ...input, amountMinor: 100.5 },
        { ...input, amountMinor: 99 },
        { ...input, currency: 'USD' },
      ]) {
        expect(await reasonOf(gateway(fetchStub).createOrder(bad))).toBe(
          'INVALID_REQUEST',
        );
      }
      expect(fetchStub).not.toHaveBeenCalled();
    });

    it('is never retried: a 5xx or a timeout is UNAVAILABLE after one call', async () => {
      for (const failure of [
        answer(502, { error: { code: 'GATEWAY_ERROR' } }),
        new DOMException('The operation timed out.', 'TimeoutError'),
      ]) {
        const fetchStub = stub(failure, answer(200, {}));
        expect(await reasonOf(gateway(fetchStub).createOrder(input))).toBe(
          'UNAVAILABLE',
        );
        expect(fetchStub).toHaveBeenCalledTimes(1);
      }
    });

    it("an amount above the account's maximum is AMOUNT_OVER_LIMIT, logged by code and tag only", async () => {
      // Razorpay's test-mode answer, 2026-11-22: reason NA, no field.
      const fetchStub = stub(
        answer(400, {
          error: {
            code: 'BAD_REQUEST_ERROR',
            description: 'Amount exceeds maximum amount allowed.',
            metadata: {},
            reason: 'NA',
            source: 'internal',
            step: 'NA',
          },
        }),
      );
      const error = await gateway(fetchStub)
        .createOrder(input)
        .catch((caught: unknown) => caught);

      expect(fetchStub).toHaveBeenCalledTimes(1);
      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect((error as PaymentGatewayError).reason).toBe('AMOUNT_OVER_LIMIT');
      expect((error as Error).message).not.toContain('exceeds');
      expect(logged()).toContain(
        'createOrder failed (HTTP 400 BAD_REQUEST_ERROR, over limit)',
      );
      expect(logged()).not.toContain('exceeds');
    });

    it('other 400s on an order stay INVALID_REQUEST', async () => {
      const error = await gateway(
        stub(
          answer(400, razorpayError('The amount must be at least INR 1.00')),
        ),
      )
        .createOrder(input)
        .catch((caught: unknown) => caught);

      expect((error as PaymentGatewayError).reason).toBe('INVALID_REQUEST');
    });

    it('an unknown order status is an unreadable answer, not an order', async () => {
      const fetchStub = stub(
        answer(200, {
          id: 'order_X',
          amount: 1_250_000,
          currency: 'INR',
          status: 'expired',
        }),
      );
      expect(await reasonOf(gateway(fetchStub).createOrder(input))).toBe(
        'UNAVAILABLE',
      );
    });
  });

  describe('error mapping', () => {
    it.each([
      [400, 'INVALID_REQUEST'],
      [422, 'INVALID_REQUEST'],
      [404, 'NOT_FOUND'],
      [401, 'UNAVAILABLE'],
      [403, 'UNAVAILABLE'],
      [409, 'UNAVAILABLE'],
      [429, 'UNAVAILABLE'],
      [500, 'UNAVAILABLE'],
      [502, 'UNAVAILABLE'],
      [503, 'UNAVAILABLE'],
    ])('HTTP %i is %s', async (status, reason) => {
      const fetchStub = stub(
        answer(status, razorpayError(`Refused for ${EMAIL}`)),
        answer(status, razorpayError(`Refused for ${EMAIL}`)),
      );
      const error = await gateway(fetchStub)
        .fetchPayment('pay_29QQoUBi66xm2f')
        .catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(PaymentGatewayError);
      expect((error as PaymentGatewayError).reason).toBe(reason);
      // Our message, never Razorpay's description.
      expect((error as Error).message).not.toContain(EMAIL);
      expect((error as Error).message).not.toContain('Refused');
      expect(logged()).toContain(`HTTP ${status} BAD_REQUEST_ERROR`);
      expect(logged()).not.toContain(EMAIL);
    });

    it('a timeout, no connection or an unreadable success is UNAVAILABLE', async () => {
      for (const failure of [
        () => new DOMException('The operation timed out.', 'TimeoutError'),
        () => new TypeError('fetch failed'),
        () => answer(200, '<html>maintenance</html>'),
      ]) {
        const fetchStub = stub(failure(), failure());
        expect(await reasonOf(gateway(fetchStub).fetchPayment('pay_1'))).toBe(
          'UNAVAILABLE',
        );
      }
    });

    it('a read is tried once more when Razorpay could not answer, a refusal is not', async () => {
      const retried = stub(
        answer(503, { error: { code: 'SERVER_ERROR' } }),
        answer(200, paymentAnswer()),
      );
      expect((await gateway(retried).fetchPayment('pay_1')).status).toBe(
        'captured',
      );
      expect(retried).toHaveBeenCalledTimes(2);

      const refused = stub(
        answer(400, razorpayError('The id provided does not exist')),
      );
      expect(await reasonOf(gateway(refused).fetchPayment('pay_1'))).toBe(
        'INVALID_REQUEST',
      );
      expect(refused).toHaveBeenCalledTimes(1);
    });

    it('logs neither the keys nor any request or answer body', async () => {
      const fetchStub = stub(
        answer(400, razorpayError(`${EMAIL} ${CONTACT}`)),
        answer(500, `${VPA} stack trace`),
        answer(500, `${VPA} stack trace`),
      );
      const razorpay = gateway(fetchStub);
      await razorpay
        .createOrder({ amountMinor: 1000, currency: 'INR', receipt: 'FLY-1' })
        .catch(() => null);
      await razorpay.fetchPayment('pay_1').catch(() => null);

      const text = logged();
      for (const secret of [
        KEY_SECRET,
        WEBHOOK_SECRET,
        Buffer.from(`${KEY_ID}:${KEY_SECRET}`).toString('base64'),
        EMAIL,
        CONTACT,
        VPA,
        'FLY-1',
      ]) {
        expect(text).not.toContain(secret);
      }
    });
  });

  describe('fetchPayment', () => {
    it('reads references, amounts, status and the method type only', async () => {
      const fetchStub = stub(
        answer(200, paymentAnswer({ amount_refunded: 10000 })),
      );
      const payment =
        await gateway(fetchStub).fetchPayment('pay_29QQoUBi66xm2f');

      expect(payment).toEqual({
        providerPaymentId: 'pay_29QQoUBi66xm2f',
        providerOrderId: 'order_9A33XWu170gUtm',
        amountMinor: 50000,
        currency: 'INR',
        status: 'captured',
        amountRefundedMinor: 10000,
        method: 'upi',
      });
      const text = JSON.stringify(payment);
      for (const value of [EMAIL, CONTACT, VPA, LAST4, 'Gaurav']) {
        expect(text).not.toContain(value);
      }
      const request = requestOf(fetchStub);
      expect(request.url).toBe(
        `${RAZORPAY_API_URL}/payments/pay_29QQoUBi66xm2f`,
      );
      expect(request.method).toBe('GET');
      expect(request.init.body).toBeUndefined();
    });

    it.each(['created', 'authorized', 'captured', 'failed', 'refunded'])(
      'keeps the status %s',
      async (status) => {
        const fetchStub = stub(answer(200, paymentAnswer({ status })));
        expect((await gateway(fetchStub).fetchPayment('pay_1')).status).toBe(
          status,
        );
      },
    );

    it('an unknown status or a payment with no order is unreadable, never guessed', async () => {
      for (const overrides of [
        { status: 'pending' },
        { order_id: null },
        { amount: '500.00' },
      ]) {
        const fetchStub = stub(
          answer(200, paymentAnswer(overrides)),
          answer(200, paymentAnswer(overrides)),
        );
        expect(await reasonOf(gateway(fetchStub).fetchPayment('pay_1'))).toBe(
          'UNAVAILABLE',
        );
      }
    });

    it('a method type that is not a plain word is left out', async () => {
      const fetchStub = stub(
        answer(200, paymentAnswer({ method: { vpa: VPA } })),
      );
      expect(await gateway(fetchStub).fetchPayment('pay_1')).not.toHaveProperty(
        'method',
      );
    });

    it('an ID that could change the URL path is NOT_FOUND without a call', async () => {
      const fetchStub = stub();
      for (const id of [
        '',
        '../orders',
        'pay_1/refund',
        'pay_1?x=1',
        'pay 1',
      ]) {
        expect(await reasonOf(gateway(fetchStub).fetchPayment(id))).toBe(
          'NOT_FOUND',
        );
      }
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  describe('fetchOrderPayments', () => {
    it('lists the attempts on an order', async () => {
      const fetchStub = stub(
        answer(200, {
          entity: 'collection',
          count: 2,
          items: [
            paymentAnswer({ id: 'pay_failed1', status: 'failed' }),
            paymentAnswer(),
          ],
        }),
      );
      const payments = await gateway(fetchStub).fetchOrderPayments(
        'order_9A33XWu170gUtm',
      );

      expect(
        payments.map((payment) => [payment.providerPaymentId, payment.status]),
      ).toEqual([
        ['pay_failed1', 'failed'],
        ['pay_29QQoUBi66xm2f', 'captured'],
      ]);
      expect(JSON.stringify(payments)).not.toContain(EMAIL);
      expect(requestOf(fetchStub).url).toBe(
        `${RAZORPAY_API_URL}/orders/order_9A33XWu170gUtm/payments`,
      );
    });

    it('an order nobody paid has no attempts', async () => {
      const fetchStub = stub(
        answer(200, { entity: 'collection', count: 0, items: [] }),
      );
      expect(await gateway(fetchStub).fetchOrderPayments('order_1')).toEqual(
        [],
      );
    });

    it('an unreadable item makes the whole answer unreadable', async () => {
      const body = {
        entity: 'collection',
        count: 2,
        items: [paymentAnswer(), paymentAnswer({ status: 'mystery' })],
      };
      const fetchStub = stub(answer(200, body), answer(200, body));
      expect(
        await reasonOf(gateway(fetchStub).fetchOrderPayments('order_1')),
      ).toBe('UNAVAILABLE');
    });
  });

  describe('createRefund', () => {
    const input = {
      providerPaymentId: 'pay_29QQoUBi66xm2f',
      amountMinor: 50000,
      receipt: 'FLY-RF-ABCDEF',
    };

    function refundAnswer(status: unknown) {
      return {
        id: 'rfnd_FP8QHiV938haTz',
        entity: 'refund',
        amount: 50000,
        currency: 'INR',
        payment_id: 'pay_29QQoUBi66xm2f',
        notes: {},
        receipt: 'FLY-RF-ABCDEF',
        acquirer_data: { arn: null },
        created_at: 1597078866,
        status,
        speed_processed: 'normal',
        speed_requested: 'normal',
      };
    }

    it('posts the amount and our refund reference, keyed by it for idempotency', async () => {
      const fetchStub = stub(answer(200, refundAnswer('pending')));
      const refund = await gateway(fetchStub).createRefund(input);

      expect(refund).toEqual({
        providerRefundId: 'rfnd_FP8QHiV938haTz',
        providerPaymentId: 'pay_29QQoUBi66xm2f',
        amountMinor: 50000,
        currency: 'INR',
        status: 'pending',
      });
      const request = requestOf(fetchStub);
      expect(request.url).toBe(
        `${RAZORPAY_API_URL}/payments/pay_29QQoUBi66xm2f/refund`,
      );
      expect(request.method).toBe('POST');
      expect(request.body).toEqual({ amount: 50000, receipt: 'FLY-RF-ABCDEF' });
      expect(request.headers['x-refund-idempotency']).toBe('FLY-RF-ABCDEF');
    });

    it.each([
      ['processed', 'processed'],
      ['failed', 'failed'],
      ['pending', 'pending'],
      ['something_new', 'pending'],
    ])('maps the refund status %s to %s', async (status, expected) => {
      const fetchStub = stub(answer(200, refundAnswer(status)));
      expect((await gateway(fetchStub).createRefund(input)).status).toBe(
        expected,
      );
    });

    it('only a final refusal fails the refund; anything not final leaves it to be asked again', async () => {
      const cases: [Response, string][] = [
        [
          // Only an order is ever over the limit.
          answer(400, razorpayError('Amount exceeds maximum amount allowed.')),
          'INVALID_REQUEST',
        ],
        [
          answer(
            400,
            razorpayError(
              'The refund amount provided is greater than amount captured',
            ),
          ),
          'INVALID_REQUEST',
        ],
        [
          answer(
            400,
            razorpayError('The payment has been fully refunded already.'),
          ),
          'INVALID_REQUEST',
        ],
        [
          answer(
            400,
            razorpayError(
              'The payment status should be captured for action to be taken.',
            ),
          ),
          'INVALID_REQUEST',
        ],
        [
          answer(
            400,
            razorpayError(
              'Your account does not have enough balance to carry out the refund operation.',
            ),
          ),
          'INVALID_REQUEST',
        ],
        // Not final: another operation runs, or a refund with our reference
        // may exist already (its notice settles it).
        [
          answer(
            400,
            razorpayError(
              'Request failed because another payment operation is in progress.',
            ),
          ),
          'UNAVAILABLE',
        ],
        [
          answer(
            400,
            razorpayError('Duplicate receipt found for this refund request.'),
          ),
          'UNAVAILABLE',
        ],
        [answer(409, razorpayError('in progress')), 'UNAVAILABLE'],
        [answer(401, { error: { code: 'BAD_REQUEST_ERROR' } }), 'UNAVAILABLE'],
        [answer(500, { error: { code: 'SERVER_ERROR' } }), 'UNAVAILABLE'],
      ];
      for (const [failure, reason] of cases) {
        const fetchStub = stub(failure, answer(200, refundAnswer('pending')));
        expect(await reasonOf(gateway(fetchStub).createRefund(input))).toBe(
          reason,
        );
        // A write is never retried here.
        expect(fetchStub).toHaveBeenCalledTimes(1);
      }
    });

    it('a payment with no gateway ID is refused without a call', async () => {
      const fetchStub = stub();
      expect(
        await reasonOf(
          gateway(fetchStub).createRefund({ ...input, providerPaymentId: '' }),
        ),
      ).toBe('NOT_FOUND');
      expect(
        await reasonOf(
          gateway(fetchStub).createRefund({ ...input, amountMinor: 0 }),
        ),
      ).toBe('INVALID_REQUEST');
      expect(fetchStub).not.toHaveBeenCalled();
    });
  });

  describe('verifyCheckoutSignature', () => {
    const orderId = 'order_9A33XWu170gUtm';
    const paymentId = 'pay_29QQoUBi66xm2f';
    const valid = hmacSha256Hex(KEY_SECRET, `${orderId}|${paymentId}`);

    it('accepts the HMAC-SHA256 of order_id|payment_id with the key secret', () => {
      expect(
        gateway(stub()).verifyCheckoutSignature({
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          signature: valid,
        }),
      ).toBe(true);
    });

    it('refuses a tampered ID, a wrong secret, the webhook secret, a truncated or empty signature', () => {
      const razorpay = gateway(stub());
      for (const result of [
        {
          providerOrderId: orderId,
          providerPaymentId: 'pay_other',
          signature: valid,
        },
        {
          providerOrderId: 'order_other',
          providerPaymentId: paymentId,
          signature: valid,
        },
        {
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          signature: hmacSha256Hex('another-secret', `${orderId}|${paymentId}`),
        },
        {
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          signature: hmacSha256Hex(WEBHOOK_SECRET, `${orderId}|${paymentId}`),
        },
        {
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          signature: valid.slice(0, -1),
        },
        {
          providerOrderId: orderId,
          providerPaymentId: paymentId,
          signature: '',
        },
      ]) {
        expect(razorpay.verifyCheckoutSignature(result)).toBe(false);
      }
    });
  });

  describe('parseWebhook', () => {
    /** A `payment.captured` notice in Razorpay's shape, personal fields included. */
    const capturedBody = JSON.stringify({
      entity: 'event',
      account_id: 'acc_BFQ7uQEaa7j2z7',
      event: 'payment.captured',
      contains: ['payment'],
      payload: { payment: { entity: paymentAnswer() } },
      created_at: 1567674606,
    });

    function headers(body: string, secret = WEBHOOK_SECRET) {
      return {
        [RAZORPAY_SIGNATURE_HEADER]: hmacSha256Hex(secret, body),
        [RAZORPAY_EVENT_ID_HEADER]: 'KNfRxqfTSr7Hzx',
      };
    }

    it('verifies the signature over the raw body with the webhook secret and keeps references only', () => {
      const result = gateway(stub()).parseWebhook(
        Buffer.from(capturedBody),
        headers(capturedBody),
      );

      expect(result).toEqual({
        ok: true,
        event: {
          providerEventId: 'KNfRxqfTSr7Hzx',
          type: 'payment.captured',
          providerOrderId: 'order_9A33XWu170gUtm',
          providerPaymentId: 'pay_29QQoUBi66xm2f',
          amountMinor: 50000,
          currency: 'INR',
          status: 'captured',
          method: 'upi',
          createdAt: '2019-09-05T09:10:06.000Z',
        },
      });
      const text = JSON.stringify(result);
      for (const value of [
        EMAIL,
        CONTACT,
        VPA,
        LAST4,
        'Gaurav',
        '123456789012',
      ]) {
        expect(text).not.toContain(value);
      }
    });

    it('reads a refund notice, which also carries the payment', () => {
      const body = JSON.stringify({
        entity: 'event',
        event: 'refund.processed',
        contains: ['refund', 'payment'],
        payload: {
          refund: {
            entity: {
              id: 'rfnd_FS8TWyPrCsa0OB',
              entity: 'refund',
              amount: 50000,
              currency: 'INR',
              payment_id: 'pay_FPoJKWQQ8lK13n',
              receipt: 'FLY-RF-ABCDEF',
              status: 'processed',
            },
          },
          payment: { entity: paymentAnswer() },
        },
        created_at: 1597734071,
      });
      const result = gateway(stub()).parseWebhook(
        Buffer.from(body),
        headers(body),
      );
      expect(result.ok && result.event).toMatchObject({
        type: 'refund.processed',
        providerRefundId: 'rfnd_FS8TWyPrCsa0OB',
        providerPaymentId: 'pay_FPoJKWQQ8lK13n',
        receipt: 'FLY-RF-ABCDEF',
        amountMinor: 50000,
        status: 'processed',
      });
      expect(JSON.stringify(result)).not.toContain(EMAIL);
    });

    it('refuses a tampered or re-serialised body, a wrong secret and the key secret', () => {
      const razorpay = gateway(stub());
      const tampered = capturedBody.replace('"amount":50000', '"amount":5');
      const respaced = JSON.stringify(JSON.parse(capturedBody), null, 1);
      for (const [body, signedWith] of [
        [tampered, capturedBody],
        [respaced, capturedBody],
      ]) {
        expect(
          razorpay.parseWebhook(Buffer.from(body), headers(signedWith)),
        ).toEqual({ ok: false, reason: 'signature' });
      }
      for (const secret of ['another-webhook-secret', KEY_SECRET]) {
        expect(
          razorpay.parseWebhook(
            Buffer.from(capturedBody),
            headers(capturedBody, secret),
          ),
        ).toEqual({ ok: false, reason: 'signature' });
      }
    });

    it('without a webhook secret refuses every webhook as unsigned', () => {
      const razorpay = gateway(stub(), null);
      for (const secret of [WEBHOOK_SECRET, '']) {
        expect(
          razorpay.parseWebhook(
            Buffer.from(capturedBody),
            headers(capturedBody, secret),
          ),
        ).toEqual({ ok: false, reason: 'signature' });
      }
    });

    it('a verified body without an event ID is not a well-formed event', () => {
      const result = gateway(stub()).parseWebhook(Buffer.from(capturedBody), {
        [RAZORPAY_SIGNATURE_HEADER]: hmacSha256Hex(
          WEBHOOK_SECRET,
          capturedBody,
        ),
      });
      expect(result).toEqual({ ok: false, reason: 'payload' });
    });
  });
});
