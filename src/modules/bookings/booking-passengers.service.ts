import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { BookingStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CustomersService } from '../customers/customers.service.js';
import { parseItinerary } from './booking-json.js';
import { passengerSnapshot } from './booking-snapshot.js';
import type {
  PassengersReplacedDto,
  ReplacePassengersDto,
} from './dto/customer-booking.dto.js';

/**
 * While the customer may change who flies: from the request up to a
 * confirmed booking. Once `SCHEDULED` the operator has finalised the trip.
 */
const EDITABLE: readonly BookingStatus[] = [
  BookingStatus.REQUESTED,
  BookingStatus.OPERATOR_PENDING,
  BookingStatus.CLARIFICATION_REQUESTED,
  BookingStatus.PRICE_CONFIRMED,
  BookingStatus.AWAITING_PAYMENT,
  BookingStatus.CONFIRMED,
];

/**
 * Hours before the first departure after which the passengers are locked,
 * so the operator has its manifest in time. An assumption until the owner
 * settles it (open-decisions.md).
 */
export const PASSENGER_CUTOFF_HOURS = 24;

function locked(issue: string): AppException {
  return new AppException(
    'BOOKING_PASSENGERS_LOCKED',
    'The passengers of this booking can no longer be changed.',
    HttpStatus.CONFLICT,
    [{ field: 'passengerIds', issue }],
  );
}

/**
 * The customer replaces a booking's passengers with saved passengers
 * (M8): the booking's copies are deleted and fresh ones written from the
 * saved passengers as they are now, sensitive fields encrypted, under the
 * booking's lock. Idempotent by key; audited with counts only, never a
 * passenger's details (rule 8).
 */
@Injectable()
export class BookingPassengersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly customers: CustomersService,
    private readonly cipher: FieldCipher,
  ) {}

  async replace(
    user: AuthUser,
    reference: string,
    input: ReplacePassengersDto,
    claim: IdempotencyClaim,
  ): Promise<PassengersReplacedDto> {
    // Ownership of each saved passenger: another customer's is 404.
    const passengers = await this.customers.passengersByIds(
      user.id,
      input.passengerIds,
    );
    const snapshots = passengers.map((passenger) =>
      passengerSnapshot(passenger, (plain) => this.cipher.encrypt(plain)),
    );
    return this.prisma.$transaction(async (tx) => {
      await markIdempotencyCommitted(tx, claim);
      const found = await tx.booking.findFirst({
        where: { reference, customerId: user.id },
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
      const booking = await tx.booking.findUniqueOrThrow({
        where: { id: found.id },
        select: { id: true, reference: true, status: true, itinerary: true },
      });
      if (!EDITABLE.includes(booking.status)) {
        throw locked(`the booking is ${booking.status}`);
      }
      const itinerary = parseItinerary(booking.itinerary);
      const cutoff =
        Date.parse(itinerary.legs[0].departureAt) -
        PASSENGER_CUTOFF_HOURS * 3_600_000;
      if (Date.now() >= cutoff) {
        throw locked(
          `passengers are locked ${PASSENGER_CUTOFF_HOURS} hours before departure`,
        );
      }
      if (snapshots.length > itinerary.passengerCount) {
        throw new AppException(
          'VALIDATION_ERROR',
          'The request is not valid.',
          HttpStatus.BAD_REQUEST,
          [
            {
              field: 'passengerIds',
              issue: `must list at most ${itinerary.passengerCount} passengers`,
            },
          ],
        );
      }
      const { count: before } = await tx.bookingPassenger.deleteMany({
        where: { bookingId: booking.id },
      });
      await tx.bookingPassenger.createMany({
        data: snapshots.map((snapshot) => ({
          bookingId: booking.id,
          ...snapshot,
        })),
      });
      // Counts only: a passenger's details never reach the audit trail.
      await this.audit.record(
        {
          action: 'booking.passengers_replace',
          entityType: 'Booking',
          entityId: booking.id,
          before: { reference: booking.reference, passengerCount: before },
          after: {
            reference: booking.reference,
            passengerCount: snapshots.length,
          },
        },
        tx,
      );
      return {
        reference: booking.reference,
        passengerCount: snapshots.length,
      };
    });
  }
}
