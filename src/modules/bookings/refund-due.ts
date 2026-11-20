import type { Prisma } from '../../generated/prisma/client.js';
import {
  BookingStatus,
  ChangeRequestKind,
  ChangeRequestStatus,
} from '../../generated/prisma/enums.js';

/** A cancellation that left money due back to the customer. */
export interface CancellationRefundDue {
  bookingId: string;
  bookingReference: string;
  bookingStatus: BookingStatus;
  /** The refund due recorded when it was cancelled (paid less the charge). */
  refundMinor: bigint;
  currency: string;
  /** When it was cancelled; refunds made since count against it. */
  cancelledAt: Date;
}

/**
 * Cancellations recorded with a refund due (W3-2, computed from payments
 * since W4-1), oldest first, for the finance refund queue. Bookings' own
 * table, read for the payments module, which depends on bookings.
 */
export async function cancellationsWithRefundDue(
  db: Pick<Prisma.TransactionClient, 'changeRequest'>,
): Promise<CancellationRefundDue[]> {
  const rows = await db.changeRequest.findMany({
    where: {
      kind: ChangeRequestKind.CANCELLATION,
      status: ChangeRequestStatus.COMPLETED,
      refundMinor: { gt: 0n },
    },
    select: {
      refundMinor: true,
      currency: true,
      decidedAt: true,
      createdAt: true,
      booking: { select: { id: true, reference: true, status: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map((row) => ({
    bookingId: row.booking.id,
    bookingReference: row.booking.reference,
    bookingStatus: row.booking.status,
    refundMinor: row.refundMinor ?? 0n,
    currency: row.currency,
    cancelledAt: row.decidedAt ?? row.createdAt,
  }));
}
