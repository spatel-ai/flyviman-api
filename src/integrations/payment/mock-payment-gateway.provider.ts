import type { IncomingHttpHeaders } from 'node:http';
import {
  DEV_PAYMENT_KEY_SECRET,
  DEV_PAYMENT_WEBHOOK_SECRET,
} from '../../config/payment-defaults.js';
import {
  CheckoutResult,
  CreateOrderInput,
  CreateRefundInput,
  GatewayOrder,
  GatewayPayment,
  GatewayRefund,
  PaymentGatewayError,
  PaymentGatewayProvider,
  WebhookParseResult,
} from './payment-gateway.provider.js';
import { hmacSha256Hex, signatureMatches } from './payment-signature.js';
import {
  parseRazorpayWebhook,
  RAZORPAY_EVENT_ID_HEADER,
  RAZORPAY_SIGNATURE_HEADER,
} from './razorpay-webhook.js';

/**
 * The mock's public key ID, and the development secrets it signs with when
 * none are configured (`PAYMENT_KEY_SECRET`, `PAYMENT_WEBHOOK_SECRET`). The
 * development values are in the repository so tests can sign webhooks,
 * which is why the mock must never move real money (PAYMENT_PROVIDER
 * accepts only `mock` in this build).
 */
export const MOCK_PAYMENT_KEY_ID = 'rzp_mock_key';
export const MOCK_PAYMENT_KEY_SECRET = DEV_PAYMENT_KEY_SECRET;
export const MOCK_PAYMENT_WEBHOOK_SECRET = DEV_PAYMENT_WEBHOOK_SECRET;

export interface MockPaymentGatewayOptions {
  keySecret: string;
  webhookSecret: string;
  /**
   * Makes IDs unique per process (`order_mock_<run>_000001`): the counters
   * restart with the process while stored payments outlive it. Empty in
   * unit tests, so they see deterministic IDs.
   */
  runId: string;
}

/** Header names as Razorpay sends them, so the mock is a faithful stand-in. */
export const MOCK_SIGNATURE_HEADER = RAZORPAY_SIGNATURE_HEADER;
export const MOCK_EVENT_ID_HEADER = RAZORPAY_EVENT_ID_HEADER;

/** Razorpay's smallest order: one rupee. Only INR (open decision 13). */
const MIN_AMOUNT_MINOR = 100;
const CURRENCIES = new Set(['INR']);

/** A webhook as the gateway would POST it: exact body and headers. */
export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

export type SimulatedOutcome = 'success' | 'failure';
export type SimulatedRefundOutcome = 'processed' | 'failed';

/** Method types the mock's checkout offers; never card details (rule 10). */
export const MOCK_PAYMENT_METHODS = ['card', 'upi', 'netbanking'] as const;
export type MockPaymentMethod = (typeof MOCK_PAYMENT_METHODS)[number];

export interface SimulatedPayment {
  /** What the checkout hands the browser; none when the payment failed. */
  checkout: CheckoutResult | null;
  /**
   * Never delivered by the mock. The caller posts it when it chooses (a
   * delayed webhook) and as often as it chooses (a duplicate: same event ID).
   */
  webhook: SignedWebhook;
}

/**
 * An in-memory, deterministic gateway for development and every test. IDs
 * come from counters, and nothing depends on the clock or chance. Holds no
 * card, contact or personal data: payloads carry references and amounts only.
 * State is per process and lost on restart.
 */
export class MockPaymentGatewayProvider extends PaymentGatewayProvider {
  readonly name = 'mock';
  readonly checkoutKeyId = MOCK_PAYMENT_KEY_ID;

  private readonly orders = new Map<string, GatewayOrder>();
  private readonly payments = new Map<string, GatewayPayment>();
  private readonly refunds = new Map<
    string,
    GatewayRefund & { receipt: string }
  >();
  private sequence = 0;

  constructor(
    private readonly options: MockPaymentGatewayOptions = {
      keySecret: MOCK_PAYMENT_KEY_SECRET,
      webhookSecret: MOCK_PAYMENT_WEBHOOK_SECRET,
      runId: '',
    },
  ) {
    super();
  }

  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    if (!Number.isInteger(input.amountMinor)) {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'The amount must be whole minor units.',
      );
    }
    if (input.amountMinor < MIN_AMOUNT_MINOR) {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        `The amount must be at least ${MIN_AMOUNT_MINOR} minor units.`,
      );
    }
    if (!CURRENCIES.has(input.currency)) {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'The currency is not supported.',
      );
    }
    const order: GatewayOrder = {
      providerOrderId: this.nextId('order'),
      amountMinor: input.amountMinor,
      currency: input.currency,
      receipt: input.receipt,
      status: 'created',
      checkoutKeyId: MOCK_PAYMENT_KEY_ID,
    };
    this.orders.set(order.providerOrderId, order);
    return { ...order };
  }

  verifyCheckoutSignature(result: CheckoutResult): boolean {
    const expected = hmacSha256Hex(
      this.options.keySecret,
      `${result.providerOrderId}|${result.providerPaymentId}`,
    );
    return signatureMatches(expected, result.signature);
  }

  parseWebhook(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): WebhookParseResult {
    return parseRazorpayWebhook(rawBody, headers, this.options.webhookSecret);
  }

  async createRefund(input: CreateRefundInput): Promise<GatewayRefund> {
    const payment = this.payments.get(input.providerPaymentId);
    if (!payment) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such payment.');
    }
    if (payment.status !== 'captured') {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'Only a captured payment can be refunded.',
      );
    }
    const remaining = payment.amountMinor - payment.amountRefundedMinor;
    if (
      !Number.isInteger(input.amountMinor) ||
      input.amountMinor <= 0 ||
      input.amountMinor > remaining
    ) {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'The refund amount must be positive and no more than the amount not yet refunded.',
      );
    }
    // Reserved at once, as Razorpay does; released if the refund fails.
    payment.amountRefundedMinor += input.amountMinor;
    if (payment.amountRefundedMinor === payment.amountMinor) {
      payment.status = 'refunded';
    }
    // Pending until `simulateRefund` settles it, so the refund's notice is
    // what completes it, as with a real gateway.
    const refund: GatewayRefund = {
      providerRefundId: this.nextId('rfnd'),
      providerPaymentId: payment.providerPaymentId,
      amountMinor: input.amountMinor,
      currency: payment.currency,
      status: 'pending',
    };
    this.refunds.set(refund.providerRefundId, {
      ...refund,
      receipt: input.receipt,
    });
    return refund;
  }

  /**
   * Settles a pending refund as the gateway would and returns its signed
   * notice without sending it (`refund.processed` or `refund.failed`). A
   * failed refund gives its amount back to the payment.
   */
  simulateRefund(
    providerRefundId: string,
    outcome: SimulatedRefundOutcome,
  ): SignedWebhook {
    const refund = this.refunds.get(providerRefundId);
    if (!refund) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such refund.');
    }
    if (refund.status !== 'pending') {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'The refund is already settled.',
      );
    }
    refund.status = outcome;
    if (outcome === 'failed') {
      const payment = this.payments.get(refund.providerPaymentId);
      if (payment) {
        payment.amountRefundedMinor -= refund.amountMinor;
        payment.status = 'captured';
      }
    }
    const body = JSON.stringify({
      entity: 'event',
      event: `refund.${outcome}`,
      contains: ['refund'],
      payload: {
        refund: {
          entity: {
            id: refund.providerRefundId,
            entity: 'refund',
            payment_id: refund.providerPaymentId,
            amount: refund.amountMinor,
            currency: refund.currency,
            receipt: refund.receipt,
            status: outcome,
          },
        },
      },
    });
    return this.signed(body);
  }

  async fetchPayment(providerPaymentId: string): Promise<GatewayPayment> {
    const payment = this.payments.get(providerPaymentId);
    if (!payment) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such payment.');
    }
    return { ...payment };
  }

  async fetchOrderPayments(providerOrderId: string): Promise<GatewayPayment[]> {
    if (!this.orders.has(providerOrderId)) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such order.');
    }
    return [...this.payments.values()]
      .filter((payment) => payment.providerOrderId === providerOrderId)
      .map((payment) => ({ ...payment }));
  }

  /**
   * Pays an order as the checkout would. The gateway's own records (what
   * `fetchPayment` returns) change at once; the webhook is returned, not
   * sent, so a test decides when, and how many times, it arrives.
   */
  simulatePayment(
    providerOrderId: string,
    outcome: SimulatedOutcome,
    method: MockPaymentMethod = 'upi',
  ): SimulatedPayment {
    const order = this.orders.get(providerOrderId);
    if (!order) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such order.');
    }
    if (order.status === 'paid') {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'The order is already paid.',
      );
    }
    const payment: GatewayPayment = {
      providerPaymentId: this.nextId('pay'),
      providerOrderId,
      amountMinor: order.amountMinor,
      currency: order.currency,
      status: outcome === 'success' ? 'captured' : 'failed',
      amountRefundedMinor: 0,
      method,
    };
    this.payments.set(payment.providerPaymentId, payment);
    order.status = outcome === 'success' ? 'paid' : 'attempted';

    const checkout =
      outcome === 'success'
        ? {
            providerOrderId,
            providerPaymentId: payment.providerPaymentId,
            signature: hmacSha256Hex(
              this.options.keySecret,
              `${providerOrderId}|${payment.providerPaymentId}`,
            ),
          }
        : null;
    const webhook = this.signWebhook(
      outcome === 'success' ? 'payment.captured' : 'payment.failed',
      payment,
    );
    return { checkout, webhook };
  }

  /** A Razorpay-shaped payment event, signed with the mock webhook secret. */
  private signWebhook(event: string, payment: GatewayPayment): SignedWebhook {
    const body = JSON.stringify({
      entity: 'event',
      event,
      contains: ['payment'],
      payload: {
        payment: {
          entity: {
            id: payment.providerPaymentId,
            entity: 'payment',
            order_id: payment.providerOrderId,
            amount: payment.amountMinor,
            currency: payment.currency,
            status: payment.status,
            method: payment.method,
          },
        },
      },
    });
    return this.signed(body);
  }

  private signed(body: string): SignedWebhook {
    return {
      body,
      headers: {
        'content-type': 'application/json',
        [MOCK_SIGNATURE_HEADER]: hmacSha256Hex(
          this.options.webhookSecret,
          body,
        ),
        [MOCK_EVENT_ID_HEADER]: this.nextId('evt'),
      },
    };
  }

  private nextId(prefix: string): string {
    this.sequence += 1;
    const run = this.options.runId ? `${this.options.runId}_` : '';
    return `${prefix}_mock_${run}${String(this.sequence).padStart(6, '0')}`;
  }
}
