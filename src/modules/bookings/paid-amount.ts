import type { Prisma } from '../../generated/prisma/client.js';
import {
  PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
} from '../../generated/prisma/enums.js';

/**
 * What a customer has paid towards a booking (M9, W4-1), defined once for
 * the refund due on cancellation, the Model C balance, the confirmation
 * rule and the payments module. Two figures (W5-9d):
 * - credited (`creditedMinor`): the money that arrived towards the price.
 *   What is owed is the total less this, so it never grows because finance
 *   refunded money;
 * - kept (`netPaidMinor`): credited less the refunds of it (goodwill, a
 *   cancellation's). A refund is money returned, not money owed.
 * Extra money (a payment flagged `BOOKING_CLOSED` or `ALREADY_PAID`) is in
 * neither, nor are its refunds: refunding it returns money that was never
 * paid towards the booking. A payment flagged `DUPLICATE_CAPTURE` counts
 * once; its second capture is not on our record (refunded from the
 * gateway's dashboard), so a refund recorded on it returns its own money.
 * The payments table is read here because payments depends on bookings,
 * not the other way round (as `assertNoPaymentPending`).
 */

/** Statuses of a payment whose money arrived. */
export const MONEY_IN: readonly PaymentStatus[] = [
  PaymentStatus.SUCCEEDED,
  PaymentStatus.REFUND_PENDING,
  PaymentStatus.PARTIALLY_REFUNDED,
  PaymentStatus.REFUNDED,
];

/**
 * Money that is not towards the booking: a success for a closed booking, or
 * a second payment for a paid one. Each is refunded in full on its own
 * (the finance queue), so it never counts as paid.
 */
export const EXTRA_MONEY: readonly PaymentReviewReason[] = [
  PaymentReviewReason.BOOKING_CLOSED,
  PaymentReviewReason.ALREADY_PAID,
];

/** A refund that holds money: completed, or still on its way. */
export const REFUND_HOLDS: readonly RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.PENDING,
  RefundStatus.COMPLETED,
];

export interface PaidPayment {
  status: PaymentStatus;
  reviewReason: PaymentReviewReason | null;
  amountMinor: bigint;
  refunds: { status: RefundStatus; amountMinor: bigint }[];
}

/** A payment whose money arrived towards the booking (not extra money). */
function towardsBooking(payment: PaidPayment): boolean {
  return (
    MONEY_IN.includes(payment.status) &&
    !(payment.reviewReason && EXTRA_MONEY.includes(payment.reviewReason))
  );
}

/**
 * Credited towards the booking's price: payments whose money arrived, less
 * extra money. Refunds are not deducted. The Model C balance is the total
 * less this.
 */
export function creditedMinor(payments: readonly PaidPayment[]): bigint {
  return payments
    .filter(towardsBooking)
    .reduce((total, payment) => total + payment.amountMinor, 0n);
}

/**
 * Kept towards the booking: what is credited less every refund completed or
 * under way on it. Never below 0. The refund due on cancellation and the
 * confirmation rule's payment condition read this.
 */
export function netPaidMinor(payments: readonly PaidPayment[]): bigint {
  let paid = 0n;
  for (const payment of payments.filter(towardsBooking)) {
    paid += payment.amountMinor;
    for (const refund of payment.refunds) {
      if (REFUND_HOLDS.includes(refund.status)) paid -= refund.amountMinor;
    }
  }
  return paid > 0n ? paid : 0n;
}

function readPayments(
  db: Pick<Prisma.TransactionClient, 'payment'>,
  bookingId: string,
): Promise<PaidPayment[]> {
  return db.payment.findMany({
    where: { bookingId, status: { in: [...MONEY_IN] } },
    select: {
      status: true,
      reviewReason: true,
      amountMinor: true,
      refunds: { select: { status: true, amountMinor: true } },
    },
  });
}

/** Kept towards the booking (`netPaidMinor`). */
export async function readPaidMinor(
  db: Pick<Prisma.TransactionClient, 'payment'>,
  bookingId: string,
): Promise<bigint> {
  return netPaidMinor(await readPayments(db, bookingId));
}

/** Credited towards the booking's price (`creditedMinor`). */
export async function readCreditedMinor(
  db: Pick<Prisma.TransactionClient, 'payment'>,
  bookingId: string,
): Promise<bigint> {
  return creditedMinor(await readPayments(db, bookingId));
}
