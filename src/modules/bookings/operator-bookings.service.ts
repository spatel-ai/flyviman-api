import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher, isEncrypted } from '../../common/crypto/field-cipher.js';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { minorToNumber } from '../../common/money.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { BookingStatus, OperatorStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import {
  aircraftWhere,
  assertCan,
  type OperatorAccess,
} from '../operators/operator-access.js';
import { OperatorsService } from '../operators/operators.service.js';
import { parseCancellationTerms, parseItinerary } from './booking-json.js';
import { isQuoteRequest } from './booking-snapshot.js';
import { CANCELLABLE } from './booking-transitions.js';
import { BookingsService } from './bookings.service.js';
import type {
  OperatorBookingDetailDto,
  OperatorBookingQueryDto,
  OperatorBookingSummaryDto,
  OPERATOR_STATUS_MOVES,
} from './dto/operator-booking.dto.js';
import { TripsService } from './trips.service.js';

/** The list's default view: the trips still to fly. */
const UPCOMING: BookingStatus[] = [
  BookingStatus.CONFIRMED,
  BookingStatus.SCHEDULED,
];

/** The statuses in which the operator flies the trip and sees its manifest. */
const MANIFEST: BookingStatus[] = [
  BookingStatus.CONFIRMED,
  BookingStatus.SCHEDULED,
  BookingStatus.COMPLETED,
];

/** Where the first departure lives in the itinerary snapshot. */
const FIRST_DEPARTURE = ['legs', '0', 'departureAt'];

const SUMMARY_INCLUDE = {
  aircraft: { select: { id: true, registration: true } },
} satisfies Prisma.BookingInclude;

type SummaryRow = Prisma.BookingGetPayload<{
  include: typeof SUMMARY_INCLUDE;
}>;

type BookingRow = Prisma.BookingGetPayload<object>;

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Booking not found.',
    HttpStatus.NOT_FOUND,
  );
}

/**
 * The operator's bookings (M8-B): the list and detail of bookings on its
 * aircraft, marking a confirmed trip scheduled and then completed, and
 * cancelling one with a reason. Operator administrators, and staff with
 * "manage bookings" (`MANAGE_BOOKINGS`) on the aircraft in their reach, of
 * an approved operator, as in the request inbox: a missing capability is
 * 403, another operator's booking or one on an aircraft out of reach 404.
 *
 * Status moves go through `BookingsService.transition` (event, audit,
 * notification) as the `OPERATOR` actor, never as an override. A
 * cancellation goes through `TripsService.applyCancellation`, the path the
 * customer's and operations' cancellations take. Passengers are shown as
 * names only, and only while the operator flies the trip; never their
 * documents or assistance notes (rule 8).
 */
@Injectable()
export class OperatorBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly bookings: BookingsService,
    private readonly trips: TripsService,
    private readonly operators: OperatorsService,
    private readonly cipher: FieldCipher,
  ) {}

  async list(
    user: AuthUser,
    query: OperatorBookingQueryDto,
  ): Promise<Paginated<OperatorBookingSummaryDto>> {
    const access = await this.access(user);
    const departure =
      query.departureFrom || query.departureTo
        ? {
            itinerary: {
              path: FIRST_DEPARTURE,
              // Stored as `toISOString()` gives it, so strings compare in time order.
              ...(query.departureFrom
                ? { gte: new Date(query.departureFrom).toISOString() }
                : {}),
              ...(query.departureTo
                ? { lt: new Date(query.departureTo).toISOString() }
                : {}),
            },
          }
        : {};
    const where: Prisma.BookingWhereInput = {
      ...scope(access),
      status: query.status ?? { in: UPCOMING },
      ...(query.aircraftId ? { aircraftId: query.aircraftId } : {}),
      ...departure,
    };
    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: SUMMARY_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.booking.count({ where }),
    ]);
    return new Paginated(
      rows.map((row) => summaryOf(row)),
      query.page,
      query.pageSize,
      total,
    );
  }

  async detail(
    user: AuthUser,
    reference: string,
  ): Promise<OperatorBookingDetailDto> {
    const access = await this.access(user);
    const row = await this.prisma.booking.findFirst({
      where: { reference, ...scope(access) },
      include: {
        ...SUMMARY_INCLUDE,
        passengers: {
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          select: { firstName: true, lastName: true },
        },
      },
    });
    if (!row) throw notFound();
    const now = new Date();
    return {
      ...summaryOf(row),
      itinerary: parseItinerary(row.itinerary),
      cancellationTerms: parseCancellationTerms(row.cancellationTerms),
      specialRequests: this.revealLegacy(row.specialRequests),
      passengers: MANIFEST.includes(row.status)
        ? row.passengers.map((passenger) => ({
            firstName: passenger.firstName,
            lastName: passenger.lastName,
          }))
        : null,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      actions: {
        schedule: row.status === BookingStatus.CONFIRMED,
        complete: row.status === BookingStatus.SCHEDULED && departed(row, now),
        cancel: CANCELLABLE.includes(row.status),
      },
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  /**
   * `CONFIRMED` → `SCHEDULED`, or `SCHEDULED` → `COMPLETED` once the last
   * leg has departed, through the transition function (409
   * `BOOKING_INVALID_TRANSITION` otherwise, or when the booking changed
   * meanwhile).
   */
  async changeStatus(
    user: AuthUser,
    reference: string,
    to: (typeof OPERATOR_STATUS_MOVES)[number],
  ): Promise<OperatorBookingDetailDto> {
    const access = await this.access(user);
    const bookingId = await this.findId(access, reference);
    await this.prisma.$transaction(async (tx) => {
      const row = await lock(tx, bookingId);
      await this.bookings.transition(
        tx,
        row,
        to,
        { kind: 'OPERATOR', user },
        { context: { departed: departed(row, new Date()) } },
      );
    });
    return this.detail(user, reference);
  }

  /**
   * The operator cancels a booking it cannot fly, with a reason (stored
   * encrypted, kept from the customer and the audit trail). The customer is
   * not at fault, so no cancellation charge applies: everything the
   * customer paid and Flyviman still holds is recorded as due back, for
   * finance to refund from its queue (nothing is refunded here, D-183).
   * 409 `BOOKING_NOT_CANCELLABLE` once completed or closed, 409
   * `BOOKING_PAYMENT_IN_PROGRESS` while a payment waits on the gateway.
   */
  async cancel(
    user: AuthUser,
    reference: string,
    reason: string,
    claim: IdempotencyClaim,
  ): Promise<OperatorBookingDetailDto> {
    const access = await this.access(user);
    const bookingId = await this.findId(access, reference);
    await this.prisma.$transaction(async (tx) => {
      await markIdempotencyCommitted(tx, claim);
      const row = await lock(tx, bookingId);
      if (!CANCELLABLE.includes(row.status)) {
        throw new AppException(
          'BOOKING_NOT_CANCELLABLE',
          'This booking can no longer be cancelled.',
          HttpStatus.CONFLICT,
          [{ field: 'status', issue: row.status }],
        );
      }
      const now = new Date();
      // Read under the booking's lock: payments write after locking it too.
      const terms = await this.trips.quoteForCancellation(tx, row, now);
      await this.trips.applyCancellation(
        tx,
        row,
        {
          ...terms,
          appliedCharge: null,
          chargeMinor: 0,
          refundMinor: terms.paidMinor,
          explanation:
            'Cancelled by the operator: no cancellation charge applies.',
        },
        now,
        { kind: 'OPERATOR', user, reason },
      );
    });
    return this.detail(user, reference);
  }

  /**
   * The caller's reach, for staff with `MANAGE_BOOKINGS` (403 otherwise).
   * An operator that is not approved neither reads nor changes bookings:
   * 409 `OPERATOR_NOT_APPROVED`, as in the request inbox.
   */
  private async access(user: AuthUser): Promise<OperatorAccess> {
    const { operator, access } = await this.operators.accessFor(user);
    assertCan(access, 'MANAGE_BOOKINGS');
    if (operator.status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Your company is not approved to take bookings at the moment.',
        HttpStatus.CONFLICT,
      );
    }
    return access;
  }

  private async findId(
    access: OperatorAccess,
    reference: string,
  ): Promise<string> {
    const row = await this.prisma.booking.findFirst({
      where: { reference, ...scope(access) },
      select: { id: true },
    });
    if (!row) throw notFound();
    return row.id;
  }

  /** Special requests saved before they were encrypted are read as stored. */
  private revealLegacy(stored: string | null): string | null {
    return stored === null || !isEncrypted(stored)
      ? stored
      : this.cipher.decrypt(stored);
  }
}

/** The operator's bookings on aircraft within the caller's reach. */
function scope(access: OperatorAccess): Prisma.BookingWhereInput {
  return {
    operatorId: access.operatorId,
    aircraft: aircraftWhere(access),
  };
}

/**
 * The booking, under its request lock and then its row lock, read again:
 * the order every other booking change takes, so a payment, the hold job, a
 * customer's cancellation and this change never interleave.
 */
async function lock(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<BookingRow> {
  const key = `booking_request:${bookingId}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
  return tx.booking.findUniqueOrThrow({ where: { id: bookingId } });
}

/** A trip is flown once its last leg has departed (a round trip's return). */
function departed(row: { itinerary: Prisma.JsonValue }, now: Date): boolean {
  const { legs } = parseItinerary(row.itinerary);
  return Date.parse(legs[legs.length - 1].departureAt) <= now.getTime();
}

function summaryOf(row: SummaryRow): OperatorBookingSummaryDto {
  const itinerary = parseItinerary(row.itinerary);
  return {
    reference: row.reference,
    status: row.status,
    paymentStatus: row.paymentStatus,
    category: row.category,
    aircraft: {
      id: row.aircraft?.id ?? itinerary.aircraft.id,
      registration: row.aircraft?.registration ?? '',
      manufacturer: itinerary.aircraft.manufacturer,
      model: itinerary.aircraft.model,
    },
    legs: itinerary.legs,
    passengerCount: itinerary.passengerCount,
    price: isQuoteRequest(row)
      ? null
      : {
          priceType: row.priceType,
          amountMinor: minorToNumber(row.totalMinor),
          currency: row.currency,
          validUntil: null,
        },
    createdAt: row.createdAt.toISOString(),
  };
}
