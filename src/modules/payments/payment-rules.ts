import {
  BookingPaymentStatus,
  BookingStatus,
  PaymentModel,
  PaymentProvider,
  PaymentPurpose,
  PaymentReviewReason,
  PaymentStatus,
  PriceType,
  RefundStatus,
} from '../../generated/prisma/enums.js';
import type {
  GatewayPaymentStatus,
  PaymentGatewayProvider,
  WebhookEvent,
} from '../../integrations/payment/payment-gateway.provider.js';
import { EXTRA_MONEY } from '../bookings/paid-amount.js';

/**
 * The payment rules (M9), pure so every case is unit tested: what a booking
 * owes now, and how a gateway outcome moves a payment and the booking's
 * payment summary. Never a booking's own status (rule 2).
 */

/** The stored provider of a configured gateway. */
export function providerOf(gateway: PaymentGatewayProvider): PaymentProvider {
  return gateway.name === 'mock'
    ? PaymentProvider.MOCK
    : PaymentProvider.RAZORPAY;
}

/** What the amount due is decided on, read with the booking. */
export interface PayableBooking {
  status: BookingStatus;
  priceType: PriceType;
  paymentModel: PaymentModel;
  operatorAccepted: boolean;
  paymentStatus: BookingPaymentStatus;
  totalMinor: bigint;
  /**
   * Credited towards the price (`bookings/paid-amount.ts`, `creditedMinor`):
   * refunds are not deducted, so a refund never reopens or grows a balance.
   */
  creditedMinor: bigint;
  /** The first departure; the balance is due only before it. */
  departureAt: Date;
}

/** Where a Model C booking may pay its balance after the deposit. */
const BALANCE_OPEN: readonly BookingStatus[] = [
  BookingStatus.AWAITING_PAYMENT,
  BookingStatus.CONFIRMED,
  BookingStatus.SCHEDULED,
];

export type AmountDue =
  | { due: true; purpose: PaymentPurpose; amountMinor: bigint }
  | {
      due: false;
      code: 'PAYMENT_ALREADY_PAID' | 'PAYMENT_NOT_DUE';
      reason: string;
    };

/**
 * The Model C deposit: `percent` (a whole number, 1 to 100) of the total,
 * rounded up to the next paisa, so the deposit is never less than the
 * share configured. 25% of 1,00,001 paise is 25,001 paise.
 */
export function depositMinor(totalMinor: bigint, percent: number): bigint {
  if (!Number.isInteger(percent) || percent < 1 || percent > 100) {
    throw new RangeError(
      'The deposit percent must be a whole number from 1 to 100.',
    );
  }
  if (totalMinor <= 0n) throw new RangeError('The total must be positive.');
  return (totalMinor * BigInt(percent) + 99n) / 100n;
}

/**
 * What the customer pays now. A booking `AWAITING_PAYMENT` with a
 * `CONFIRMED` price and nothing paid owes its first payment: an estimate is
 * never charged (rule 1). Model A and B take the full total (B only once the
 * operator has accepted); Model C takes the deposit. After a Model C
 * deposit, the balance (total less what was paid) is due while the booking
 * is `AWAITING_PAYMENT`, `CONFIRMED` or `SCHEDULED` and before the first
 * departure (W4-1), and only once a deposit counts towards it (W5-9d).
 */
export function amountDue(
  booking: PayableBooking,
  depositPercent: number,
  now: Date,
): AmountDue {
  if (booking.paymentStatus === BookingPaymentStatus.PARTIALLY_PAID) {
    return balanceDue(booking, now);
  }
  if (booking.paymentStatus !== BookingPaymentStatus.UNPAID) {
    return {
      due: false,
      code: 'PAYMENT_ALREADY_PAID',
      reason: `the booking is ${booking.paymentStatus}`,
    };
  }
  if (booking.status !== BookingStatus.AWAITING_PAYMENT) {
    return {
      due: false,
      code: 'PAYMENT_NOT_DUE',
      reason: `the booking is ${booking.status}`,
    };
  }
  if (booking.priceType !== PriceType.CONFIRMED) {
    return {
      due: false,
      code: 'PAYMENT_NOT_DUE',
      reason: 'the price is not confirmed',
    };
  }
  switch (booking.paymentModel) {
    case PaymentModel.A_INSTANT:
      return {
        due: true,
        purpose: PaymentPurpose.FULL,
        amountMinor: booking.totalMinor,
      };
    case PaymentModel.B_OPERATOR_CONFIRMED:
      return booking.operatorAccepted
        ? {
            due: true,
            purpose: PaymentPurpose.FULL,
            amountMinor: booking.totalMinor,
          }
        : {
            due: false,
            code: 'PAYMENT_NOT_DUE',
            reason: 'the operator has not accepted',
          };
    case PaymentModel.C_DEPOSIT:
      return {
        due: true,
        purpose: PaymentPurpose.DEPOSIT,
        amountMinor: depositMinor(booking.totalMinor, depositPercent),
      };
  }
}

/**
 * The Model C balance: the total less what is credited, before departure.
 * Nothing is due while no money counts towards the booking: a deposit
 * flagged for refund (its confirmation was blocked) asks for no balance.
 */
function balanceDue(booking: PayableBooking, now: Date): AmountDue {
  const notDue = (reason: string): AmountDue => ({
    due: false,
    code: 'PAYMENT_NOT_DUE',
    reason,
  });
  if (booking.paymentModel !== PaymentModel.C_DEPOSIT) {
    return notDue('only a deposit booking pays a balance');
  }
  if (!BALANCE_OPEN.includes(booking.status)) {
    return notDue(`the booking is ${booking.status}`);
  }
  if (booking.priceType !== PriceType.CONFIRMED) {
    return notDue('the price is not confirmed');
  }
  if (now.getTime() >= booking.departureAt.getTime()) {
    return notDue('the flight has departed');
  }
  if (booking.creditedMinor <= 0n) {
    return notDue('no deposit counts towards the booking');
  }
  const balance = booking.totalMinor - booking.creditedMinor;
  if (balance <= 0n) {
    return {
      due: false,
      code: 'PAYMENT_ALREADY_PAID',
      reason: 'the total has been paid',
    };
  }
  return { due: true, purpose: PaymentPurpose.BALANCE, amountMinor: balance };
}

/**
 * The money a booking must keep, at the time it is confirmed, for the
 * confirmation rule's payment condition (W5-9d): the deposit for Model C
 * (at the configured percent, as `amountDue` asks for it), the total for A
 * and B. Compared with the money kept (`bookings/paid-amount.ts`,
 * `netPaidMinor`), so a booking finance refunded in part is never
 * confirmed on less. Never throws (it runs inside a payment's transaction).
 */
export function confirmationKeptMinor(
  model: PaymentModel,
  totalMinor: bigint,
  depositPercent: number,
): bigint {
  return model === PaymentModel.C_DEPOSIT && totalMinor > 0n
    ? depositMinor(totalMinor, depositPercent)
    : totalMinor;
}

/**
 * The order a payment's statuses come in. A verified outcome only ever
 * moves a payment forward, so a delayed or out-of-order notice can never
 * undo a later one. `SUCCEEDED` ranks above `FAILED`: a captured retry on
 * the same order means money moved, and that is never discarded; a failure
 * arriving after a success is ignored.
 */
const PAYMENT_RANK: Record<PaymentStatus, number> = {
  INITIATED: 0,
  PENDING: 1,
  FAILED: 2,
  SUCCEEDED: 3,
  REFUND_PENDING: 4,
  PARTIALLY_REFUNDED: 5,
  REFUNDED: 6,
};

/** The payment's new status, or `null` to leave it as it is. */
export function nextPaymentStatus(
  current: PaymentStatus,
  outcome: 'PENDING' | 'FAILED' | 'SUCCEEDED',
): PaymentStatus | null {
  return PAYMENT_RANK[outcome] > PAYMENT_RANK[current] ? outcome : null;
}

const BOOKING_PAYMENT_RANK: Record<BookingPaymentStatus, number> = {
  UNPAID: 0,
  PARTIALLY_PAID: 1,
  PAID: 2,
  REFUND_PENDING: 3,
  REFUNDED: 4,
};

/**
 * The booking's payment summary after a payment of `purpose` succeeded, or
 * `null` when it is already there or past it. Refunds recompute it with
 * `bookingPaymentSummary`.
 */
export function bookingPaymentStatusAfterSuccess(
  current: BookingPaymentStatus,
  purpose: PaymentPurpose,
): BookingPaymentStatus | null {
  const target =
    purpose === PaymentPurpose.DEPOSIT
      ? BookingPaymentStatus.PARTIALLY_PAID
      : BookingPaymentStatus.PAID;
  return BOOKING_PAYMENT_RANK[target] > BOOKING_PAYMENT_RANK[current]
    ? target
    : null;
}

/** Statuses after which a booking takes no more money. */
const CLOSED: readonly BookingStatus[] = [
  BookingStatus.EXPIRED,
  BookingStatus.CANCELLED,
  BookingStatus.QUOTE_DECLINED,
  BookingStatus.OPERATOR_UNAVAILABLE,
];

/**
 * Whether a success needs operations: money arrived for a booking that is
 * closed (a late success), or that another payment had already paid. A
 * balance is expected on a `PARTIALLY_PAID` booking; any other payment only
 * on an `UNPAID` one. The payment is still recorded as `SUCCEEDED`; finance
 * refunds it from the refund queue (W4-1).
 */
export function reviewOnSuccess(
  booking: { status: BookingStatus; paymentStatus: BookingPaymentStatus },
  purpose: PaymentPurpose,
): PaymentReviewReason | null {
  if (CLOSED.includes(booking.status))
    return PaymentReviewReason.BOOKING_CLOSED;
  const expected =
    purpose === PaymentPurpose.BALANCE
      ? BookingPaymentStatus.PARTIALLY_PAID
      : BookingPaymentStatus.UNPAID;
  if (booking.paymentStatus !== expected) {
    return PaymentReviewReason.ALREADY_PAID;
  }
  return null;
}

/**
 * Whether a capture reported with `providerPaymentId` is a second capture
 * on an order whose payment already succeeded with another gateway payment:
 * money moved twice, so operations must be told (`DUPLICATE_CAPTURE`). The
 * same gateway payment reported again is a repeat, not a duplicate.
 */
export function isDuplicateCapture(
  payment: { status: PaymentStatus; providerPaymentId: string | null },
  providerPaymentId: string | undefined,
): boolean {
  return (
    PAYMENT_RANK[payment.status] >= PAYMENT_RANK.SUCCEEDED &&
    payment.providerPaymentId !== null &&
    providerPaymentId !== undefined &&
    providerPaymentId !== payment.providerPaymentId
  );
}

/**
 * The outcome a status fetched from the gateway settles, or `null` while it
 * is not final (`created`, `authorized`). A refund is not an outcome of the
 * payment's own attempt; refunds are handled on their own (W4-1).
 */
export function outcomeOfGatewayStatus(
  status: GatewayPaymentStatus,
): 'SUCCEEDED' | 'FAILED' | null {
  if (status === 'captured') return PaymentStatus.SUCCEEDED;
  if (status === 'failed') return PaymentStatus.FAILED;
  return null;
}

// --- Refunds (W4-1) ---------------------------------------------------------

/** A refund as the refund rules read it. */
export interface RefundAmount {
  status: RefundStatus;
  amountMinor: bigint;
}

/** Payment statuses a refund may be started from: money arrived. */
export const REFUNDABLE: readonly PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.REFUND_PENDING,
  PaymentStatus.PARTIALLY_REFUNDED,
];

const IN_FLIGHT: readonly RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.PENDING,
];

function sum(
  refunds: readonly RefundAmount[],
  statuses: readonly RefundStatus[],
) {
  return refunds
    .filter((refund) => statuses.includes(refund.status))
    .reduce((total, refund) => total + refund.amountMinor, 0n);
}

/**
 * What can still be refunded from a payment: its amount less every refund
 * completed or under way. A failed refund gives its amount back.
 */
export function refundableRemainderMinor(
  amountMinor: bigint,
  refunds: readonly RefundAmount[],
): bigint {
  const held = sum(refunds, [...IN_FLIGHT, RefundStatus.COMPLETED]);
  return amountMinor > held ? amountMinor - held : 0n;
}

/**
 * A succeeded payment's status from its refunds: `REFUND_PENDING` while any
 * is under way, `REFUNDED` once the whole amount came back,
 * `PARTIALLY_REFUNDED` after some did, `SUCCEEDED` when none completed (all
 * failed, or none yet). Derived, not stepped, so a second partial refund
 * from `PARTIALLY_REFUNDED` and a failed refund out of `REFUND_PENDING` are
 * both covered.
 */
export function paymentStatusFromRefunds(
  amountMinor: bigint,
  refunds: readonly RefundAmount[],
): PaymentStatus {
  if (refunds.some((refund) => IN_FLIGHT.includes(refund.status))) {
    return PaymentStatus.REFUND_PENDING;
  }
  const completed = sum(refunds, [RefundStatus.COMPLETED]);
  if (completed >= amountMinor) return PaymentStatus.REFUNDED;
  if (completed > 0n) return PaymentStatus.PARTIALLY_REFUNDED;
  return PaymentStatus.SUCCEEDED;
}

/** A payment as the booking's summary reads it. */
export interface SummaryPayment {
  status: PaymentStatus;
  reviewReason: PaymentReviewReason | null;
  amountMinor: bigint;
  refunds: readonly RefundAmount[];
}

/**
 * The booking's payment summary from all its payments, after a refund moved
 * (state-machines.md: a summary of its payments). Every payment whose money
 * arrived counts, flagged ones too, since their refunds are counted as
 * well; kept is what arrived less the completed refunds:
 * - a refund under way anywhere: `REFUND_PENDING`;
 * - the money kept covers the total: `PAID` (a second payment refunded);
 * - a closed booking with a completed refund: `REFUNDED` (all of it, or the
 *   part above a cancellation charge);
 * - nothing kept: `REFUNDED` once any refund completed, else `UNPAID`;
 * - otherwise, on a live booking, from what is owed (W5-9d): a refund of
 *   extra money (`BOOKING_CLOSED`, `ALREADY_PAID`) returns money that was
 *   never paid towards it, any other refund (goodwill) returns money that is
 *   not owed again. `PAID` when what arrived less refunds of extra money
 *   covers the total (a goodwill refund on a paid booking), else
 *   `PARTIALLY_PAID` (a duplicate deposit refunded leaves the balance due).
 */
export function bookingPaymentSummary(
  totalMinor: bigint,
  payments: readonly SummaryPayment[],
  bookingStatus: BookingStatus,
): BookingPaymentStatus {
  const counted = payments.filter(
    (payment) => PAYMENT_RANK[payment.status] >= PAYMENT_RANK.SUCCEEDED,
  );
  const refunds = counted.flatMap((payment) => payment.refunds);
  if (refunds.some((refund) => IN_FLIGHT.includes(refund.status))) {
    return BookingPaymentStatus.REFUND_PENDING;
  }
  const received = counted.reduce((total, p) => total + p.amountMinor, 0n);
  const refunded = sum(refunds, [RefundStatus.COMPLETED]);
  const kept = received - refunded;
  if (kept >= totalMinor && kept > 0n) return BookingPaymentStatus.PAID;
  if (refunded > 0n && CLOSED.includes(bookingStatus)) {
    return BookingPaymentStatus.REFUNDED;
  }
  if (kept <= 0n) {
    return refunded > 0n
      ? BookingPaymentStatus.REFUNDED
      : BookingPaymentStatus.UNPAID;
  }
  if (CLOSED.includes(bookingStatus)) {
    return BookingPaymentStatus.PARTIALLY_PAID;
  }
  const extraReturned = sum(
    counted
      .filter(
        (payment) =>
          payment.reviewReason !== null &&
          EXTRA_MONEY.includes(payment.reviewReason),
      )
      .flatMap((payment) => payment.refunds),
    [RefundStatus.COMPLETED],
  );
  return received - extraReturned >= totalMinor
    ? BookingPaymentStatus.PAID
    : BookingPaymentStatus.PARTIALLY_PAID;
}

// --- Stored webhook events --------------------------------------------------

/**
 * What `PaymentEvent.payload` keeps of a verified event: these fields and
 * nothing else, whatever an adapter's event carries. The table is
 * append-only, so nothing personal (email, contact, VPA, card) may ever
 * reach it. `providerOrderId` and `providerPaymentId` stay top-level keys:
 * the status sweep reads them (`payload #> '{providerOrderId}'`, index
 * `PaymentEvent_early_notice_order_idx`).
 */
export const STORED_EVENT_FIELDS = [
  'providerEventId',
  'type',
  'providerOrderId',
  'providerPaymentId',
  'providerRefundId',
  'receipt',
  'amountMinor',
  'currency',
  'status',
  'method',
  'createdAt',
] as const satisfies readonly (keyof WebhookEvent)[];

export function storedEventPayload(
  event: WebhookEvent,
): Record<string, string | number> {
  const stored: Record<string, string | number> = {};
  for (const field of STORED_EVENT_FIELDS) {
    if (!Object.hasOwn(event, field)) continue;
    const value: unknown = event[field];
    if (typeof value === 'string' || typeof value === 'number') {
      stored[field] = value;
    }
  }
  return stored;
}
