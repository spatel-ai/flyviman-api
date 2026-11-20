import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { FieldCipher, isEncrypted } from '../../common/crypto/field-cipher.js';
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
  type BookingPaymentStatus,
  BookingStatus,
  PriceType,
  QuoteStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { CategoryConfigService } from '../configuration/category-config.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { QuotesService } from '../quotes/quotes.service.js';
import { CANCELLATION_NOTE, SearchService } from '../search/search.service.js';
import { parseCancellationTerms, parseItinerary } from './booking-json.js';
import { changeRequestView, decisionNotes } from './change-requests.js';
import {
  holdExpiry,
  isQuoteRequest,
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
  confirmationCheck,
  paymentConditionMet,
  statusTimestamps,
  type TransitionContext,
} from './booking-transitions.js';
import type {
  BookingCreatedDto,
  BookingResponseDto,
  CreateBookingDto,
} from './dto/booking.dto.js';

/** Attempts at a fresh reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

/**
 * Requests still waiting on the operator, each holding an aircraft. A
 * question waiting for the customer still holds it, so it counts too;
 * answering it moves between two open statuses and never adds one.
 */
const OPEN_STATUSES: BookingStatus[] = [
  BookingStatus.REQUESTED,
  BookingStatus.OPERATOR_PENDING,
  BookingStatus.CLARIFICATION_REQUESTED,
];

/** The latest date there is: a hold rechecked "until the trip ends". */
const END_OF_TIME = new Date(8_640_000_000_000_000);

/** What `evaluateConfirmation` did. */
export type ConfirmationOutcome =
  { confirmed: true } | { confirmed: false; reason: string };

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

/** What payments (M9) read of a booking: no itinerary, no passengers. */
export const PAYABLE_FIELDS = {
  id: true,
  reference: true,
  customerId: true,
  category: true,
  status: true,
  priceType: true,
  paymentModel: true,
  paymentStatus: true,
  operatorAcceptedAt: true,
  totalMinor: true,
  currency: true,
} as const;

export type PayableBookingRow = Prisma.BookingGetPayload<{
  select: typeof PAYABLE_FIELDS;
}>;

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
    private readonly config: ConfigService,
    private readonly quotes: QuotesService,
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
    // Before the price and availability checks: the caller's own hold takes
    // the aircraft out of matching, which would read as unavailable.
    const aircraftId = revalidation.result.aircraft.id;
    const trip = tripSpan(revalidation.legs);
    await this.assertNoDuplicate(this.prisma, user.id, aircraftId, trip);

    const outcome = revalidationOutcome(revalidation.current, {
      totalMinor: input.expectedTotalMinor,
      currency: input.currency,
    });
    if (outcome.kind === 'unavailable') throw unavailable();
    if (outcome.kind === 'nowOnRequest') {
      // The aircraft is now priced on request: send the request without an
      // amount to ask the operator for a quote.
      throw new AppException(
        'BOOKING_PRICE_CHANGED',
        'The operator now prices this aircraft on request. Send a quote request instead.',
        HttpStatus.CONFLICT,
        [{ field: 'price', issue: 'ON_REQUEST' }],
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
    if (!current) throw unavailable();

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
        return await this.prisma.$transaction(async (tx) => {
          await markIdempotencyCommitted(tx, claim);
          // One request per customer at a time past this point, so two at
          // once cannot both slip under the cap. Always before the
          // aircraft's lock (`placeBookingHold`), never after.
          const key = `booking_customer:${user.id}`;
          await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
          await this.assertNoDuplicate(tx, user.id, aircraftId, trip);
          const open = await tx.booking.count({
            where: { customerId: user.id, status: { in: OPEN_STATUSES } },
          });
          if (open >= maxOpen) {
            throw new AppException(
              'BOOKING_LIMIT_REACHED',
              `You already have ${maxOpen} booking requests waiting for an answer. Wait for one to be answered or cancel one before sending another.`,
              HttpStatus.CONFLICT,
            );
          }
          const now = new Date();
          // A quote request has no price yet: no calculation, and an amount
          // of 0 that is never shown (`isQuoteRequest`).
          const calculationId = current.priced
            ? await current.saveCalculation(tx)
            : null;
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
              totalMinor: current.priced ? BigInt(current.totalMinor) : 0n,
              currency: current.priced ? current.currency : input.currency,
              priceType: PriceType.ESTIMATE,
              cancellationTerms: requestTerms(
                CANCELLATION_NOTE,
                now,
              ) as unknown as Prisma.InputJsonValue,
              specialRequests,
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
            expiresAt: holdExpiry(now, current.hold.endsAt, holdHours),
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
                totalMinor: current.priced ? current.totalMinor : null,
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
            price: current.priced
              ? {
                  priceType: booking.priceType,
                  amountMinor: current.totalMinor,
                  currency: booking.currency,
                  validUntil: current.validUntil.toISOString(),
                }
              : null,
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
        changeRequests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      },
    });
    if (!booking) throw notFound();
    const notes = await decisionNotes(this.prisma, booking.id);
    const estimate = booking.priceType === PriceType.ESTIMATE;
    return {
      reference: booking.reference,
      category: booking.category,
      status: booking.status,
      paymentStatus: booking.paymentStatus,
      bookingMode: booking.bookingMode,
      paymentModel: booking.paymentModel,
      price: isQuoteRequest(booking)
        ? null
        : {
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
      specialRequests: this.revealLegacy(booking.specialRequests),
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
      confirmedAt: booking.confirmedAt?.toISOString() ?? null,
      cancelledAt: booking.cancelledAt?.toISOString() ?? null,
      changeRequests: booking.changeRequests.map((row) =>
        changeRequestView(row, booking.reference, notes),
      ),
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
      /** Added to the event's payload (never personal data). */
      event?: Prisma.InputJsonObject;
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
      data: { status: to, ...statusTimestamps(to, new Date()) },
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
        payload:
          reason || options.event
            ? {
                ...options.event,
                ...(reason ? { override: true, reason } : {}),
              }
            : undefined,
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

  /**
   * The booking a payment is for (M9): the caller's own by reference, or
   * one by ID (a gateway notice). With a transaction it is locked
   * (`FOR UPDATE`) until that transaction ends: every payment change on a
   * booking takes this lock first, and a status change (which writes the
   * row) waits for it, so a payment and a cancellation or expiry are never
   * applied on a stale read. `null` when there is no such booking.
   */
  async forPayment(
    where: { reference: string; customerId: string } | { id: string },
    tx?: Prisma.TransactionClient,
  ): Promise<PayableBookingRow | null> {
    const db = tx ?? this.prisma;
    const found = await db.booking.findFirst({
      where,
      select: PAYABLE_FIELDS,
    });
    if (!found || !tx) return found;
    await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
    return tx.booking.findUnique({
      where: { id: found.id },
      select: PAYABLE_FIELDS,
    });
  }

  /**
   * Writes a booking's payment summary (M9) after a payment changed, with a
   * `PAYMENT_UPDATE` event and an audit record, in the payment's
   * transaction, then runs the confirmation rule (`evaluateConfirmation`):
   * the booking becomes `CONFIRMED` only if every other condition already
   * holds. A payment alone never confirms (rule 2). Applied only if the
   * summary is still `from`.
   */
  async recordPaymentStatus(
    tx: Prisma.TransactionClient,
    booking: Pick<PayableBookingRow, 'id' | 'reference' | 'paymentStatus'>,
    to: BookingPaymentStatus,
    payment: { reference: string; purpose: string },
  ): Promise<void> {
    const { count } = await tx.booking.updateMany({
      where: { id: booking.id, paymentStatus: booking.paymentStatus },
      data: { paymentStatus: to },
    });
    if (count !== 1) {
      throw new Error('The booking payment status changed under its lock.');
    }
    const change = {
      paymentReference: payment.reference,
      purpose: payment.purpose,
      from: booking.paymentStatus,
      to,
    };
    await tx.bookingEvent.create({
      data: {
        bookingId: booking.id,
        type: BookingEventType.PAYMENT_UPDATE,
        payload: change,
      },
    });
    await this.audit.record(
      {
        action: 'booking.payment_status',
        entityType: 'Booking',
        entityId: booking.id,
        before: {
          reference: booking.reference,
          paymentStatus: booking.paymentStatus,
        },
        after: {
          reference: booking.reference,
          paymentStatus: to,
          paymentReference: payment.reference,
        },
        actor: null,
      },
      tx,
    );
    await this.evaluateConfirmation(tx, booking.id);
  }

  /**
   * The confirmation rule (state-machines.md), the one place a booking
   * becomes `CONFIRMED`: from `AWAITING_PAYMENT`, with the operator's
   * acceptance recorded (or instant inventory), a `CONFIRMED` price and the
   * payment condition of its model met (A and B `PAID`, C `PARTIALLY_PAID`
   * or `PAID`). The held time is checked again first (rule 3) and then kept
   * until the trip ends. Called in the caller's transaction after a payment
   * summary changes and after the price is confirmed.
   *
   * Never throws for a booking that does not qualify: inside a payment
   * notice's transaction a failure would lose the captured payment. When
   * the time is no longer free the booking stays `AWAITING_PAYMENT` (paid)
   * and an audit record says why, for operations to resolve.
   */
  async evaluateConfirmation(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<ConfirmationOutcome> {
    await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE "id" = ${bookingId}::uuid FOR UPDATE`;
    const row = await tx.booking.findUnique({ where: { id: bookingId } });
    if (!row) return { confirmed: false, reason: 'the booking is missing' };
    const check = confirmationCheck({
      status: row.status,
      category: row.category,
      bookingMode: row.bookingMode,
      priceType: row.priceType,
      paymentModel: row.paymentModel,
      paymentStatus: row.paymentStatus,
      operatorAccepted: row.operatorAcceptedAt !== null,
    });
    if (!check.allowed) return { confirmed: false, reason: check.reason };
    if (
      row.aircraftId !== null &&
      !(await this.availability.recheckBookingHold(tx, row.id, END_OF_TIME))
    ) {
      const reason = 'the aircraft time is no longer free';
      await this.audit.record(
        {
          action: 'booking.confirmation_blocked',
          entityType: 'Booking',
          entityId: row.id,
          after: {
            reference: row.reference,
            status: row.status,
            paymentStatus: row.paymentStatus,
            reason,
          },
          actor: null,
        },
        tx,
      );
      return { confirmed: false, reason };
    }
    await this.transition(
      tx,
      row,
      BookingStatus.CONFIRMED,
      { kind: 'SYSTEM' },
      {
        context: {
          paymentConditionMet: paymentConditionMet(
            row.paymentModel,
            row.paymentStatus,
          ),
        },
      },
    );
    return { confirmed: true };
  }

  /**
   * After the price is confirmed (operator acceptance or the customer's
   * acceptance of a quote): every payment model asks for payment at once,
   * so the booking moves `PRICE_CONFIRMED` → `AWAITING_PAYMENT` (System),
   * then the confirmation rule runs. Reads the booking again, since the
   * caller's copy is from before its own move.
   */
  async afterPriceConfirmed(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<void> {
    const row = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
    });
    if (row.status !== BookingStatus.PRICE_CONFIRMED) return;
    await this.transition(tx, row, BookingStatus.AWAITING_PAYMENT, {
      kind: 'SYSTEM',
    });
    await this.evaluateConfirmation(tx, bookingId);
  }

  /**
   * What every path that ends a request does besides the status: the
   * aircraft's hold is released and a quote still open closes `EXPIRED`
   * (as the operator's rejection and the hold-expiry job do).
   */
  async endRequest(
    tx: Prisma.TransactionClient,
    bookingId: string,
    now: Date,
  ): Promise<void> {
    await this.availability.releaseBookingHolds(tx, bookingId);
    const open = await tx.quote.findMany({
      where: { bookingId, status: QuoteStatus.SENT },
    });
    for (const quote of open) await this.quotes.move(tx, quote, 'expire', now);
  }

  /**
   * The customer turns down a confirmed price before paying:
   * `PRICE_CONFIRMED` → `QUOTE_DECLINED`, the hold released. Every payment
   * model moves a confirmed price on to `AWAITING_PAYMENT` at once, so this
   * applies to a booking operations left at `PRICE_CONFIRMED`; from
   * `AWAITING_PAYMENT` the customer cancels instead.
   */
  async decline(user: AuthUser, reference: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const found = await tx.booking.findFirst({
        where: { reference, customerId: user.id },
        select: { id: true },
      });
      if (!found) throw notFound();
      await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
      const row = await tx.booking.findUniqueOrThrow({
        where: { id: found.id },
      });
      if (row.status !== BookingStatus.PRICE_CONFIRMED) {
        throw new AppException(
          'BOOKING_INVALID_TRANSITION',
          'This booking cannot move to that status now.',
          HttpStatus.CONFLICT,
          [
            {
              field: 'status',
              issue: `a ${row.status} booking cannot be declined`,
            },
          ],
        );
      }
      await this.transition(tx, row, BookingStatus.QUOTE_DECLINED, {
        kind: 'CUSTOMER',
        user,
      });
      await this.endRequest(tx, row.id, new Date());
    });
  }

  /**
   * 409 `BOOKING_DUPLICATE` when the customer already has an open request
   * for this aircraft whose hold overlaps the trip, lapsed hold or not.
   */
  private async assertNoDuplicate(
    db: Pick<Prisma.TransactionClient, 'booking'>,
    customerId: string,
    aircraftId: string,
    trip: { startsAt: Date; endsAt: Date },
  ): Promise<void> {
    const duplicate = await db.booking.findFirst({
      where: {
        customerId,
        aircraftId,
        status: { in: OPEN_STATUSES },
        holds: {
          some: {
            startsAt: { lte: trip.endsAt },
            endsAt: { gt: trip.startsAt },
          },
        },
      },
      select: { id: true },
    });
    if (duplicate) {
      throw new AppException(
        'BOOKING_DUPLICATE',
        'You have already requested this aircraft for this time. The operator is answering that request.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Decrypts a snapshot field (always written encrypted). */
  private reveal(stored: string | null): string | null {
    return stored === null ? null : this.cipher.decrypt(stored);
  }

  /** Decrypts a field that requests made before it was encrypted stored in plain text. */
  private revealLegacy(stored: string | null): string | null {
    return stored === null || !isEncrypted(stored)
      ? stored
      : this.cipher.decrypt(stored);
  }
}

/**
 * From the first departure to the last (the return's, on a round trip). The
 * hold placed for the trip always covers this span, so an existing hold that
 * meets it overlaps the new one.
 */
function tripSpan(legs: { departureAt: string }[]): {
  startsAt: Date;
  endsAt: Date;
} {
  return {
    startsAt: new Date(legs[0].departureAt),
    endsAt: new Date(legs[legs.length - 1].departureAt),
  };
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
