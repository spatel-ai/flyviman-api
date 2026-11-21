import type { IncomingHttpHeaders } from 'node:http';
import type {
  WebhookEvent,
  WebhookEventType,
  WebhookParseResult,
} from './payment-gateway.provider.js';
import { hmacSha256Hex, signatureMatches } from './payment-signature.js';

/**
 * Razorpay's webhook format, shared by the Razorpay adapter and the mock that
 * mirrors it (https://razorpay.com/docs/webhooks/validate-test/): the
 * signature is a hex HMAC-SHA256 of the raw body with the webhook secret, in
 * `x-razorpay-signature`; `x-razorpay-event-id` is unique per event and
 * repeated on a redelivery.
 */
export const RAZORPAY_SIGNATURE_HEADER = 'x-razorpay-signature';
export const RAZORPAY_EVENT_ID_HEADER = 'x-razorpay-event-id';

/**
 * Verifies the signature over the exact bytes received, then reads the
 * event. Nothing in the body is read before the signature matches.
 */
export function parseRazorpayWebhook(
  rawBody: Buffer,
  headers: IncomingHttpHeaders,
  webhookSecret: string,
): WebhookParseResult {
  const signature = headers[RAZORPAY_SIGNATURE_HEADER];
  const expected = hmacSha256Hex(webhookSecret, rawBody);
  if (typeof signature !== 'string' || !signatureMatches(expected, signature)) {
    return { ok: false, reason: 'signature' };
  }
  const eventId = headers[RAZORPAY_EVENT_ID_HEADER];
  if (typeof eventId !== 'string' || !ID.test(eventId)) {
    return { ok: false, reason: 'payload' };
  }
  const event = toEvent(eventId, rawBody);
  return event ? { ok: true, event } : { ok: false, reason: 'payload' };
}

const KNOWN_EVENTS = new Set<WebhookEventType>([
  'payment.captured',
  'payment.failed',
  'refund.processed',
  'refund.failed',
]);

/** A gateway ID, method type, status or refund receipt as we keep it. */
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const METHOD = /^[a-z_]{1,20}$/;
const STATUS = /^[a-z_]{1,20}$/;
const RECEIPT = /^[A-Za-z0-9_-]{1,40}$/;

/**
 * Reads only references, amounts and statuses out of a verified body, in
 * Razorpay's shape. Anything else in it (email, contact, VPA, card, bank,
 * notes) is never read, so it can never be stored or logged. Null when the
 * body is not a well-formed event.
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
  if (
    typeof body.created_at === 'number' &&
    Number.isSafeInteger(body.created_at) &&
    body.created_at > 0
  ) {
    event.createdAt = new Date(body.created_at * 1000).toISOString();
  }
  if (type === 'other') return event;

  const payload = isRecord(body.payload) ? body.payload : {};
  if (type === 'refund.processed' || type === 'refund.failed') {
    const refund = entityOf(payload.refund);
    if (!refund || !isId(refund.id)) return null;
    event.providerRefundId = refund.id;
    if (isId(refund.payment_id)) event.providerPaymentId = refund.payment_id;
    if (typeof refund.receipt === 'string' && RECEIPT.test(refund.receipt)) {
      event.receipt = refund.receipt;
    }
    return withAmount(event, refund);
  }
  const payment = entityOf(payload.payment);
  if (!payment || !isId(payment.id) || !isId(payment.order_id)) return null;
  event.providerPaymentId = payment.id;
  event.providerOrderId = payment.order_id;
  // The method type only; card, bank, wallet and UPI details are never read.
  if (typeof payment.method === 'string' && METHOD.test(payment.method)) {
    event.method = payment.method;
  }
  return withAmount(event, payment);
}

function withAmount(
  event: WebhookEvent,
  entity: Record<string, unknown>,
): WebhookEvent | null {
  const { amount, currency, status } = entity;
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
  if (typeof status === 'string' && STATUS.test(status)) event.status = status;
  return event;
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && ID.test(value);
}

function entityOf(value: unknown): Record<string, unknown> | null {
  return isRecord(value) && isRecord(value.entity) ? value.entity : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
