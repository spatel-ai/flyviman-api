import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { minorToNumber } from '../../common/money.js';
import { bookingReference } from '../../common/reference.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  BookingEventType,
  BookingStatus,
  PriceType,
  ServiceCategory,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { CategoryConfigService } from '../configuration/category-config.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { BOOKING_ENDED } from '../empty-legs/empty-leg-rules.js';
import {
  type BookableOffer,
  EmptyLegsService,
} from '../empty-legs/empty-legs.service.js';
import { CancellationTermsService } from '../pricing/cancellation-terms.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import { type Itinerary, parseItinerary } from './booking-json.js';
import {
  holdExpiry,
  passengerSnapshot,
  requestTerms,
} from './booking-snapshot.js';
import { afterRequested } from './booking-transitions.js';
import { BookingsService, OPEN_STATUSES } from './bookings.service.js';
import type { BookingCreatedDto } from './dto/booking.dto.js';
import type { CreateEmptyLegBookingDto } from './dto/empty-leg-booking.dto.js';

/** Attempts at a fresh reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

function unavailable(): AppException {
  return new AppException(
    'BOOKING_UNAVAILABLE',
    'This empty leg is no longer available. Other offers may suit you.',
    HttpStatus.CONFLICT,
  );
}

/**
 * Whether a write failed on `Booking_one_live_per_empty_leg`, the partial
 * unique index behind one live booking per offer. Through adapter-pg the
 * index name is at `meta.driverAdapterError.cause.constraint.index`
 * (checked against PostgreSQL, D-199).
 */
export function violatesLiveEmptyLeg(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    meta?: {
      driverAdapterError?: { cause?: { constraint?: { index?: unknown } } };
    };
  };
  return (
    e.code === 'P2002' &&
    e.meta?.driverAdapterError?.cause?.constraint?.index ===
      'Booking_one_live_per_empty_leg'
  );
}

function invalid(field: string, issue: string): AppException {
  return new AppException(
    'VALIDATION_ERROR',
    'The request is not valid.',
    HttpStatus.BAD_REQUEST,
    [{ field, issue }],
  );
}

/** The trip a booking of the offer copies, checked against the written shape. */
function itineraryOf(offer: BookableOffer, passengerCount: number): Itinerary {
  return parseItinerary({
    version: 1,
    source: 'EMPTY_LEG',
    searchId: null,
    resultId: null,
    tripType: 'ONE_WAY',
    passengerCount,
    legs: [
      {
        originId: offer.origin.id,
        originName: offer.origin.name,
        destinationId: offer.destination.id,
        destinationName: offer.destination.name,
        departureAt: offer.departureFrom.toISOString(),
      },
    ],
    roundTripStrategy: null,
    aircraft: offer.aircraft,
    operatorName: offer.operatorName,
    distanceKm: offer.distanceKm ?? 0,
    flightMinutes: null,
    emptyLeg: {
      id: offer.id,
      reference: offer.reference,
      departureTo: offer.departureTo.toISOString(),
      conditions: offer.conditions,
    },
  });
}

/**
 * Booking requests for empty-leg offers (M8-C). In one transaction, after
 * the customer's lock and then the offer's row lock: the offer is listed
 * (rule 4) and not yet in its window, has no live booking (the partial
 * unique index `Booking_one_live_per_empty_leg` is the backstop), the price
 * is the offer's (rule 3; labelled `QUOTE`, the operator's own price, until
 * the operator accepts it; stored as a calculation split into tax,
 * commission and operator payable, `PricingService.priceEmptyLeg`), Flyviman's cancellation tiers are the version
 * shown (rule 9), the offer is the version the customer read
 * (`offerUpdatedAt`: price, seats, window and conditions), and the aircraft
 * is held over the departure window. The booking then moves as any request does: `OPERATOR_PENDING`, which tells
 * the operator. Idempotent (rule 5).
 */
@Injectable()
export class EmptyLegBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly emptyLegs: EmptyLegsService,
    private readonly availability: AvailabilityService,
    private readonly categories: CategoryConfigService,
    private readonly customers: CustomersService,
    private readonly cancellationTerms: CancellationTermsService,
    private readonly pricing: PricingService,
    private readonly cipher: FieldCipher,
    private readonly config: ConfigService,
  ) {}

  async create(
    user: AuthUser,
    input: CreateEmptyLegBookingDto,
    claim: IdempotencyClaim,
  ): Promise<BookingCreatedDto> {
    const passengerIds = input.passengerIds ?? [];
    if (passengerIds.length > input.passengerCount) {
      throw invalid(
        'passengerIds',
        `must list at most ${input.passengerCount} passengers`,
      );
    }
    const passengers = await this.customers.passengersByIds(
      user.id,
      passengerIds,
    );
    const snapshots = passengers.map((passenger) =>
      passengerSnapshot(passenger, (plain) => this.cipher.encrypt(plain)),
    );
    const specialRequests =
      input.specialRequests === undefined
        ? null
        : this.cipher.encrypt(input.specialRequests);
    const maxOpen = this.config.getOrThrow<number>(
      'BOOKING_MAX_OPEN_PER_CUSTOMER',
    );
    const holdHours = this.config.getOrThrow<number>('BOOKING_HOLD_HOURS');

    for (let attempt = 1; ; attempt += 1) {
      try {
        return await this.prisma.$transaction((tx) =>
          this.createIn(tx, user, input, claim, {
            snapshots,
            specialRequests,
            maxOpen,
            holdHours,
          }),
        );
      } catch (error) {
        if ((error as { code?: unknown }).code !== 'P2002') throw error;
        // The offer's lock makes this unreachable in practice; the index
        // answers a second live booking of the offer as unavailable.
        if (violatesLiveEmptyLeg(error)) throw unavailable();
        if (attempt >= REFERENCE_ATTEMPTS) throw error;
      }
    }
  }

  private async createIn(
    tx: Prisma.TransactionClient,
    user: AuthUser,
    input: CreateEmptyLegBookingDto,
    claim: IdempotencyClaim,
    prepared: {
      snapshots: ReturnType<typeof passengerSnapshot>[];
      specialRequests: string | null;
      maxOpen: number;
      holdHours: number;
    },
  ): Promise<BookingCreatedDto> {
    await markIdempotencyCommitted(tx, claim);
    // The customer's lock first, as for a search booking, then the offer's,
    // then the aircraft's (`placeBookingHold`).
    const key = `booking_customer:${user.id}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const open = await tx.booking.count({
      where: { customerId: user.id, status: { in: OPEN_STATUSES } },
    });
    if (open >= prepared.maxOpen) {
      throw new AppException(
        'BOOKING_LIMIT_REACHED',
        `You already have ${prepared.maxOpen} booking requests waiting for an answer. Wait for one to be answered or cancel one before sending another.`,
        HttpStatus.CONFLICT,
      );
    }
    const now = new Date();
    const offer = await this.emptyLegs.forBooking(tx, input.emptyLegId, now);
    if (!offer) throw unavailable();
    const live = await tx.booking.findFirst({
      where: { emptyLegId: offer.id, status: { notIn: BOOKING_ENDED } },
      select: { customerId: true },
    });
    if (live?.customerId === user.id) {
      throw new AppException(
        'BOOKING_DUPLICATE',
        'You have already requested this empty leg. The operator is answering that request.',
        HttpStatus.CONFLICT,
      );
    }
    if (live) throw unavailable();
    // Only an operator's own price is bookable: a platform-calculated offer
    // (none can be made yet) would be an estimate with no calculation.
    if (offer.priceType !== PriceType.QUOTE) throw unavailable();
    if (
      offer.priceMinor !== BigInt(input.expectedTotalMinor) ||
      offer.currency !== input.currency
    ) {
      throw new AppException(
        'BOOKING_PRICE_CHANGED',
        'The operator has changed the price of this empty leg.',
        HttpStatus.CONFLICT,
        [
          { field: 'totalMinor', issue: String(offer.priceMinor) },
          { field: 'currency', issue: offer.currency },
          { field: 'priceType', issue: offer.priceType },
          { field: 'validUntil', issue: offer.expiresAt.toISOString() },
        ],
      );
    }
    // Seats, conditions, window or validity changed since the customer read
    // the offer (rule 9): they read it again before sending. No `totalMinor`
    // in the details, as the price is the one they agreed to.
    if (offer.updatedAt.getTime() !== Date.parse(input.offerUpdatedAt)) {
      throw new AppException(
        'BOOKING_PRICE_CHANGED',
        'The operator has changed this empty leg since you looked. Read it again before sending your request.',
        HttpStatus.CONFLICT,
        [{ field: 'offerUpdatedAt', issue: offer.updatedAt.toISOString() }],
      );
    }
    if (input.passengerCount > offer.seatsAvailable) {
      throw invalid(
        'passengerCount',
        `must be at most the offer's ${offer.seatsAvailable} seats`,
      );
    }
    const config = await this.categories.resolve(ServiceCategory.EMPTY_LEG, {
      operatorId: offer.operatorId,
    });
    if (!config.isEnabled) {
      throw new AppException(
        'BOOKING_CATEGORY_DISABLED',
        'This service is not taking bookings at the moment.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const terms = await this.cancellationTerms.current(tx, now);
    if (terms.version !== input.cancellationTermsVersion) {
      throw new AppException(
        'BOOKING_TERMS_CHANGED',
        'The cancellation terms have changed since you looked. Read the new terms before sending your request.',
        HttpStatus.CONFLICT,
        [
          { field: 'cancellationTermsVersion', issue: String(terms.version) },
          { field: 'summary', issue: terms.summary },
        ],
      );
    }

    // The offer's price is the customer's tax-inclusive total (lead
    // decision): stored split into tax, commission and operator payable, so
    // settlements and reports read it as any other price.
    const { calculationId } = await this.pricing.priceEmptyLeg(tx, {
      aircraftId: offer.aircraft.id,
      operatorId: offer.operatorId,
      category: offer.aircraft.category,
      emptyLegId: offer.id,
      totalMinor: minorToNumber(offer.priceMinor),
      validUntil: offer.expiresAt,
      availabilityCheckedAt: now,
    });
    const booking = await tx.booking.create({
      data: {
        reference: bookingReference(),
        customerId: user.id,
        category: ServiceCategory.EMPTY_LEG,
        status: BookingStatus.REQUESTED,
        bookingMode: config.bookingMode,
        paymentModel: config.paymentModel,
        operatorId: offer.operatorId,
        aircraftId: offer.aircraft.id,
        emptyLegId: offer.id,
        itinerary: itineraryOf(
          offer,
          input.passengerCount,
        ) as unknown as Prisma.InputJsonValue,
        calculationId,
        totalMinor: offer.priceMinor,
        currency: offer.currency,
        priceType: offer.priceType,
        cancellationTerms: requestTerms(
          terms,
          now,
        ) as unknown as Prisma.InputJsonValue,
        specialRequests: prepared.specialRequests,
      },
    });
    if (prepared.snapshots.length > 0) {
      await tx.bookingPassenger.createMany({
        data: prepared.snapshots.map((snapshot) => ({
          bookingId: booking.id,
          ...snapshot,
        })),
      });
    }
    // The aircraft over the departure window: availability checked again
    // (rule 3), and the hold confirmation rechecks later.
    const held = await this.availability.placeBookingHold(tx, {
      aircraftId: offer.aircraft.id,
      bookingId: booking.id,
      startsAt: offer.departureFrom,
      endsAt: offer.departureTo,
      expiresAt: holdExpiry(now, offer.departureTo, prepared.holdHours),
    });
    if (!held) throw unavailable();

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
          emptyLegId: offer.id,
          emptyLegReference: offer.reference,
          calculationId,
          cancellationTermsRuleId: terms.ruleId,
          cancellationTermsVersion: terms.version,
          totalMinor: minorToNumber(booking.totalMinor),
          currency: booking.currency,
          priceType: booking.priceType,
          passengerCount: prepared.snapshots.length,
        },
      },
      tx,
    );
    const next = afterRequested({
      category: booking.category,
      bookingMode: booking.bookingMode,
      priceType: booking.priceType,
      operatorAccepted: false,
      paymentConditionMet: false,
      liveFareRevalidated: false,
      feasibilityComplete: false,
      departed: false,
    });
    const moved = await this.bookings.transition(tx, booking, next, {
      kind: 'SYSTEM',
    });
    return {
      reference: booking.reference,
      status: moved,
      paymentStatus: booking.paymentStatus,
      price: {
        priceType: booking.priceType,
        amountMinor: minorToNumber(booking.totalMinor),
        currency: booking.currency,
        validUntil: null,
      },
      createdAt: booking.createdAt.toISOString(),
    };
  }
}
