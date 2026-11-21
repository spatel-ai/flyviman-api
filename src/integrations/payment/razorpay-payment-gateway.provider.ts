import { randomBytes } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { Logger } from '@nestjs/common';
import {
  type CheckoutResult,
  type CreateOrderInput,
  type CreateRefundInput,
  type GatewayOrder,
  type GatewayOrderStatus,
  type GatewayPayment,
  type GatewayPaymentStatus,
  type GatewayRefund,
  type GatewayRefundStatus,
  PaymentGatewayError,
  PaymentGatewayProvider,
  type WebhookParseResult,
} from './payment-gateway.provider.js';
import { hmacSha256Hex, signatureMatches } from './payment-signature.js';
import { parseRazorpayWebhook } from './razorpay-webhook.js';

/** Razorpay's REST API (https://razorpay.com/docs/api/). */
export const RAZORPAY_API_URL = 'https://api.razorpay.com/v1';

/** The longest one call may take, its answer's body included. */
export const RAZORPAY_TIMEOUT_MS = 10_000;

export interface RazorpayGatewayOptions {
  /** `RAZORPAY_KEY_ID`: public, the browser's checkout opens with it. */
  keyId: string;
  /** `RAZORPAY_KEY_SECRET`: API calls and the checkout signature. */
  keySecret: string;
  /**
   * `RAZORPAY_WEBHOOK_SECRET`, set in the Razorpay Dashboard with the
   * webhook. Unset: every webhook is refused as unsigned, and payments are
   * settled by the status sweep alone.
   */
  webhookSecret?: string;
  /** Replaced in unit tests only. */
  fetch?: typeof fetch;
}

/** Razorpay's smallest order: one rupee. Only INR (open decision 13). */
const MIN_AMOUNT_MINOR = 100;
const CURRENCIES = new Set(['INR']);

/** A gateway ID as it may appear in a URL path: no `/`, `.` or `?`. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD = /^[a-z_]{1,20}$/;
/** Razorpay's error `code` (`BAD_REQUEST_ERROR`), the only part logged. */
const ERROR_CODE = /^[A-Z_]{1,40}$/;
/** `X-Refund-Idempotency`: at least 10 letters, digits, `-` or `_`. */
const REFUND_IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{10,}$/;
/** Razorpay's longest order receipt. */
const RECEIPT_MAX_LENGTH = 40;
/**
 * The 400 refusals that are not final, so a refund is never failed for
 * them (https://razorpay.com/docs/api/refunds/create-normal/, errors):
 * "Request failed because another payment operation is in progress." (and
 * its order twin), and "Duplicate receipt found for this refund request.",
 * which means a refund with our reference may exist already: its notice
 * settles it.
 */
const NOT_FINAL_400 = /another \w+ operation is in progress|duplicate receipt/i;

const ORDER_STATUSES = new Set<string>([
  'created',
  'attempted',
  'paid',
] satisfies GatewayOrderStatus[]);
const PAYMENT_STATUSES = new Set<string>([
  'created',
  'authorized',
  'captured',
  'failed',
  'refunded',
] satisfies GatewayPaymentStatus[]);
const REFUND_STATUSES = new Set<string>([
  'pending',
  'processed',
  'failed',
] satisfies GatewayRefundStatus[]);

type Operation =
  'createOrder' | 'fetchPayment' | 'fetchOrderPayments' | 'createRefund';

type Answer =
  | { ok: true; json: Record<string, unknown> }
  | { ok: false; reason: PaymentGatewayError['reason']; detail: string };

/**
 * Razorpay (M9), over its REST API with Basic auth and no SDK. Selected by
 * `PAYMENT_PROVIDER=razorpay`; the mock stays the default and the only
 * gateway in tests.
 *
 * Every call has a timeout. A timeout, no connection, a 5xx, a rate limit or
 * refused credentials is `UNAVAILABLE` (asked again later: a refund stays
 * `REQUESTED`, the sweep retries), never a refusal that would fail a refund.
 * Reads are tried twice; writes once. Nothing from a request or an answer is
 * logged except the operation, the HTTP status and Razorpay's error code;
 * card, contact and UPI details in answers are never read (rule 10).
 *
 * Payments must be captured automatically (Dashboard, payment capture
 * settings): this adapter never captures, and an `authorized` payment is
 * not final.
 */
export class RazorpayPaymentGatewayProvider extends PaymentGatewayProvider {
  readonly name = 'razorpay';
  readonly checkoutKeyId: string;

  private readonly logger = new Logger('RazorpayPaymentGateway');
  readonly #keySecret: string;
  readonly #webhookSecret: string | undefined;
  readonly #authorization: string;
  readonly #fetch: typeof fetch;

  constructor(options: RazorpayGatewayOptions) {
    super();
    this.checkoutKeyId = options.keyId;
    this.#keySecret = options.keySecret;
    this.#webhookSecret = options.webhookSecret || undefined;
    this.#authorization = `Basic ${Buffer.from(
      `${options.keyId}:${options.keySecret}`,
    ).toString('base64')}`;
    this.#fetch = options.fetch ?? fetch;
  }

  /**
   * `POST /orders` (https://razorpay.com/docs/api/orders/create/). The
   * receipt is our reference with a random suffix per attempt
   * (`FLY-BK-ABC234-1f2e3d4c`): Razorpay's documentation says a receipt must
   * be unique, and a booking can have several orders (a retry, a deposit and
   * its balance). Nothing maps back by receipt; our payment is found by the
   * order ID. Never retried: orders take no idempotency key, so a retry
   * after a timeout could make a second order. An order made but not
   * answered stays unpaid; only an order we got back is recorded. An answer
   * for another amount or currency is refused, never offered to the
   * customer.
   */
  async createOrder(input: CreateOrderInput): Promise<GatewayOrder> {
    if (
      !Number.isSafeInteger(input.amountMinor) ||
      input.amountMinor < MIN_AMOUNT_MINOR
    ) {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        `The amount must be whole minor units, at least ${MIN_AMOUNT_MINOR}.`,
      );
    }
    if (!CURRENCIES.has(input.currency)) {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'The currency is not supported.',
      );
    }
    const receipt = attemptReceipt(input.receipt);
    const json = await this.call('createOrder', 'POST', '/orders', {
      amount: input.amountMinor,
      currency: input.currency,
      receipt,
    });
    const { id, amount, currency, status } = json;
    if (
      !isId(id) ||
      !isMinor(amount) ||
      typeof currency !== 'string' ||
      typeof status !== 'string' ||
      !ORDER_STATUSES.has(status)
    ) {
      throw this.unreadable('createOrder');
    }
    if (amount !== input.amountMinor || currency !== input.currency) {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'The gateway answered with an order for another amount.',
      );
    }
    return {
      providerOrderId: id,
      amountMinor: amount,
      currency,
      receipt,
      status: status as GatewayOrderStatus,
      checkoutKeyId: this.checkoutKeyId,
    };
  }

  /**
   * HMAC-SHA256 of `order_id|razorpay_payment_id` with the key secret
   * (https://razorpay.com/docs/payments/payment-gateway/web-integration/standard/build-integration/),
   * compared in constant time.
   */
  verifyCheckoutSignature(result: CheckoutResult): boolean {
    const expected = hmacSha256Hex(
      this.#keySecret,
      `${result.providerOrderId}|${result.providerPaymentId}`,
    );
    return signatureMatches(expected, result.signature);
  }

  parseWebhook(
    rawBody: Buffer,
    headers: IncomingHttpHeaders,
  ): WebhookParseResult {
    if (!this.#webhookSecret) return { ok: false, reason: 'signature' };
    return parseRazorpayWebhook(rawBody, headers, this.#webhookSecret);
  }

  /**
   * `POST /payments/:id/refund`
   * (https://razorpay.com/docs/api/refunds/create-normal/), keyed by our
   * refund reference in `X-Refund-Idempotency`: a repeat after a lost answer
   * returns the same refund instead of a duplicate-receipt refusal.
   */
  async createRefund(input: CreateRefundInput): Promise<GatewayRefund> {
    if (!isId(input.providerPaymentId)) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such payment.');
    }
    if (!Number.isSafeInteger(input.amountMinor) || input.amountMinor <= 0) {
      throw new PaymentGatewayError(
        'INVALID_REQUEST',
        'The refund amount must be positive whole minor units.',
      );
    }
    const json = await this.call(
      'createRefund',
      'POST',
      `/payments/${input.providerPaymentId}/refund`,
      { amount: input.amountMinor, receipt: input.receipt },
      REFUND_IDEMPOTENCY_KEY.test(input.receipt)
        ? { 'x-refund-idempotency': input.receipt }
        : {},
    );
    const { id, payment_id, amount, currency, status } = json;
    if (
      !isId(id) ||
      !isId(payment_id) ||
      !isMinor(amount) ||
      typeof currency !== 'string'
    ) {
      throw this.unreadable('createRefund');
    }
    return {
      providerRefundId: id,
      providerPaymentId: payment_id,
      amountMinor: amount,
      currency,
      // The refund exists at the gateway: a status we do not know yet waits
      // for its notice rather than failing it.
      status:
        typeof status === 'string' && REFUND_STATUSES.has(status)
          ? (status as GatewayRefundStatus)
          : 'pending',
    };
  }

  /** `GET /payments/:id` (https://razorpay.com/docs/api/payments/fetch-with-id/). */
  async fetchPayment(providerPaymentId: string): Promise<GatewayPayment> {
    if (!isId(providerPaymentId)) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such payment.');
    }
    const json = await this.call(
      'fetchPayment',
      'GET',
      `/payments/${providerPaymentId}`,
    );
    const payment = toPayment(json);
    if (!payment) throw this.unreadable('fetchPayment');
    return payment;
  }

  /** `GET /orders/:id/payments` (https://razorpay.com/docs/api/orders/fetch-payments/). */
  async fetchOrderPayments(providerOrderId: string): Promise<GatewayPayment[]> {
    if (!isId(providerOrderId)) {
      throw new PaymentGatewayError('NOT_FOUND', 'No such order.');
    }
    const json = await this.call(
      'fetchOrderPayments',
      'GET',
      `/orders/${providerOrderId}/payments`,
    );
    if (!Array.isArray(json.items)) throw this.unreadable('fetchOrderPayments');
    const payments: GatewayPayment[] = [];
    for (const item of json.items) {
      const payment = isRecord(item) ? toPayment(item) : null;
      if (!payment) throw this.unreadable('fetchOrderPayments');
      payments.push(payment);
    }
    return payments;
  }

  /** One call, a read tried once more if Razorpay could not answer. */
  private async call(
    operation: Operation,
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<Record<string, unknown>> {
    const tries = method === 'GET' ? 2 : 1;
    for (let attempt = 1; ; attempt += 1) {
      const answer = await this.send(method, path, body, headers);
      if (answer.ok) return answer.json;
      if (answer.reason === 'UNAVAILABLE' && attempt < tries) continue;
      this.logger.warn(`Razorpay ${operation} failed (${answer.detail})`);
      throw new PaymentGatewayError(answer.reason, MESSAGES[answer.reason]);
    }
  }

  private async send(
    method: 'GET' | 'POST',
    path: string,
    body: Record<string, unknown> | undefined,
    headers: Record<string, string>,
  ): Promise<Answer> {
    let response: Response;
    let text: string;
    try {
      response = await this.#fetch(`${RAZORPAY_API_URL}${path}`, {
        method,
        headers: {
          authorization: this.#authorization,
          accept: 'application/json',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...headers,
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(RAZORPAY_TIMEOUT_MS),
      });
      text = await response.text();
    } catch {
      // A timeout or no connection. The error's own text is not kept.
      return { ok: false, reason: 'UNAVAILABLE', detail: 'no answer' };
    }
    const json = parseJson(text);
    if (response.ok) {
      return isRecord(json)
        ? { ok: true, json }
        : {
            ok: false,
            reason: 'UNAVAILABLE',
            detail: `HTTP ${response.status}, unreadable`,
          };
    }
    const error = isRecord(json) && isRecord(json.error) ? json.error : null;
    const code =
      typeof error?.code === 'string' && ERROR_CODE.test(error.code)
        ? ` ${error.code}`
        : '';
    // Razorpay's description is read to classify, never kept or logged.
    const notFinal =
      response.status === 400 &&
      typeof error?.description === 'string' &&
      NOT_FINAL_400.test(error.description);
    return {
      ok: false,
      reason: notFinal ? 'UNAVAILABLE' : reasonFor(response.status),
      detail: `HTTP ${response.status}${code}${notFinal ? ', not final' : ''}`,
    };
  }

  private unreadable(operation: Operation): PaymentGatewayError {
    this.logger.warn(`Razorpay ${operation} failed (unreadable answer)`);
    return new PaymentGatewayError('UNAVAILABLE', MESSAGES.UNAVAILABLE);
  }
}

/** Ours, never Razorpay's text, which can repeat what was sent. */
const MESSAGES: Record<PaymentGatewayError['reason'], string> = {
  INVALID_REQUEST: 'The payment gateway refused the request.',
  NOT_FOUND: 'The payment gateway does not know this record.',
  UNAVAILABLE: 'The payment gateway could not be reached.',
};

/**
 * Only a final refusal of the request itself is `INVALID_REQUEST` (a refund
 * marked failed, its amount freed): every 400 except `NOT_FINAL_400`, for
 * example "The refund amount provided is greater than amount captured.",
 * "The payment has been fully refunded already.", "The payment status
 * should be captured for action to be taken." and "Your account does not
 * have enough balance to carry out the refund operation." (no refund is
 * made; finance tops up and refunds again). Our own credentials refused
 * (401, 403), a conflict with an operation in progress (409), a rate limit
 * (429) or Razorpay failing (5xx) is `UNAVAILABLE`: nothing is failed.
 * Razorpay answers an unknown ID with 400, so `NOT_FOUND` is only a 404.
 */
function reasonFor(status: number): PaymentGatewayError['reason'] {
  if (status === 404) return 'NOT_FOUND';
  if ([401, 403, 408, 409, 425, 429].includes(status)) return 'UNAVAILABLE';
  if (status >= 400 && status < 500) return 'INVALID_REQUEST';
  return 'UNAVAILABLE';
}

/** A payment, reduced to references, amounts, status and method type. */
function toPayment(json: Record<string, unknown>): GatewayPayment | null {
  const { id, order_id, amount, currency, status, amount_refunded, method } =
    json;
  const refunded = amount_refunded ?? 0;
  if (
    !isId(id) ||
    !isId(order_id) ||
    !isMinor(amount) ||
    !isMinor(refunded) ||
    typeof currency !== 'string' ||
    typeof status !== 'string' ||
    !PAYMENT_STATUSES.has(status)
  ) {
    return null;
  }
  return {
    providerPaymentId: id,
    providerOrderId: order_id,
    amountMinor: amount,
    currency,
    status: status as GatewayPaymentStatus,
    amountRefundedMinor: refunded,
    ...(typeof method === 'string' && METHOD.test(method) ? { method } : {}),
  };
}

/** Our reference, cut to fit, and 8 random hex characters. */
function attemptReceipt(reference: string): string {
  const suffix = randomBytes(4).toString('hex');
  return `${reference.slice(0, RECEIPT_MAX_LENGTH - suffix.length - 1)}-${suffix}`;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function isMinor(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
