import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { BookingStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { parseCancellationTerms } from './booking-json.js';
import type { BookingDocumentDto } from './dto/booking-documents.dto.js';
import { MONEY_IN } from './paid-amount.js';

/** Statuses in which the booking's confirmation stands. */
const CONFIRMED: readonly BookingStatus[] = [
  BookingStatus.CONFIRMED,
  BookingStatus.SCHEDULED,
  BookingStatus.COMPLETED,
];

/**
 * A booking's documents (M8-C), derived from the booking and its payments:
 * nothing is stored or generated. The confirmation while the booking is
 * confirmed, scheduled or completed; a receipt per payment whose money
 * arrived (the receipt route's own rule); the cancellation terms accepted.
 * Payments are read from their table, as the admin booking detail does: the
 * payments module depends on bookings.
 */
@Injectable()
export class BookingDocumentsService {
  constructor(private readonly prisma: PrismaService) {}

  /** The caller's own booking; anyone else's is 404. */
  async forCustomer(
    user: AuthUser,
    reference: string,
  ): Promise<BookingDocumentDto[]> {
    const booking = await this.prisma.booking.findFirst({
      where: { reference, customerId: user.id },
      select: {
        status: true,
        confirmedAt: true,
        cancellationTerms: true,
        payments: {
          where: { status: { in: [...MONEY_IN] }, paidAt: { not: null } },
          select: { reference: true, paidAt: true },
          orderBy: [{ paidAt: 'asc' }, { id: 'asc' }],
        },
      },
    });
    if (!booking) {
      throw new AppException(
        'NOT_FOUND',
        'Booking not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const confirmed =
      CONFIRMED.includes(booking.status) && booking.confirmedAt !== null;
    const terms = parseCancellationTerms(booking.cancellationTerms);
    return [
      {
        kind: 'CONFIRMATION',
        title: 'Booking confirmation',
        available: confirmed,
        paymentReference: null,
        issuedAt: confirmed ? booking.confirmedAt!.toISOString() : null,
      },
      ...booking.payments.map((payment): BookingDocumentDto => ({
        kind: 'RECEIPT',
        title: `Receipt ${payment.reference}`,
        available: true,
        paymentReference: payment.reference,
        issuedAt: payment.paidAt!.toISOString(),
      })),
      {
        kind: 'CANCELLATION_TERMS',
        title: 'Cancellation terms you accepted',
        available: true,
        paymentReference: null,
        issuedAt: terms.acceptedAt,
      },
    ];
  }
}
