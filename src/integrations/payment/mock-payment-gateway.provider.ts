import type { IncomingHttpHeaders } from 'node:http';
import {
  DEV_PAYMENT_KEY_SECRET,
  DEV_PAYMENT_WEBHOOK_SECRET,
} from '../../config/env.validation.js';
import {
  CheckoutResult,
  CreateOrderInput,
  CreateRefundInput,
  GatewayOrder,
  GatewayPayment,
  GatewayRefund,
  PaymentGatewayError,
  PaymentGatewayProvider,
  WebhookEvent,
  WebhookEventType,
  WebhookParseResult,
} from './payment-gateway.provider.js';
import { hmacSha256Hex, signatureMatches } from './payment-signature.js';

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
export const MOCK_SIGNATURE_HEADER = 'x-razorpay-signature';
export const MOCK_EVENT_ID_HEADER = 'x-razorpay-event-id';

/** Razorpay's smallest order: one rupee. Only INR (open decision 13). */
const MIN_AMOUNT_MINOR = 100;
const CURRENCIES = new Set(['INR']);

/** A webhook as the gateway would POST it: exact body and headers. */
export interface SignedWebhook {
  body: string;
  headers: Record<string, string>;
}

export type SimulatedOutcome = 'success' | 'failure';

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

  private readonly orders = new Map<string, GatewayOrder>();
  private readonly payments = new Map<string, GatewayPayment>();
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
    const signature = headers[MOCK_SIGNATURE_HEADER];
    const expected = hmacSha256Hex(this.options.webhookSecret, rawBody);
    if (
      typeof signature !== 'string' ||
      !signatureMatches(expected, signature)
    ) {
      return { ok: false, reason: 'signature' };
    }
    const eventId = headers[MOCK_EVENT_ID_HEADER];
    if (typeof eventId !== 'string' || eventId.length === 0) {
      return { ok: false, reason: 'payload' };
    }
    const event = toEvent(eventId, rawBody);
    return event ? { ok: true, event } : { ok: false, reason: 'payload' };
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
    payment.amountRefundedMinor += input.amountMinor;
    if (payment.amountRefundedMinor === payment.amountMinor) {
      payment.status = 'refunded';
    }
    return {
      providerRefundId: this.nextId('rfnd'),
      providerPaymentId: payment.providerPaymentId,
      amountMinor: input.amountMinor,
      currency: payment.currency,
      status: 'processed',
    };
  }

  async fetchPayment(providerPaymentId: string): Promise<GatewayPayment> {
    const payment = this.payments.get(providerPaymentId);
    if (!payment) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such payment.');
    }
    return { ...payment };
  }

  /**
   * Pays an order as the checkout would. The gateway's own records (what
   * `fetchPayment` returns) change at once; the webhook is returned, not
   * sent, so a test decides when, and how many times, it arrives.
   */
  simulatePayment(
    providerOrderId: string,
    outcome: SimulatedOutcome,
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
          },
        },
      },
    });
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

const KNOWN_EVENTS = new Set<WebhookEventType>([
  'payment.captured',
  'payment.failed',
  'refund.processed',
]);

/**
 * Reads only the references and amounts out of a verified body, in
 * Razorpay's shape. Anything else in it (email, contact, card) is ignored.
 * Null when the body is not a well-formed event.
 */
function toEvent(
  providerEventId: string,
  rawBody: Buffer,
): WebhookEvent | null {
  let body: unknown;
  try {
    body = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isRecord(body) || typeof body.event !== 'string') return null;

  const type = KNOWN_EVENTS.has(body.event as WebhookEventType)
    ? (body.event as WebhookEventType)
    : 'other';
  const event: WebhookEvent = { providerEventId, type };
  if (type === 'other') return event;

  const payload = isRecord(body.payload) ? body.payload : {};
  const payment = entityOf(payload.payment);
  const refund = entityOf(payload.refund);
  if (type === 'refund.processed') {
    if (!refund || typeof refund.id !== 'string') return null;
    event.providerRefundId = refund.id;
    if (typeof refund.payment_id === 'string') {
      event.providerPaymentId = refund.payment_id;
    }
    return withAmount(event, refund);
  }
  if (
    !payment ||
    typeof payment.id !== 'string' ||
    typeof payment.order_id !== 'string'
  ) {
    return null;
  }
  event.providerPaymentId = payment.id;
  event.providerOrderId = payment.order_id;
  return withAmount(event, payment);
}

function withAmount(
  event: WebhookEvent,
  entity: Record<string, unknown>,
): WebhookEvent | null {
  const { amount, currency } = entity;
  if (
    typeof amount !== 'number' ||
    !Number.isInteger(amount) ||
    amount < 0 ||
    typeof currency !== 'string'
  ) {
    return null;
  }
  event.amountMinor = amount;
  event.currency = currency;
  return event;
}

function entityOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.entity) ? value.entity : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
