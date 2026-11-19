import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { minorToNumber } from '../../common/money.js';
import { bookingReference } from '../../common/reference.js';
import { day } from '../../common/validation/formats.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  BookingEventType,
  BookingStatus,
  PriceType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { CategoryConfigService } from '../configuration/category-config.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { CANCELLATION_NOTE, SearchService } from '../search/search.service.js';
import { parseCancellationTerms, parseItinerary } from './booking-json.js';
import {
  holdExpiry,
  itineraryFrom,
  lastFour,
  passengerSnapshot,
  requestTerms,
  revalidationOutcome,
} from './booking-snapshot.js';
import {
  afterRequested,
  type BookingActor,
  checkTransition,
  type TransitionContext,
} from './booking-transitions.js';
import type {
  BookingCreatedDto,
  BookingResponseDto,
  CreateBookingDto,
} from './dto/booking.dto.js';

/** Attempts at a fresh reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

/** The fields a status change is decided on, read with the booking. */
type TransitionRow = Pick<
  Prisma.BookingGetPayload<object>,
  | 'id'
  | 'reference'
  | 'status'
  | 'category'
  | 'bookingMode'
  | 'priceType'
  | 'operatorAcceptedAt'
>;

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Booking not found.',
    HttpStatus.NOT_FOUND,
  );
}

/**
 * Bookings (M8). Creation re-checks availability and price (rule 3), is
 * idempotent (rule 5), snapshots the booking and payment modes, the trip,
 * the cancellation terms shown (rule 9) and the passengers, and places a
 * soft hold on the aircraft, all in one transaction. Every status change
 * goes through `transition`, which writes a `BookingEvent` and an audit
 * record. Passenger details never reach the audit trail, events or logs.
 */
@Injectable()
export class BookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly search: SearchService,
    private readonly availability: AvailabilityService,
    private readonly categories: CategoryConfigService,
    private readonly customers: CustomersService,
    private readonly cipher: FieldCipher,
  ) {}

  async create(
    user: AuthUser,
    input: CreateBookingDto,
    claim: IdempotencyClaim,
  ): Promise<BookingCreatedDto> {
    const revalidation = await this.search.revalidate(
      input.searchId,
      input.resultId,
    );
    const passengerIds = input.passengerIds ?? [];
    if (passengerIds.length > revalidation.passengerCount) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The request is not valid.',
        HttpStatus.BAD_REQUEST,
        [
          {
            field: 'passengerIds',
            issue: `must list at most ${revalidation.passengerCount} passengers`,
          },
        ],
      );
    }
    const passengers = await this.customers.passengersByIds(
      user.id,
      passengerIds,
    );

    const outcome = revalidationOutcome(revalidation.current, {
      totalMinor: input.expectedTotalMinor,
      currency: input.currency,
    });
    if (outcome.kind === 'unavailable') throw unavailable();
    if (outcome.kind === 'priceOnRequest') {
      throw new AppException(
        'BOOKING_PRICE_ON_REQUEST',
        'The operator prices this aircraft on request. Send an enquiry and our team will come back to you.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    if (outcome.kind === 'priceChanged') {
      // Fixed field names, so the client reads the new estimate by field.
      throw new AppException(
        'BOOKING_PRICE_CHANGED',
        'The price has changed since you searched.',
        HttpStatus.CONFLICT,
        [
          { field: 'totalMinor', issue: String(outcome.totalMinor) },
          { field: 'currency', issue: outcome.currency },
          { field: 'priceType', issue: PriceType.ESTIMATE },
          { field: 'validUntil', issue: outcome.validUntil.toISOString() },
        ],
      );
    }
    const current = revalidation.current;
    // Narrowed by the outcome; repeated for the compiler.
    if (!current?.priced) throw unavailable();

    const config = await this.categories.resolve(revalidation.category, {
      operatorId: current.operatorId,
    });
    if (!config.isEnabled) {
      throw new AppException(
        'BOOKING_CATEGORY_DISABLED',
        'This service is not taking bookings at the moment.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }

    const itinerary = itineraryFrom(revalidation);
    const snapshots = passengers.map((passenger) =>
      passengerSnapshot(passenger, (plain) => this.cipher.encrypt(plain)),
    );
    const aircraftId = revalidation.result.aircraft.id;

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction(async (tx) => {
          await markIdempotencyCommitted(tx, claim);
          const now = new Date();
          const calculationId = await current.saveCalculation(tx);
          const booking = await tx.booking.create({
            data: {
              reference: bookingReference(),
              customerId: user.id,
              category: revalidation.category,
              status: BookingStatus.REQUESTED,
              bookingMode: config.bookingMode,
              paymentModel: config.paymentModel,
              operatorId: current.operatorId,
              aircraftId,
              itinerary: itinerary as unknown as Prisma.InputJsonValue,
              calculationId,
              totalMinor: BigInt(current.totalMinor),
              currency: current.currency,
              priceType: PriceType.ESTIMATE,
              cancellationTerms: requestTerms(
                CANCELLATION_NOTE,
                now,
              ) as unknown as Prisma.InputJsonValue,
              specialRequests: input.specialRequests ?? null,
            },
          });
          if (snapshots.length > 0) {
            await tx.bookingPassenger.createMany({
              data: snapshots.map((snapshot) => ({
                bookingId: booking.id,
                ...snapshot,
              })),
            });
          }
          const held = await this.availability.placeBookingHold(tx, {
            aircraftId,
            bookingId: booking.id,
            startsAt: current.hold.startsAt,
            endsAt: current.hold.endsAt,
            expiresAt: holdExpiry(now, current.hold.endsAt),
          });
          if (!held) throw unavailable();

          // No passenger data and no special requests: references and money.
          await tx.bookingEvent.create({
            data: {
              bookingId: booking.id,
              type: BookingEventType.STATUS_CHANGED,
              fromStatus: null,
              toStatus: BookingStatus.REQUESTED,
              actorId: user.id,
              actorRole: user.role,
            },
          });
          await this.audit.record(
            {
              action: 'booking.create',
              entityType: 'Booking',
              entityId: booking.id,
              after: {
                reference: booking.reference,
                category: booking.category,
                status: booking.status,
                bookingMode: booking.bookingMode,
                paymentModel: booking.paymentModel,
                operatorId: booking.operatorId,
                aircraftId: booking.aircraftId,
                calculationId,
                totalMinor: current.totalMinor,
                currency: booking.currency,
                priceType: booking.priceType,
                passengerCount: snapshots.length,
              },
            },
            tx,
          );
          const next = afterRequested(contextOf(booking));
          const moved = await this.transition(tx, booking, next, {
            kind: 'SYSTEM',
          });
          return {
            reference: booking.reference,
            status: moved,
            paymentStatus: booking.paymentStatus,
            price: {
              priceType: booking.priceType,
              amountMinor: current.totalMinor,
              currency: booking.currency,
              validUntil: current.validUntil.toISOString(),
            },
            createdAt: booking.createdAt.toISOString(),
          };
        });
      } catch (error) {
        const clash =
          (error as { code?: unknown }).code === 'P2002' &&
          attempt < REFERENCE_ATTEMPTS;
        if (!clash) throw error;
      }
    }
  }

  /** The caller's own booking; anyone else's is not found. */
  async getOwn(user: AuthUser, reference: string): Promise<BookingResponseDto> {
    const booking = await this.prisma.booking.findFirst({
      where: { reference, customerId: user.id },
      include: {
        passengers: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        calculation: { select: { validUntil: true } },
      },
    });
    if (!booking) throw notFound();
    const estimate = booking.priceType === PriceType.ESTIMATE;
    return {
      reference: booking.reference,
      category: booking.category,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      bookingMode: booking.bookingMode,
      paymentModel: booking.paymentModel,
      price: {
        priceType: booking.priceType,
        amountMinor: minorToNumber(booking.totalMinor),
        currency: booking.currency,
        validUntil:
          estimate && booking.calculation
            ? booking.calculation.validUntil.toISOString()
            : null,
      },
      itinerary: parseItinerary(booking.itinerary),
      cancellationTerms: parseCancellationTerms(booking.cancellationTerms),
      specialRequests: booking.specialRequests,
      passengers: booking.passengers.map((passenger) => ({
        firstName: passenger.firstName,
        lastName: passenger.lastName,
        dateOfBirth: day(passenger.dateOfBirth),
        gender: passenger.gender,
        nationality: passenger.nationality,
        documentType: passenger.documentType,
        documentNumberLast4: lastFour(this.reveal(passenger.documentNumber)),
        documentExpiry: day(passenger.documentExpiry),
        specialAssistance: this.reveal(passenger.specialAssistance),
      })),
      createdAt: booking.createdAt.toISOString(),
      updatedAt: booking.updatedAt.toISOString(),
    };
  }

  /**
   * Moves a booking from its current status to `to`, if the status machine
   * allows it (`booking-transitions.ts`), writing a `BookingEvent` and an
   * audit record in the same transaction. Only a booking still in the
   * status that was read is changed, so of two moves at once one wins and
   * the other is 409 `BOOKING_INVALID_TRANSITION`. Returns the new status.
   */
  async transition(
    tx: Prisma.TransactionClient,
    booking: TransitionRow,
    to: BookingStatus,
    actor:
      | { kind: 'SYSTEM' }
      | { kind: Exclude<BookingActor, 'SYSTEM'>; user: AuthUser },
    options: {
      context?: Partial<TransitionContext>;
      override?: { reason: string };
    } = {},
  ): Promise<BookingStatus> {
    const context = { ...contextOf(booking), ...options.context };
    const check = checkTransition(
      booking.status,
      to,
      actor.kind,
      context,
      options.override,
    );
    if (!check.allowed) {
      throw new AppException(
        'BOOKING_INVALID_TRANSITION',
        'This booking cannot move to that status now.',
        HttpStatus.CONFLICT,
        [{ field: 'status', issue: check.reason }],
      );
    }
    const { count } = await tx.booking.updateMany({
      where: { id: booking.id, status: booking.status },
      data: { status: to },
    });
    if (count !== 1) {
      throw new AppException(
        'BOOKING_INVALID_TRANSITION',
        'This booking changed in the meantime. Reload it and try again.',
        HttpStatus.CONFLICT,
      );
    }
    const by = actor.kind === 'SYSTEM' ? null : actor.user;
    const reason = options.override?.reason;
    await tx.bookingEvent.create({
      data: {
        bookingId: booking.id,
        type: BookingEventType.STATUS_CHANGED,
        fromStatus: booking.status,
        toStatus: to,
        actorId: by?.id ?? null,
        actorRole: by?.role ?? null,
        payload: reason ? { override: true, reason } : undefined,
      },
    });
    await this.audit.record(
      {
        action: 'booking.status',
        entityType: 'Booking',
        entityId: booking.id,
        before: { reference: booking.reference, status: booking.status },
        after: { reference: booking.reference, status: to },
        reason,
        // A system move is no person's act, even inside someone's request.
        ...(by ? {} : { actor: null }),
      },
      tx,
    );
    return to;
  }

  /** Decrypts a snapshot field (always written encrypted). */
  private reveal(stored: string | null): string | null {
    return stored === null ? null : this.cipher.decrypt(stored);
  }
}

/** The status machine's view of a booking before anything else is known. */
function contextOf(booking: TransitionRow): TransitionContext {
  return {
    category: booking.category,
    bookingMode: booking.bookingMode,
    priceType: booking.priceType,
    operatorAccepted: booking.operatorAcceptedAt !== null,
    paymentConditionMet: false,
    liveFareRevalidated: false,
    feasibilityComplete: false,
    departed: false,
  };
}

function unavailable(): AppException {
  return new AppException(
    'BOOKING_UNAVAILABLE',
    'This aircraft is no longer available for this trip. Search again to see what is.',
    HttpStatus.CONFLICT,
  );
}
