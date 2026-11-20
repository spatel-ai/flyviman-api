import type { Prisma } from '../../generated/prisma/client.js';
import { PaymentStatus } from '../../generated/prisma/enums.js';

/**
 * A payment in progress: one waiting for the gateway's final answer
 * (`PENDING`), so money may be moving. Defined once for the cancellation
 * refusal (`BOOKING_PAYMENT_IN_PROGRESS`), the hold-expiry job, which
 * must not expire a booking the customer is paying for (rules 2 and 5),
 * and the booking's hold, kept while it waits (W5-9d).
 * An order the customer never paid (`INITIATED`) is not one. The payments
 * table is read here because payments depends on bookings, not the other
 * way round (as `paid-amount.ts`).
 */

/**
 * The payments status sweep stops asking the gateway about an order this
 * long after it was created (`PAYMENT_SWEEP_MAX_AGE_HOURS` takes this
 * value), so nothing settles a payment still `PENDING` after it. The
 * hold-expiry job waits for a pending payment only this long.
 */
export const PAYMENT_IN_PROGRESS_MAX_AGE_HOURS = 48;

/** Created after this, a pending payment is still waited for. */
function waitedForSince(now: Date): Date {
  return new Date(
    now.getTime() - PAYMENT_IN_PROGRESS_MAX_AGE_HOURS * 3_600_000,
  );
}

/**
 * The payments in progress. With `now`, only those younger than
 * `PAYMENT_IN_PROGRESS_MAX_AGE_HOURS` (the hold-expiry job); without it,
 * any age (cancellation, unchanged).
 */
export function paymentInProgressWhere(now?: Date): Prisma.PaymentWhereInput {
  return {
    status: PaymentStatus.PENDING,
    ...(now ? { createdAt: { gt: waitedForSince(now) } } : {}),
  };
}

/**
 * Until when a payment created at `createdAt` is waited for: the hold-expiry
 * job waits for it, and the booking's hold is kept for it (W5-9d), until
 * then and no longer. Mirrors `paymentInProgressWhere(now)`.
 */
export function paymentInProgressUntil(createdAt: Date): Date {
  return new Date(
    createdAt.getTime() + PAYMENT_IN_PROGRESS_MAX_AGE_HOURS * 3_600_000,
  );
}

/**
 * Whether a booking's payments keep its lapsed hold from expiring at `now`:
 * one is in progress and not yet stale. Mirrors `paymentInProgressWhere(now)`.
 */
export function holdsHoldExpiry(
  payments: readonly { status: PaymentStatus; createdAt: Date }[],
  now: Date,
): boolean {
  const since = waitedForSince(now);
  return payments.some(
    (payment) =>
      payment.status === PaymentStatus.PENDING && payment.createdAt > since,
  );
}
