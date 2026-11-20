import {
  BookingPaymentStatus,
  BookingStatus,
  PaymentModel,
  PaymentPurpose,
  PaymentReviewReason,
  PaymentStatus,
  PriceType,
} from '../../generated/prisma/enums.js';
import type { GatewayPaymentStatus } from '../../integrations/payment/payment-gateway.provider.js';

/**
 * The payment rules (M9), pure so every case is unit tested: what a booking
 * owes now, and how a gateway outcome moves a payment and the booking's
 * payment summary. Never a booking's own status (rule 2).
 */

/** What the amount due is decided on, read with the booking. */
export interface PayableBooking {
  status: BookingStatus;
  priceType: PriceType;
  paymentModel: PaymentModel;
  operatorAccepted: boolean;
  paymentStatus: BookingPaymentStatus;
  totalMinor: bigint;
}

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
 * What the customer pays now. Only a booking `AWAITING_PAYMENT` with a
 * `CONFIRMED` price and nothing paid yet owes anything: an estimate is never
 * charged (rule 1). Model A and B take the full total (B only once the
 * operator has accepted); Model C takes the deposit. The balance after a
 * deposit is not due through this path yet.
 */
export function amountDue(
  booking: PayableBooking,
  depositPercent: number,
): AmountDue {
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
 * `null` when it is already there or past it (refunds come in W4-1).
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
 * closed (a late success), or that another payment had already paid. The
 * payment is still recorded as `SUCCEEDED`; the refund follows (W4-1).
 */
export function reviewOnSuccess(booking: {
  status: BookingStatus;
  paymentStatus: BookingPaymentStatus;
}): PaymentReviewReason | null {
  if (CLOSED.includes(booking.status))
    return PaymentReviewReason.BOOKING_CLOSED;
  if (booking.paymentStatus !== BookingPaymentStatus.UNPAID) {
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
