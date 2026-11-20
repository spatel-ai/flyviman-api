import {
  MOCK_EVENT_ID_HEADER,
  MOCK_PAYMENT_KEY_ID,
  MOCK_PAYMENT_WEBHOOK_SECRET,
  MOCK_SIGNATURE_HEADER,
  MockPaymentGatewayProvider,
  SignedWebhook,
} from './mock-payment-gateway.provider.js';
import { PaymentGatewayError } from './payment-gateway.provider.js';
import { hmacSha256Hex, signatureMatches } from './payment-signature.js';

const order = { amountMinor: 1_250_000, currency: 'INR', receipt: 'FV-0001' };

function parse(gateway: MockPaymentGatewayProvider, webhook: SignedWebhook) {
  return gateway.parseWebhook(Buffer.from(webhook.body), webhook.headers);
}

/** Signs a body as the gateway would, with a fresh event ID. */
function signed(body: string, eventId = 'evt_test_1'): SignedWebhook {
  return {
    body,
    headers: {
      [MOCK_SIGNATURE_HEADER]: hmacSha256Hex(MOCK_PAYMENT_WEBHOOK_SECRET, body),
      [MOCK_EVENT_ID_HEADER]: eventId,
    },
  };
}

async function paidOrder(gateway = new MockPaymentGatewayProvider()) {
  const created = await gateway.createOrder(order);
  const paid = gateway.simulatePayment(created.providerOrderId, 'success');
  return { gateway, created, paid };
}

describe('signatureMatches', () => {
  it('matches only the identical value, whatever the length', () => {
    const expected = hmacSha256Hex('secret', 'data');
    expect(signatureMatches(expected, expected)).toBe(true);
    const flipped =
      expected.slice(0, -1) + (expected.endsWith('0') ? '1' : '0');
    expect(signatureMatches(expected, flipped)).toBe(false);
    expect(signatureMatches(expected, expected.slice(1))).toBe(false);
    expect(signatureMatches(expected, '')).toBe(false);
    expect(signatureMatches(expected, undefined)).toBe(false);
  });
});

describe('MockPaymentGatewayProvider', () => {
  describe('createOrder', () => {
    it('creates an order with the amount, currency, receipt and public key', async () => {
      const created = await new MockPaymentGatewayProvider().createOrder(order);

      expect(created).toEqual({
        providerOrderId: 'order_mock_000001',
        amountMinor: 1_250_000,
        currency: 'INR',
        receipt: 'FV-0001',
        status: 'created',
        checkoutKeyId: MOCK_PAYMENT_KEY_ID,
      });
    });

    it('is deterministic: a fresh gateway issues the same IDs', async () => {
      const a = await paidOrder();
      const b = await paidOrder();
      expect(b.created.providerOrderId).toBe(a.created.providerOrderId);
      expect(b.paid).toEqual(a.paid);
    });

    it('signs with the configured secrets and prefixes IDs with its run', async () => {
      const gateway = new MockPaymentGatewayProvider({
        keySecret: 'configured-key-secret',
        webhookSecret: 'configured-webhook-secret',
        runId: 'ab12',
      });
      const created = await gateway.createOrder(order);
      expect(created.providerOrderId).toBe('order_mock_ab12_000001');
      const paid = gateway.simulatePayment(created.providerOrderId, 'success');
      expect(paid.checkout!.signature).toBe(
        hmacSha256Hex(
          'configured-key-secret',
          `${created.providerOrderId}|${paid.checkout!.providerPaymentId}`,
        ),
      );
      expect(parse(gateway, paid.webhook).ok).toBe(true);
      // The development secret no longer verifies.
      expect(parse(gateway, signed(paid.webhook.body))).toEqual({
        ok: false,
        reason: 'signature',
      });
      expect(
        new MockPaymentGatewayProvider().verifyCheckoutSignature(paid.checkout!),
      ).toBe(false);
    });

    it('refuses fractional, too small and non-INR amounts', async () => {
      const gateway = new MockPaymentGatewayProvider();
      for (const input of [
        { ...order, amountMinor: 100.5 },
        { ...order, amountMinor: 99 },
        { ...order, currency: 'USD' },
      ]) {
        await expect(gateway.createOrder(input)).rejects.toBeInstanceOf(
          PaymentGatewayError,
        );
      }
    });
  });

  describe('verifyCheckoutSignature', () => {
    it('accepts the checkout result of a successful payment', async () => {
      const { gateway, paid } = await paidOrder();
      expect(paid.checkout).not.toBeNull();
      expect(gateway.verifyCheckoutSignature(paid.checkout!)).toBe(true);
    });

    it('refuses a tampered order or payment ID, or a forged signature', async () => {
      const { gateway, paid } = await paidOrder();
      const checkout = paid.checkout!;
      expect(
        gateway.verifyCheckoutSignature({
          ...checkout,
          providerPaymentId: 'pay_mock_999999',
        }),
      ).toBe(false);
      expect(
        gateway.verifyCheckoutSignature({
          ...checkout,
          providerOrderId: 'order_mock_999999',
        }),
      ).toBe(false);
      expect(
        gateway.verifyCheckoutSignature({
          ...checkout,
          signature: 'f'.repeat(64),
        }),
      ).toBe(false);
      expect(
        gateway.verifyCheckoutSignature({ ...checkout, signature: '' }),
      ).toBe(false);
    });

    it('gives no checkout result for a failed payment', async () => {
      const gateway = new MockPaymentGatewayProvider();
      const created = await gateway.createOrder(order);
      expect(
        gateway.simulatePayment(created.providerOrderId, 'failure').checkout,
      ).toBeNull();
    });
  });

  describe('parseWebhook', () => {
    it('verifies and parses a captured payment', async () => {
      const { gateway, created, paid } = await paidOrder();
      const result = parse(gateway, paid.webhook);

      expect(result).toEqual({
        ok: true,
        event: {
          providerEventId: paid.webhook.headers[MOCK_EVENT_ID_HEADER],
          type: 'payment.captured',
          providerOrderId: created.providerOrderId,
          providerPaymentId: paid.checkout!.providerPaymentId,
          amountMinor: 1_250_000,
          currency: 'INR',
        },
      });
    });

    it('parses a failed payment', async () => {
      const gateway = new MockPaymentGatewayProvider();
      const created = await gateway.createOrder(order);
      const failed = gateway.simulatePayment(
        created.providerOrderId,
        'failure',
      );

      const result = parse(gateway, failed.webhook);
      expect(result.ok && result.event.type).toBe('payment.failed');
    });

    it('refuses a tampered body, even by one space', async () => {
      const { gateway, paid } = await paidOrder();
      const tampered = paid.webhook.body.replace(
        '"amount":1250000',
        '"amount":1',
      );
      expect(tampered).not.toBe(paid.webhook.body);
      expect(
        parse(gateway, { body: tampered, headers: paid.webhook.headers }),
      ).toEqual({ ok: false, reason: 'signature' });

      const respaced = JSON.stringify(JSON.parse(paid.webhook.body), null, 1);
      expect(
        parse(gateway, { body: respaced, headers: paid.webhook.headers }),
      ).toEqual({ ok: false, reason: 'signature' });
    });

    it('refuses a missing, wrong-secret or repeated signature header', async () => {
      const { gateway, paid } = await paidOrder();
      const { body } = paid.webhook;
      const eventId = paid.webhook.headers[MOCK_EVENT_ID_HEADER];
      for (const signature of [
        undefined,
        hmacSha256Hex('another-secret', body),
        [paid.webhook.headers[MOCK_SIGNATURE_HEADER]],
      ]) {
        expect(
          gateway.parseWebhook(Buffer.from(body), {
            [MOCK_SIGNATURE_HEADER]: signature as string | undefined,
            [MOCK_EVENT_ID_HEADER]: eventId,
          }),
        ).toEqual({ ok: false, reason: 'signature' });
      }
    });

    it('a duplicate delivery verifies again with the same event ID (the de-duplication key)', async () => {
      const { gateway, paid } = await paidOrder();
      const first = parse(gateway, paid.webhook);
      const second = parse(gateway, paid.webhook);

      expect(first.ok && second.ok).toBe(true);
      expect(second).toEqual(first);
    });

    it('a delayed webhook: the status fetch already reports the outcome', async () => {
      const { gateway, paid } = await paidOrder();
      // The webhook has not been delivered yet.
      const payment = await gateway.fetchPayment(
        paid.checkout!.providerPaymentId,
      );
      expect(payment.status).toBe('captured');
      expect(parse(gateway, paid.webhook).ok).toBe(true);
    });

    it('drops card and contact details the gateway sends', () => {
      const gateway = new MockPaymentGatewayProvider();
      const body = JSON.stringify({
        event: 'payment.captured',
        payload: {
          payment: {
            entity: {
              id: 'pay_1',
              order_id: 'order_1',
              amount: 500,
              currency: 'INR',
              email: 'asha@example.com',
              contact: '+919800000000',
              card: { last4: '1111', network: 'Visa' },
            },
          },
        },
      });
      const result = parse(gateway, signed(body));

      expect(result.ok).toBe(true);
      const text = JSON.stringify(result);
      expect(text).not.toContain('asha@example.com');
      expect(text).not.toContain('1111');
      expect(text).not.toContain('+919800000000');
    });

    it('parses a refund event and accepts unknown events as other', () => {
      const gateway = new MockPaymentGatewayProvider();
      const refund = JSON.stringify({
        event: 'refund.processed',
        payload: {
          refund: {
            entity: {
              id: 'rfnd_1',
              payment_id: 'pay_1',
              amount: 200,
              currency: 'INR',
            },
          },
        },
      });
      expect(parse(gateway, signed(refund))).toEqual({
        ok: true,
        event: {
          providerEventId: 'evt_test_1',
          type: 'refund.processed',
          providerRefundId: 'rfnd_1',
          providerPaymentId: 'pay_1',
          amountMinor: 200,
          currency: 'INR',
        },
      });
      expect(
        parse(gateway, signed(JSON.stringify({ event: 'order.paid' }))),
      ).toEqual({
        ok: true,
        event: { providerEventId: 'evt_test_1', type: 'other' },
      });
    });

    it('refuses a signed body that is not a well-formed event', () => {
      const gateway = new MockPaymentGatewayProvider();
      for (const body of [
        'not json',
        '[]',
        JSON.stringify({ event: 'payment.captured', payload: {} }),
        JSON.stringify({
          event: 'payment.captured',
          payload: {
            payment: {
              entity: { id: 'p', order_id: 'o', amount: 1.5, currency: 'INR' },
            },
          },
        }),
      ]) {
        expect(parse(gateway, signed(body))).toEqual({
          ok: false,
          reason: 'payload',
        });
      }
      const noEventId = signed(JSON.stringify({ event: 'order.paid' }));
      delete noEventId.headers[MOCK_EVENT_ID_HEADER];
      expect(parse(gateway, noEventId)).toEqual({
        ok: false,
        reason: 'payload',
      });
    });
  });

  describe('simulatePayment', () => {
    it('refuses to pay an order twice or an unknown order', async () => {
      const { gateway, created } = await paidOrder();
      expect(() =>
        gateway.simulatePayment(created.providerOrderId, 'success'),
      ).toThrow(PaymentGatewayError);
      expect(() => gateway.simulatePayment('order_x', 'success')).toThrow(
        PaymentGatewayError,
      );
    });

    it('lets a failed order be paid on a second attempt', async () => {
      const gateway = new MockPaymentGatewayProvider();
      const created = await gateway.createOrder(order);
      gateway.simulatePayment(created.providerOrderId, 'failure');
      const retry = gateway.simulatePayment(created.providerOrderId, 'success');
      expect(retry.checkout).not.toBeNull();
    });
  });

  describe('createRefund', () => {
    it('refunds in parts up to the captured amount, then refuses', async () => {
      const { gateway, paid } = await paidOrder();
      const providerPaymentId = paid.checkout!.providerPaymentId;

      const part = await gateway.createRefund({
        providerPaymentId,
        amountMinor: 250_000,
        receipt: 'RF-1',
      });
      expect(part).toMatchObject({
        providerPaymentId,
        amountMinor: 250_000,
        currency: 'INR',
        status: 'processed',
      });
      expect(await gateway.fetchPayment(providerPaymentId)).toMatchObject({
        status: 'captured',
        amountRefundedMinor: 250_000,
      });

      await expect(
        gateway.createRefund({
          providerPaymentId,
          amountMinor: 1_000_001,
          receipt: 'RF-2',
        }),
      ).rejects.toThrow(PaymentGatewayError);

      await gateway.createRefund({
        providerPaymentId,
        amountMinor: 1_000_000,
        receipt: 'RF-3',
      });
      expect((await gateway.fetchPayment(providerPaymentId)).status).toBe(
        'refunded',
      );
      await expect(
        gateway.createRefund({
          providerPaymentId,
          amountMinor: 1,
          receipt: 'RF-4',
        }),
      ).rejects.toThrow(PaymentGatewayError);
    });

    it('refuses zero, fractional, failed-payment and unknown-payment refunds', async () => {
      const { gateway, paid } = await paidOrder();
      const providerPaymentId = paid.checkout!.providerPaymentId;
      for (const amountMinor of [0, -1, 10.5]) {
        await expect(
          gateway.createRefund({
            providerPaymentId,
            amountMinor,
            receipt: 'R',
          }),
        ).rejects.toThrow(PaymentGatewayError);
      }

      const created = await gateway.createOrder(order);
      const failed = gateway.simulatePayment(
        created.providerOrderId,
        'failure',
      );
      const failedPaymentId = JSON.parse(failed.webhook.body).payload.payment
        .entity.id as string;
      await expect(
        gateway.createRefund({
          providerPaymentId: failedPaymentId,
          amountMinor: 100,
          receipt: 'R',
        }),
      ).rejects.toThrow(PaymentGatewayError);
      await expect(
        gateway.createRefund({
          providerPaymentId: 'pay_unknown',
          amountMinor: 100,
          receipt: 'R',
        }),
      ).rejects.toMatchObject({ reason: 'NOT_FOUND' });
    });
  });
});
