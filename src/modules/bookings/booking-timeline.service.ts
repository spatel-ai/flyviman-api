import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { customerEvent, orderTimeline } from './booking-timeline.js';
import { revealLegacy } from './change-requests.js';
import type { CustomerBookingEventDto } from './dto/customer-booking.dto.js';

/** The customer's own booking timeline (M8). Anyone else's booking is 404. */
@Injectable()
export class BookingTimelineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: FieldCipher,
  ) {}

  async events(
    user: AuthUser,
    reference: string,
  ): Promise<CustomerBookingEventDto[]> {
    const booking = await this.prisma.booking.findFirst({
      where: { reference, customerId: user.id },
      select: {
        id: true,
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        changeRequests: { select: { id: true, details: true } },
      },
    });
    if (!booking) {
      throw new AppException(
        'NOT_FOUND',
        'Booking not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const reveal = (stored: string) => revealLegacy(this.cipher, stored);
    const details = new Map(
      booking.changeRequests.map((row) => [row.id, reveal(row.details)]),
    );
    return orderTimeline(
      booking.events.flatMap((event) => {
        const entry = customerEvent(event, reveal, details);
        return entry ? [entry] : [];
      }),
    );
  }
}
