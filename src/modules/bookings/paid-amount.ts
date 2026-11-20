import type { Prisma } from '../../generated/prisma/client.js';
import {
  PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
} from '../../generated/prisma/enums.js';

/**
 * What a customer has paid towards a booking (M9, W4-1), defined once for
 * the refund due on cancellation, the Model C balance and the payments
 * module. The payments table is read here because payments depends on
 * bookings, not the other way round (as `assertNoPaymentPending`).
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

/**
 * Paid towards the booking: payments whose money arrived, less extra money
 * and less every refund completed or under way on them. Never below 0.
 */
export function netPaidMinor(payments: readonly PaidPayment[]): bigint {
  let paid = 0n;
  for (const payment of payments) {
    if (!MONEY_IN.includes(payment.status)) continue;
    if (payment.reviewReason && EXTRA_MONEY.includes(payment.reviewReason)) {
      continue;
    }
    paid += payment.amountMinor;
    for (const refund of payment.refunds) {
      if (REFUND_HOLDS.includes(refund.status)) paid -= refund.amountMinor;
    }
  }
  return paid > 0n ? paid : 0n;
}

export async function readPaidMinor(
  db: Pick<Prisma.TransactionClient, 'payment'>,
  bookingId: string,
): Promise<bigint> {
  const payments = await db.payment.findMany({
    where: { bookingId, status: { in: [...MONEY_IN] } },
    select: {
      status: true,
      reviewReason: true,
      amountMinor: true,
      refunds: { select: { status: true, amountMinor: true } },
    },
  });
  return netPaidMinor(payments);
}
