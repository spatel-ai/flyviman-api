import type { IncomingHttpHeaders } from 'node:http';

/**
 * The payment gateway, shaped on Razorpay's flow: our server creates an
 * order, the browser pays it in the gateway's checkout, the checkout result
 * is verified by signature, and the gateway confirms the outcome by a signed
 * webhook (or a status fetch). Card data never reaches us: every type here
 * carries gateway references, amounts and statuses only.
 *
 * Money is integer minor units (paise) with an ISO 4217 code, as Razorpay
 * itself takes it. Only the mock exists in this build (PAYMENT_PROVIDER).
 */
export abstract class PaymentGatewayProvider {
  /** The `:provider` segment of `POST /webhooks/payments/:provider`. */
  abstract readonly name: string;

  /** The public key the browser's checkout is opened with. Never a secret. */
  abstract readonly checkoutKeyId: string;

  abstract createOrder(input: CreateOrderInput): Promise<GatewayOrder>;

  /**
   * Whether the checkout result the browser reported was signed by the
   * gateway. A valid signature is still not final: only a verified webhook
   * or a status fetch changes a payment's status.
   */
  abstract verifyCheckoutSignature(result: CheckoutResult): boolean;

  /**
   * Verifies the signature over the exact bytes received, then parses.
   * Nothing in the body is read before the signature has been checked.
   */
  abstract parseWebhook(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): WebhookParseResult;

  abstract createRefund(input: CreateRefundInput): Promise<GatewayRefund>;

  abstract fetchPayment(providerPaymentId: string): Promise<GatewayPayment>;

  /**
   * Every payment attempted on an order (Razorpay: `GET /orders/:id/payments`),
   * for a payment whose gateway payment id never reached us: the status
   * sweep asks by order instead.
   */
  abstract fetchOrderPayments(
    providerOrderId: string,
  ): Promise<GatewayPayment[]>;
}

export interface CreateOrderInput {
  amountMinor: number;
  currency: string;
  /** Our own reference for the order (a booking or payment reference). */
  receipt: string;
}

export type GatewayOrderStatus = 'created' | 'attempted' | 'paid';

export interface GatewayOrder {
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  receipt: string;
  status: GatewayOrderStatus;
  /** The public key the browser's checkout is opened with. Never a secret. */
  checkoutKeyId: string;
}

/** What the gateway's checkout hands the browser after a payment. */
export interface CheckoutResult {
  providerOrderId: string;
  providerPaymentId: string;
  signature: string;
}

export type GatewayPaymentStatus =
  'created' | 'authorized' | 'captured' | 'failed' | 'refunded';

export interface GatewayPayment {
  providerPaymentId: string;
  providerOrderId: string;
  amountMinor: number;
  currency: string;
  status: GatewayPaymentStatus;
  amountRefundedMinor: number;
  /**
   * The method type only (`card`, `upi`, `netbanking`, `wallet`, ...), never
   * a card number, network or holder (rule 10). Absent when not reported.
   */
  method?: string;
}

export interface CreateRefundInput {
  providerPaymentId: string;
  amountMinor: number;
  /**
   * Our own reference for the refund. The gateway repeats it on the refund's
   * notices, so a notice that beats our record of the gateway's refund id is
   * still matched.
   */
  receipt: string;
}

export type GatewayRefundStatus = 'pending' | 'processed' | 'failed';

export interface GatewayRefund {
  providerRefundId: string;
  providerPaymentId: string;
  amountMinor: number;
  currency: string;
  status: GatewayRefundStatus;
}

/** Events the payments module acts on; anything else is `other`. */
export type WebhookEventType =
  | 'payment.captured'
  | 'payment.failed'
  | 'refund.processed'
  | 'refund.failed'
  | 'other';

/**
 * A verified webhook, reduced to gateway references and amounts. Contact
 * details and card fields the gateway sends are dropped here.
 */
export interface WebhookEvent {
  /** De-duplication key: a redelivered event carries the same ID. */
  providerEventId: string;
  type: WebhookEventType;
  providerOrderId?: string;
  providerPaymentId?: string;
  providerRefundId?: string;
  /** A refund's `receipt`: the refund reference we created it with. */
  receipt?: string;
  amountMinor?: number;
  currency?: string;
  /** A payment's method type only (see `GatewayPayment.method`). */
  method?: string;
}

export type WebhookParseResult =
  | { ok: true; event: WebhookEvent }
  | { ok: false; reason: 'signature' | 'payload' };

/**
 * A refused gateway call. `message` is ours and holds no payment or personal
 * data; callers map `reason` to an error code (`PAYMENT_PROVIDER_ERROR`).
 */
export class PaymentGatewayError extends Error {
  constructor(
    readonly reason: 'INVALID_REQUEST' | 'NOT_FOUND' | 'UNAVAILABLE',
    message: string,
  ) {
    super(message);
    this.name = 'PaymentGatewayError';
  }
}
