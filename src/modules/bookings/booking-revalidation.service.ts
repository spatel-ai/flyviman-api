import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { PriceType } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CANCELLABLE } from './booking-transitions.js';
import { BookingsService } from './bookings.service.js';
import type {
  BookingRevalidationDto,
  UnavailableReason,
} from './dto/customer-booking.dto.js';

/**
 * `BookingsService.unbookable`'s reasons, in the customer's terms. An
 * operator or aircraft losing its approval (suspended, withdrawn) is
 * Flyviman's business with the operator, not the customer's: it falls
 * through to the generic `UNAVAILABLE`, as does any reason not listed.
 */
const REASONS: Record<string, UnavailableReason> = {
  'the trip has departed': 'DEPARTED',
  'the aircraft time is no longer free': 'TIME_TAKEN',
};

/** A time already past: the hold is checked, never extended or written. */
const CHECK_ONLY = new Date(0);

/**
 * Checks one of the customer's bookings again before they pay or it is
 * confirmed (rule 3), with the confirmation rule's own check
 * (`BookingsService.unbookable`: trip ahead, operator and aircraft approved
 * and in service, held time free), read-only. A `CONFIRMED` price was
 * agreed with the operator and is never repriced; an estimate is not
 * repriced here either (the operator's answer prices it), but one past its
 * validity says so. Nothing is written.
 */
@Injectable()
export class BookingRevalidationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
  ) {}

  async revalidate(
    user: AuthUser,
    reference: string,
  ): Promise<BookingRevalidationDto> {
    const reason = await this.prisma.$transaction(async (tx) => {
      const row = await tx.booking.findFirst({
        where: { reference, customerId: user.id },
      });
      if (!row) {
        throw new AppException(
          'NOT_FOUND',
          'Booking not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (!CANCELLABLE.includes(row.status)) return 'CLOSED' as const;
      const why = await this.bookings.unbookable(tx, row, CHECK_ONLY);
      return why === null ? null : (REASONS[why] ?? 'UNAVAILABLE');
    });
    // The price and the amount due as the trip page shows them.
    const booking = await this.bookings.getOwn(user, reference);
    const now = new Date();
    const price = booking.price;
    return {
      available: reason === null,
      reason,
      price,
      priceExpired:
        price?.priceType === PriceType.ESTIMATE &&
        price.validUntil !== null &&
        Date.parse(price.validUntil) <= now.getTime(),
      amountDue: reason === null ? booking.amountDue : null,
      checkedAt: now.toISOString(),
    };
  }
}
