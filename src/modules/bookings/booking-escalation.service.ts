import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import { BookingEventType } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AdminBookingsService } from './admin-bookings.service.js';
import type { AdminBookingDetailDto } from './dto/admin-booking.dto.js';

/**
 * Operations' escalation flag on a booking (M8-C): set with a reason, and
 * resolved with one. `Booking.escalatedAt` is the flag the admin list
 * filters on; each change writes an `ESCALATED` or `ESCALATION_RESOLVED`
 * event with the reason (encrypted, as other free text on booking events)
 * and an audit record (rule 6), in one transaction
 * under the booking's row lock. The status is untouched.
 */
@Injectable()
export class BookingEscalationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly adminBookings: AdminBookingsService,
    private readonly cipher: FieldCipher,
  ) {}

  escalate(
    user: AuthUser,
    reference: string,
    reason: string,
  ): Promise<AdminBookingDetailDto> {
    return this.change(user, reference, reason, true);
  }

  resolve(
    user: AuthUser,
    reference: string,
    reason: string,
  ): Promise<AdminBookingDetailDto> {
    return this.change(user, reference, reason, false);
  }

  private async change(
    user: AuthUser,
    reference: string,
    reason: string,
    escalate: boolean,
  ): Promise<AdminBookingDetailDto> {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.booking.findUnique({
        where: { reference },
        select: { id: true },
      });
      if (!found) {
        throw new AppException(
          'NOT_FOUND',
          'Booking not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
      const row = await tx.booking.findUniqueOrThrow({
        where: { id: found.id },
        select: { id: true, reference: true, escalatedAt: true },
      });
      if ((row.escalatedAt !== null) === escalate) {
        throw new AppException(
          'BOOKING_ESCALATION_CONFLICT',
          escalate
            ? 'This booking is already escalated.'
            : 'This booking is not escalated.',
          HttpStatus.CONFLICT,
        );
      }
      const escalatedAt = escalate ? new Date() : null;
      await tx.booking.update({
        where: { id: row.id },
        data: { escalatedAt },
      });
      await tx.bookingEvent.create({
        data: {
          bookingId: row.id,
          type: escalate
            ? BookingEventType.ESCALATED
            : BookingEventType.ESCALATION_RESOLVED,
          actorId: user.id,
          actorRole: user.role,
          payload: { reason: this.cipher.encrypt(reason) },
        },
      });
      await this.audit.record(
        {
          action: escalate ? 'booking.escalate' : 'booking.escalation_resolve',
          entityType: 'Booking',
          entityId: row.id,
          before: {
            reference: row.reference,
            escalatedAt: row.escalatedAt?.toISOString() ?? null,
          },
          after: {
            reference: row.reference,
            escalatedAt: escalatedAt?.toISOString() ?? null,
          },
          reason,
        },
        tx,
      );
    });
    return this.adminBookings.detail(user, reference);
  }
}
