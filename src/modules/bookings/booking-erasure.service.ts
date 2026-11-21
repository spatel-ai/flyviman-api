import { Injectable } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import {
  ERASED_TEXT,
  type ErasureFacts,
  SCRUBBED_BOOKING_PASSENGER,
} from '../../common/erasure.js';
import type { Prisma } from '../../generated/prisma/client.js';

/**
 * A customer's bookings in an erasure of their personal data (W5-8b,
 * `modules/privacy`). Payments and refunds are read here for the decision,
 * as `paid-amount.ts` does: the payments module depends on bookings, not
 * the other way round.
 */
@Injectable()
export class BookingErasureService {
  constructor(private readonly cipher: FieldCipher) {}

  /**
   * Locks each of the customer's bookings as every booking change does (its
   * request lock, `booking_request:<id>`, then its row), by id, after the
   * customer's lock and before their account row: a change that holds a
   * booking finishes first, even one that then queues a notification for
   * the customer. No booking can be added meanwhile (creation takes the
   * customer's lock).
   */
  async lockAll(
    customerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<void> {
    const rows = await tx.booking.findMany({
      where: { customerId },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const { id } of rows) {
      const key = `booking_request:${id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE "id" = ${id}::uuid FOR UPDATE`;
    }
  }

  /** The customer's bookings, their payments and refunds, for the decision. */
  async facts(
    customerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<Pick<ErasureFacts, 'bookings' | 'payments' | 'refunds'>> {
    const bookings = await tx.booking.findMany({
      where: { customerId },
      select: { status: true, paymentStatus: true, updatedAt: true },
    });
    const payments = await tx.payment.findMany({
      where: { booking: { customerId } },
      select: {
        status: true,
        reviewReason: true,
        refunds: { select: { status: true } },
      },
    });
    return {
      bookings,
      payments: payments.map(({ status, reviewReason }) => ({
        status,
        reviewReason,
      })),
      refunds: payments.flatMap((payment) => payment.refunds),
    };
  }

  /**
   * Scrubs the personal data of the customer's bookings, in the caller's
   * transaction, once the caller has found them all closed. Kept for the
   * legal and financial record: references, itinerary, statuses, amounts,
   * payments, settlements, the cancellation terms shown and the number of
   * passengers. Gone: each passenger's identity (the snapshot row stays as
   * a placeholder), the special requests, the cancellation reason and the
   * free text of change requests. The timeline (`BookingEvent`) is
   * append-only and keeps its encrypted free text.
   */
  async erase(
    customerId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ bookings: number; passengers: number; changeRequests: number }> {
    const ofCustomer = { customerId };
    const bookings = await tx.booking.updateMany({
      where: ofCustomer,
      data: { specialRequests: null, cancellationReason: null },
    });
    const passengers = await tx.bookingPassenger.updateMany({
      where: { booking: ofCustomer },
      data: SCRUBBED_BOOKING_PASSENGER,
    });
    // Required and read as ciphertext, so the placeholder is encrypted too.
    const changeRequests = await tx.changeRequest.updateMany({
      where: { booking: ofCustomer },
      data: { details: this.cipher.encrypt(ERASED_TEXT) },
    });
    return {
      bookings: bookings.count,
      passengers: passengers.count,
      changeRequests: changeRequests.count,
    };
  }
}
