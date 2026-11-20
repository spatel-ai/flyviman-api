import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { FieldCipher, isEncrypted } from '../../common/crypto/field-cipher.js';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { minorToNumber } from '../../common/money.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  AircraftAvailabilityStatus,
  AircraftListingStatus,
  AvailabilityBlockReason,
  BookingEventType,
  BookingPaymentStatus,
  BookingStatus,
  NotificationChannel,
  OperatorStatus,
  PriceType,
  QuoteStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REDIS } from '../../redis/redis.module.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  aircraftWhere,
  assertCan,
  type OperatorAccess,
} from '../operators/operator-access.js';
import { OperatorsService } from '../operators/operators.service.js';
import type {
  QuoteResponseDto,
  ReviseQuoteDto,
} from '../quotes/dto/quote.dto.js';
import { quoteStanding, quoteValidUntil } from '../quotes/quote-transitions.js';
import { type QuoteRow, QuotesService } from '../quotes/quotes.service.js';
import { UsersService } from '../users/users.service.js';
import { parseCancellationTerms, parseItinerary } from './booking-json.js';
import { isQuoteRequest } from './booking-snapshot.js';
import { BookingsService } from './bookings.service.js';
import { changeRequestView, decisionNotes } from './change-requests.js';
import type { BookingPriceDto } from './dto/booking.dto.js';
import type {
  BookingMessageDto,
  BookingNoteDto,
  OperatorBookingRequestDetailDto,
  OperatorBookingRequestDto,
  OperatorBookingRequestQueryDto,
} from './dto/booking-request.dto.js';

/** What the operator's inbox shows by default: requests waiting for it. */
const WAITING: BookingStatus[] = [
  BookingStatus.OPERATOR_PENDING,
  BookingStatus.CLARIFICATION_REQUESTED,
];

/** Hold-expiry job: one instance at a time, a batch per query. */
const LOCK_KEY = 'bookings:hold-expiry:lock';
const LOCK_SECONDS = 5 * 60;
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;
const JOB_BATCH = 100;

/** Attempts at a fresh quote reference before giving up (31^6 codes). */
const REFERENCE_ATTEMPTS = 5;

/** A quote must leave the customer at least this long to answer. */
const MIN_QUOTE_MINUTES = 60;

const BOOKING_INCLUDE = {
  aircraft: {
    select: { id: true, registration: true, manufacturer: true, model: true },
  },
  holds: {
    where: { reason: AvailabilityBlockReason.SOFT_HOLD },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
    take: 1,
    select: { expiresAt: true },
  },
  quotes: {
    where: { status: { not: QuoteStatus.DRAFT } },
    orderBy: [{ createdAt: 'desc' as const }, { id: 'desc' as const }],
  },
  calculation: { select: { validUntil: true } },
} satisfies Prisma.BookingInclude;

type BookingRow = Prisma.BookingGetPayload<{
  include: typeof BOOKING_INCLUDE;
}>;

/** `BookingEvent.payload` of a message or a note; the text is encrypted. */
interface TextPayload {
  from?: 'OPERATOR' | 'CUSTOMER';
  /** Notes are for the operator only, never for the customer. */
  visibility?: 'OPERATOR';
  body: string;
}

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Booking not found.',
    HttpStatus.NOT_FOUND,
  );
}

function quoteNotFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Quote not found.',
    HttpStatus.NOT_FOUND,
  );
}

function invalidTransition(reason: string): AppException {
  return new AppException(
    'BOOKING_INVALID_TRANSITION',
    'This booking cannot move to that status now.',
    HttpStatus.CONFLICT,
    [{ field: 'status', issue: reason }],
  );
}

/**
 * The booking request flow after creation (M8): the operator's inbox
 * (read, accept, reject, ask, quote, notes), the customer's answers (accept
 * or decline a quote, answer a question) and the hold-expiry job.
 *
 * Every change runs in one transaction that first takes the booking's lock
 * (`booking_request:<id>`), then, through availability, the aircraft's, so a
 * revision, an answer and the job never interleave on one booking. Status
 * changes go through `BookingsService.transition` (event and audit); quote
 * changes through `QuotesService` (audit). Free text (questions, answers,
 * notes, reasons) is stored encrypted in the booking's events and never
 * written to the audit trail, notifications or logs.
 */
@Injectable()
export class BookingRequestsService {
  private readonly logger = new Logger(BookingRequestsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly quotes: QuotesService,
    private readonly availability: AvailabilityService,
    private readonly operators: OperatorsService,
    private readonly users: UsersService,
    private readonly notifications: NotificationsService,
    private readonly cipher: FieldCipher,
    private readonly config: ConfigService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // --- Operator inbox ------------------------------------------------------

  async operatorList(
    user: AuthUser,
    query: OperatorBookingRequestQueryDto,
  ): Promise<Paginated<OperatorBookingRequestDto>> {
    const access = await this.access(user);
    // An aircraft out of reach lists nothing, as if it had no requests.
    const where: Prisma.BookingWhereInput = {
      ...this.scope(access),
      status: query.status ?? { in: WAITING },
      ...(query.aircraftId ? { aircraftId: query.aircraftId } : {}),
    };
    const [rows, total] = await Promise.all([
      this.prisma.booking.findMany({
        where,
        include: BOOKING_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.booking.count({ where }),
    ]);
    const now = new Date();
    return new Paginated(
      rows.map((row) => this.toOperator(row, now)),
      query.page,
      query.pageSize,
      total,
    );
  }

  async operatorDetail(
    user: AuthUser,
    reference: string,
  ): Promise<OperatorBookingRequestDetailDto> {
    const access = await this.access(user);
    const row = await this.prisma.booking.findFirst({
      where: { reference, ...this.scope(access) },
      include: BOOKING_INCLUDE,
    });
    if (!row) throw notFound();
    return this.detailOf(row);
  }

  /**
   * Accepts the request at its proposed price: `PRICE_CONFIRMED`, with the
   * price now `CONFIRMED` and the operator's acceptance recorded, on the
   * terms the customer was shown (rule 9). Refused for a request priced on
   * request (send a quote) and while a quote waits for the customer.
   * Rechecks the aircraft first (rule 3). Idempotent.
   */
  async accept(
    user: AuthUser,
    reference: string,
    claim: IdempotencyClaim,
  ): Promise<OperatorBookingRequestDetailDto> {
    const access = await this.access(user);
    const booking = await this.operatorBooking(access, reference);
    await this.changeRequest(booking.id, async (tx, row, now) => {
      await markIdempotencyCommitted(tx, claim);
      const newest = await this.quotes.newest(tx, row.id);
      await this.bookings.transition(
        tx,
        row,
        BookingStatus.PRICE_CONFIRMED,
        { kind: 'OPERATOR', user },
        {
          context: {
            quote: quoteStanding(newest, now),
            priceOnRequest: isQuoteRequest(row),
          },
        },
      );
      await this.assertBookable(tx, row, now, 'operator');
      await tx.booking.update({
        where: { id: row.id },
        data: { priceType: PriceType.CONFIRMED, operatorAcceptedAt: now },
      });
      await this.audit.record(
        {
          action: 'booking.price',
          entityType: 'Booking',
          entityId: row.id,
          before: {
            reference: row.reference,
            priceType: row.priceType,
            totalMinor: minorToNumber(row.totalMinor),
          },
          after: {
            reference: row.reference,
            priceType: PriceType.CONFIRMED,
            totalMinor: minorToNumber(row.totalMinor),
            acceptedBy: 'OPERATOR',
          },
        },
        tx,
      );
      await this.event(tx, row.id, BookingEventType.OPERATOR_RESPONSE, user, {
        decision: 'ACCEPT',
      });
      await this.bookings.afterPriceConfirmed(tx, row.id);
      return this.notifyCustomer(tx, row, 'booking.price_confirmed', {});
    });
    return this.operatorDetail(user, reference);
  }

  /**
   * Rejects the request (`OPERATOR_UNAVAILABLE`) with a reason kept for the
   * operator and Flyviman. Any quote still open closes as `EXPIRED`; the
   * aircraft's hold is released.
   */
  async reject(
    user: AuthUser,
    reference: string,
    reason: string,
  ): Promise<OperatorBookingRequestDetailDto> {
    const access = await this.access(user);
    const booking = await this.operatorBooking(access, reference);
    await this.changeRequest(booking.id, async (tx, row, now) => {
      await this.bookings.transition(
        tx,
        row,
        BookingStatus.OPERATOR_UNAVAILABLE,
        { kind: 'OPERATOR', user },
      );
      await this.closeOpenQuote(tx, row.id, now);
      await this.availability.releaseBookingHolds(tx, row.id);
      await this.event(tx, row.id, BookingEventType.OPERATOR_RESPONSE, user, {
        decision: 'REJECT',
        reason: this.cipher.encrypt(reason),
      });
      return this.notifyCustomer(tx, row, 'booking.operator_unavailable', {});
    });
    return this.operatorDetail(user, reference);
  }

  /**
   * Asks the customer a question (`CLARIFICATION_REQUESTED`). The hold is
   * kept for another `BOOKING_HOLD_HOURS` so the customer can answer; a
   * request whose hold lapses unanswered closes as `EXPIRED`.
   */
  async clarify(
    user: AuthUser,
    reference: string,
    message: string,
  ): Promise<OperatorBookingRequestDetailDto> {
    const access = await this.access(user);
    const booking = await this.operatorBooking(access, reference);
    await this.changeRequest(booking.id, async (tx, row, now) => {
      await this.bookings.transition(
        tx,
        row,
        BookingStatus.CLARIFICATION_REQUESTED,
        { kind: 'OPERATOR', user },
      );
      await this.availability.recheckBookingHold(
        tx,
        row.id,
        this.holdUntil(now),
      );
      await this.message(tx, row.id, user, 'OPERATOR', message);
      return this.notifyCustomer(
        tx,
        row,
        'booking.clarification_requested',
        {},
      );
    });
    return this.operatorDetail(user, reference);
  }

  /**
   * Sends a quote, or a revision that supersedes the open one (a sent quote
   * is never edited). Only while the request waits for the operator
   * (`OPERATOR_PENDING`). Valid for `BOOKING_HOLD_HOURS` unless the operator
   * sets `validUntil`, never past the first departure; the hold is kept as
   * long. Rechecks the aircraft (rule 3) and the operator's approval.
   */
  async reviseQuote(
    user: AuthUser,
    reference: string,
    input: ReviseQuoteDto,
  ): Promise<QuoteResponseDto> {
    const access = await this.access(user);
    const booking = await this.operatorBooking(access, reference);
    const requested = input.validUntil ? new Date(input.validUntil) : undefined;
    let issued: QuoteRow | null = null;
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.changeRequest(booking.id, async (tx, row, now) => {
          if (row.status !== BookingStatus.OPERATOR_PENDING) {
            throw invalidTransition(`a ${row.status} request cannot be quoted`);
          }
          const departure = departureOf(row);
          if (
            requested &&
            (requested.getTime() < now.getTime() + MIN_QUOTE_MINUTES * 60_000 ||
              requested.getTime() > departure.getTime())
          ) {
            throw new AppException(
              'VALIDATION_ERROR',
              'The request is not valid.',
              HttpStatus.BAD_REQUEST,
              [
                {
                  field: 'validUntil',
                  issue: `must be at least ${MIN_QUOTE_MINUTES} minutes from now and no later than the departure`,
                },
              ],
            );
          }
          const validUntil = quoteValidUntil(
            now,
            departure,
            this.holdHours(),
            requested,
          );
          await this.assertBookable(tx, row, now, 'operator', validUntil);
          const { quote, superseded } = await this.quotes.issue(
            tx,
            {
              bookingId: row.id,
              operatorId: access.operatorId,
              totalMinor: input.totalMinor,
              currency: input.currency,
              validUntil,
              conditions: input.conditions,
              createdById: user.id,
            },
            now,
          );
          issued = quote;
          await this.event(tx, row.id, BookingEventType.QUOTE_ISSUED, user, {
            quoteReference: quote.reference,
            supersedes: superseded,
            totalMinor: input.totalMinor,
            currency: input.currency,
            priceType: PriceType.QUOTE,
            validUntil: validUntil.toISOString(),
          });
          return this.notifyCustomer(tx, row, 'booking.quote_sent', {
            quoteReference: quote.reference,
            validUntil: validUntil.toISOString(),
          });
        });
        break;
      } catch (error) {
        const clash =
          (error as { code?: unknown }).code === 'P2002' &&
          attempt < REFERENCE_ATTEMPTS;
        if (!clash) throw error;
      }
    }
    if (!issued) throw quoteNotFound();
    return this.quotes.toResponse(issued, booking.reference);
  }

  /** An internal note on one of the operator's bookings (never the customer's). */
  async addNote(
    user: AuthUser,
    reference: string,
    note: string,
  ): Promise<BookingNoteDto> {
    const access = await this.access(user);
    const booking = await this.operatorBooking(access, reference);
    const created = await this.prisma.bookingEvent.create({
      data: {
        bookingId: booking.id,
        type: BookingEventType.NOTE,
        actorId: user.id,
        actorRole: user.role,
        payload: {
          visibility: 'OPERATOR',
          body: this.cipher.encrypt(note),
        } satisfies TextPayload,
      },
    });
    return {
      id: created.id,
      body: note,
      createdAt: created.createdAt.toISOString(),
    };
  }

  // --- Customer ------------------------------------------------------------

  /** The quotes sent on one of the caller's bookings, newest first. */
  async customerQuotes(
    user: AuthUser,
    reference: string,
  ): Promise<QuoteResponseDto[]> {
    const booking = await this.ownBooking(user, reference);
    const quotes = await this.quotes.forBooking(booking.id);
    const now = new Date();
    return quotes.map((quote) =>
      this.quotes.toResponse(quote, booking.reference, now),
    );
  }

  async customerQuote(
    user: AuthUser,
    quoteReference: string,
  ): Promise<QuoteResponseDto> {
    const { quote, booking } = await this.ownQuote(user, quoteReference);
    return this.quotes.toResponse(quote, booking.reference);
  }

  /**
   * Accepts the operator's quote: the quote is `ACCEPTED` (price
   * `CONFIRMED`), the booking `PRICE_CONFIRMED` at the quoted price, on the
   * quote's conditions as shown (rule 9). Rechecks the aircraft (rule 3).
   * Idempotent; a second accept with a new key is 409.
   */
  async acceptQuote(
    user: AuthUser,
    quoteReference: string,
    claim: IdempotencyClaim,
  ): Promise<QuoteResponseDto> {
    const owned = await this.ownQuote(user, quoteReference);
    await this.changeRequest(owned.booking.id, async (tx, row, now) => {
      await markIdempotencyCommitted(tx, claim);
      const quote = await tx.quote.findUniqueOrThrow({
        where: { id: owned.quote.id },
      });
      await this.quotes.move(tx, quote, 'accept', now);
      await this.bookings.transition(
        tx,
        row,
        BookingStatus.PRICE_CONFIRMED,
        { kind: 'CUSTOMER', user },
        { context: { quote: 'LIVE' } },
      );
      await this.assertBookable(tx, row, now, 'customer');
      const conditions = this.quotes.conditionsOf(quote);
      const terms = parseCancellationTerms({
        version: 1,
        source: 'OPERATOR_QUOTE',
        summary: conditions.summary,
        charges: conditions.charges,
        acceptedAt: now.toISOString(),
      });
      await tx.booking.update({
        where: { id: row.id },
        data: {
          totalMinor: quote.totalMinor,
          currency: quote.currency,
          priceType: PriceType.CONFIRMED,
          acceptedQuoteId: quote.id,
          operatorAcceptedAt: now,
          cancellationTerms: terms as unknown as Prisma.InputJsonValue,
        },
      });
      await this.audit.record(
        {
          action: 'booking.price',
          entityType: 'Booking',
          entityId: row.id,
          before: {
            reference: row.reference,
            priceType: row.priceType,
            totalMinor: isQuoteRequest(row)
              ? null
              : minorToNumber(row.totalMinor),
            currency: row.currency,
          },
          after: {
            reference: row.reference,
            priceType: PriceType.CONFIRMED,
            totalMinor: minorToNumber(quote.totalMinor),
            currency: quote.currency,
            quoteReference: quote.reference,
            acceptedBy: 'CUSTOMER',
          },
        },
        tx,
      );
      await this.bookings.afterPriceConfirmed(tx, row.id);
      return this.notifyOperator(tx, row, 'booking.quote_accepted');
    });
    return this.customerQuote(user, quoteReference);
  }

  /** Declines the operator's quote: `REJECTED`, the booking `QUOTE_DECLINED`. */
  async rejectQuote(
    user: AuthUser,
    quoteReference: string,
  ): Promise<QuoteResponseDto> {
    const owned = await this.ownQuote(user, quoteReference);
    await this.changeRequest(owned.booking.id, async (tx, row, now) => {
      const quote = await tx.quote.findUniqueOrThrow({
        where: { id: owned.quote.id },
      });
      await this.quotes.move(tx, quote, 'reject', now);
      await this.bookings.transition(
        tx,
        row,
        BookingStatus.QUOTE_DECLINED,
        { kind: 'CUSTOMER', user },
        { context: { quote: 'LIVE' } },
      );
      await this.availability.releaseBookingHolds(tx, row.id);
      return this.notifyOperator(tx, row, 'booking.quote_declined');
    });
    return this.customerQuote(user, quoteReference);
  }

  /**
   * The customer's answer to the operator's question: back to
   * `OPERATOR_PENDING`, with the hold kept another `BOOKING_HOLD_HOURS`
   * when the time is still free.
   */
  async answer(
    user: AuthUser,
    reference: string,
    message: string,
  ): Promise<BookingMessageDto[]> {
    const booking = await this.ownBooking(user, reference);
    await this.changeRequest(booking.id, async (tx, row, now) => {
      await this.bookings.transition(tx, row, BookingStatus.OPERATOR_PENDING, {
        kind: 'CUSTOMER',
        user,
      });
      await this.availability.recheckBookingHold(
        tx,
        row.id,
        this.holdUntil(now),
      );
      await this.message(tx, row.id, user, 'CUSTOMER', message);
      return this.notifyOperator(tx, row, 'booking.clarification_answered');
    });
    return this.customerMessages(user, reference);
  }

  /** The questions and answers on one of the caller's bookings, oldest first. */
  async customerMessages(
    user: AuthUser,
    reference: string,
  ): Promise<BookingMessageDto[]> {
    const booking = await this.ownBooking(user, reference);
    return this.messagesOf(booking.id);
  }

  // --- Hold-expiry job -----------------------------------------------------

  /** Every five minutes. */
  @Cron('*/5 * * * *', { name: 'booking-hold-expiry' })
  async scheduled(): Promise<void> {
    try {
      await this.runHoldExpiry();
    } catch (error) {
      this.logger.error(
        `Booking hold expiry failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /**
   * Closes what lapsed, as the System actor (state-machines.md, Booking):
   * 1. a sent quote past `validUntil` becomes `EXPIRED`, and its request,
   *    if still waiting (`OPERATOR_PENDING`), `EXPIRED` too;
   * 2. a request waiting for the operator whose hold lapsed with no quote
   *    sent becomes `OPERATOR_UNAVAILABLE` (no answer in time);
   * 3. a question the customer left unanswered until the hold lapsed
   *    becomes `EXPIRED`;
   * 4. a booking `AWAITING_PAYMENT` with nothing paid whose hold (the
   *    payment window, renewed when the price was confirmed) lapsed
   *    becomes `EXPIRED`.
   * Holds are released and the customer told. Each change is guarded by
   * the status read, so a second run (or a run racing an answer) changes
   * nothing twice. One instance at a time (Redis lock).
   */
  async runHoldExpiry(now = new Date()): Promise<{
    quotesExpired: number;
    requestsClosed: number;
    skipped: boolean;
  }> {
    const token = randomUUID();
    const locked = await this.redis.set(
      LOCK_KEY,
      token,
      'EX',
      LOCK_SECONDS,
      'NX',
    );
    if (!locked) return { quotesExpired: 0, requestsClosed: 0, skipped: true };
    let quotesExpired = 0;
    let requestsClosed = 0;
    try {
      const seenQuotes: string[] = [];
      for (;;) {
        const due = await this.quotes.lapsed(now, JOB_BATCH, seenQuotes);
        for (const quote of due) {
          seenQuotes.push(quote.id);
          if (!quote.bookingId) continue;
          const result = await this.safely(() =>
            this.expireQuote(quote.id, quote.bookingId as string, now),
          );
          if (result) {
            quotesExpired += 1;
            if (result === 'booking') requestsClosed += 1;
          }
        }
        if (due.length < JOB_BATCH) break;
      }

      const seenBookings: string[] = [];
      for (;;) {
        const due = await this.prisma.booking.findMany({
          where: {
            id: { notIn: seenBookings },
            // Waiting on the operator or the customer's answer, or a payment
            // window that lapsed with nothing paid.
            OR: [
              { status: { in: WAITING } },
              {
                status: BookingStatus.AWAITING_PAYMENT,
                paymentStatus: BookingPaymentStatus.UNPAID,
              },
            ],
            // Only requests that held the aircraft and whose hold lapsed;
            // a booking without a hold (another source) is left alone.
            AND: [
              {
                holds: { some: { reason: AvailabilityBlockReason.SOFT_HOLD } },
              },
              {
                holds: {
                  none: {
                    reason: AvailabilityBlockReason.SOFT_HOLD,
                    expiresAt: { gt: now },
                  },
                },
              },
            ],
          },
          select: { id: true },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
          take: JOB_BATCH,
        });
        for (const { id } of due) {
          seenBookings.push(id);
          if (await this.safely(() => this.closeLapsed(id, now))) {
            requestsClosed += 1;
          }
        }
        if (due.length < JOB_BATCH) break;
      }
      if (quotesExpired + requestsClosed > 0) {
        this.logger.log(
          `Booking holds: ${quotesExpired} quotes expired, ${requestsClosed} requests closed`,
        );
      }
      return { quotesExpired, requestsClosed, skipped: false };
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, LOCK_KEY, token);
    }
  }

  /** Step 1: one lapsed quote. `false` when someone else moved it first. */
  private async expireQuote(
    quoteId: string,
    bookingId: string,
    now: Date,
  ): Promise<false | 'quote' | 'booking'> {
    let outcome: false | 'quote' | 'booking' = false;
    await this.changeRequest(bookingId, async (tx, row) => {
      const quote = await tx.quote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      if (quote.status !== QuoteStatus.SENT || quote.validUntil > now) {
        return [];
      }
      await this.quotes.move(tx, quote, 'expire', now, { system: true });
      outcome = 'quote';
      const newest = await this.quotes.newest(tx, row.id);
      if (
        row.status !== BookingStatus.OPERATOR_PENDING ||
        newest?.id !== quote.id
      ) {
        return [];
      }
      await this.bookings.transition(
        tx,
        row,
        BookingStatus.EXPIRED,
        { kind: 'SYSTEM' },
        { context: { quote: 'LAPSED' } },
      );
      await this.availability.releaseBookingHolds(tx, row.id);
      outcome = 'booking';
      return this.notifyCustomer(tx, row, 'booking.expired', {});
    });
    return outcome;
  }

  /** Steps 2 and 3: one waiting request whose hold lapsed. */
  private async closeLapsed(bookingId: string, now: Date): Promise<boolean> {
    let closed = false;
    await this.changeRequest(bookingId, async (tx, row) => {
      // Read again under the lock: an answer may have renewed the hold.
      const holds = await tx.availabilityBlock.findMany({
        where: { bookingId: row.id, reason: AvailabilityBlockReason.SOFT_HOLD },
        select: { expiresAt: true },
      });
      const live = holds.some(
        (hold) => hold.expiresAt === null || hold.expiresAt > now,
      );
      if (holds.length === 0 || live) return [];
      if (row.status === BookingStatus.AWAITING_PAYMENT) {
        // The payment window lapsed. Payment notices lock the booking row,
        // not this request's lock: take it and read the payment summary
        // again, so a booking paid meanwhile is never expired.
        await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE "id" = ${row.id}::uuid FOR UPDATE`;
        const current = await tx.booking.findUniqueOrThrow({
          where: { id: row.id },
          select: { status: true, paymentStatus: true },
        });
        if (
          current.status !== BookingStatus.AWAITING_PAYMENT ||
          current.paymentStatus !== BookingPaymentStatus.UNPAID
        ) {
          return [];
        }
        await this.bookings.transition(tx, row, BookingStatus.EXPIRED, {
          kind: 'SYSTEM',
        });
        await this.availability.releaseBookingHolds(tx, row.id);
        closed = true;
        return this.notifyCustomer(tx, row, 'booking.expired', {});
      }
      if (!WAITING.includes(row.status)) return [];
      const newest = await this.quotes.newest(tx, row.id);
      const standing = quoteStanding(newest, now);
      // A live quote keeps the request open until it lapses (step 1).
      if (standing === 'LIVE') return [];
      const unanswered =
        row.status === BookingStatus.OPERATOR_PENDING && standing === 'NONE';
      if (standing === 'LAPSED' && newest?.status === QuoteStatus.SENT) {
        await this.quotes.move(tx, newest, 'expire', now, { system: true });
      }
      await this.bookings.transition(
        tx,
        row,
        unanswered ? BookingStatus.OPERATOR_UNAVAILABLE : BookingStatus.EXPIRED,
        { kind: 'SYSTEM' },
        { context: { quote: standing } },
      );
      await this.availability.releaseBookingHolds(tx, row.id);
      closed = true;
      return this.notifyCustomer(
        tx,
        row,
        unanswered ? 'booking.operator_unavailable' : 'booking.expired',
        {},
      );
    });
    return closed;
  }

  /** One item's failure never stops the job; the next run retries it. */
  private async safely<T>(work: () => Promise<T>): Promise<T | false> {
    try {
      return await work();
    } catch (error) {
      this.logger.error(
        `Booking hold expiry failed for one booking: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      return false;
    }
  }

  // --- Shared --------------------------------------------------------------

  /**
   * Runs `work` in a transaction holding the booking's lock, on the booking
   * read again under it, then sends the notifications it queued.
   */
  private async changeRequest(
    bookingId: string,
    work: (
      tx: Prisma.TransactionClient,
      row: BookingRow,
      now: Date,
    ) => Promise<string[]>,
  ): Promise<void> {
    const queued = await this.prisma.$transaction(async (tx) => {
      const key = `booking_request:${bookingId}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const row = await tx.booking.findUnique({
        where: { id: bookingId },
        include: BOOKING_INCLUDE,
      });
      if (!row) throw notFound();
      return work(tx, row, new Date());
    });
    for (const id of queued) await this.notifications.deliver(id);
  }

  /**
   * Business rules 3 and 4 before a price is confirmed or quoted: the
   * operator and aircraft are still approved and the aircraft in service,
   * the trip is still ahead, and the held time is still free (the hold is
   * kept until `until`, `BOOKING_HOLD_HOURS` from now by default).
   */
  private async assertBookable(
    tx: Prisma.TransactionClient,
    row: BookingRow,
    now: Date,
    audience: 'operator' | 'customer',
    until: Date = this.holdUntil(now),
  ): Promise<void> {
    const aircraft = row.aircraftId
      ? await tx.aircraft.findUnique({
          where: { id: row.aircraftId },
          select: {
            listingStatus: true,
            availabilityStatus: true,
            operator: { select: { status: true } },
          },
        })
      : null;
    const operatorApproved =
      aircraft?.operator.status === OperatorStatus.APPROVED;
    const aircraftReady =
      aircraft?.listingStatus === AircraftListingStatus.APPROVED &&
      aircraft.availabilityStatus === AircraftAvailabilityStatus.AVAILABLE;
    if (audience === 'operator' && !operatorApproved) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Your company is not approved to take bookings at the moment.',
        HttpStatus.CONFLICT,
      );
    }
    if (audience === 'operator' && !aircraftReady) {
      throw new AppException(
        'AIRCRAFT_NOT_APPROVED',
        'This aircraft is not approved or not in service, so it cannot be offered.',
        HttpStatus.CONFLICT,
      );
    }
    if (
      !operatorApproved ||
      !aircraftReady ||
      departureOf(row).getTime() <= now.getTime() ||
      !(await this.availability.recheckBookingHold(tx, row.id, until))
    ) {
      throw new AppException(
        'BOOKING_UNAVAILABLE',
        'This aircraft is no longer available for this trip.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Closes the request's open quote, if any, when the request ends. */
  private async closeOpenQuote(
    tx: Prisma.TransactionClient,
    bookingId: string,
    now: Date,
  ): Promise<void> {
    const open = await tx.quote.findMany({
      where: { bookingId, status: QuoteStatus.SENT },
    });
    for (const quote of open) await this.quotes.move(tx, quote, 'expire', now);
  }

  private holdHours(): number {
    return this.config.getOrThrow<number>('BOOKING_HOLD_HOURS');
  }

  private holdUntil(now: Date): Date {
    return new Date(now.getTime() + this.holdHours() * 3_600_000);
  }

  /**
   * The caller's reach, for staff with `MANAGE_BOOKINGS` (403 otherwise).
   * An operator that is not approved (suspended, under review) neither
   * reads nor answers requests: 409 `OPERATOR_NOT_APPROVED`, as accept and
   * quote already answered.
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

  /** The operator's bookings on aircraft within the caller's reach. */
  private scope(access: OperatorAccess): Prisma.BookingWhereInput {
    return {
      operatorId: access.operatorId,
      aircraft: aircraftWhere(access),
    };
  }

  private async operatorBooking(
    access: OperatorAccess,
    reference: string,
  ): Promise<{ id: string; reference: string }> {
    const row = await this.prisma.booking.findFirst({
      where: { reference, ...this.scope(access) },
      select: { id: true, reference: true },
    });
    if (!row) throw notFound();
    return row;
  }

  private async ownBooking(
    user: AuthUser,
    reference: string,
  ): Promise<{ id: string; reference: string }> {
    const row = await this.prisma.booking.findFirst({
      where: { reference, customerId: user.id },
      select: { id: true, reference: true },
    });
    if (!row) throw notFound();
    return row;
  }

  /** The caller's own quote (through its booking); anyone else's is 404. */
  private async ownQuote(
    user: AuthUser,
    reference: string,
  ): Promise<{ quote: QuoteRow; booking: { id: string; reference: string } }> {
    const quote = await this.quotes.byReference(reference);
    if (!quote?.bookingId || quote.status === QuoteStatus.DRAFT) {
      throw quoteNotFound();
    }
    const booking = await this.prisma.booking.findFirst({
      where: { id: quote.bookingId, customerId: user.id },
      select: { id: true, reference: true },
    });
    if (!booking) throw quoteNotFound();
    return { quote, booking };
  }

  private async event(
    tx: Prisma.TransactionClient,
    bookingId: string,
    type: BookingEventType,
    user: AuthUser,
    payload: Prisma.InputJsonValue,
  ): Promise<void> {
    await tx.bookingEvent.create({
      data: {
        bookingId,
        type,
        actorId: user.id,
        actorRole: user.role,
        payload,
      },
    });
  }

  private message(
    tx: Prisma.TransactionClient,
    bookingId: string,
    user: AuthUser,
    from: 'OPERATOR' | 'CUSTOMER',
    body: string,
  ): Promise<void> {
    return this.event(tx, bookingId, BookingEventType.MESSAGE, user, {
      from,
      body: this.cipher.encrypt(body),
    } satisfies TextPayload);
  }

  private async messagesOf(bookingId: string): Promise<BookingMessageDto[]> {
    const events = await this.prisma.bookingEvent.findMany({
      where: { bookingId, type: BookingEventType.MESSAGE },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return events.flatMap((event) => {
      const payload = event.payload as Partial<TextPayload> | null;
      if (!payload?.from || typeof payload.body !== 'string') return [];
      return [
        {
          from: payload.from,
          body: this.cipher.decrypt(payload.body),
          createdAt: event.createdAt.toISOString(),
        },
      ];
    });
  }

  private async notesOf(bookingId: string): Promise<BookingNoteDto[]> {
    const events = await this.prisma.bookingEvent.findMany({
      where: { bookingId, type: BookingEventType.NOTE },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return events.flatMap((event) => {
      const payload = event.payload as Partial<TextPayload> | null;
      if (
        payload?.visibility !== 'OPERATOR' ||
        typeof payload.body !== 'string'
      ) {
        return [];
      }
      return [
        {
          id: event.id,
          body: this.cipher.decrypt(payload.body),
          createdAt: event.createdAt.toISOString(),
        },
      ];
    });
  }

  /** Queues the customer's in-app message and email (reference only). */
  private async notifyCustomer(
    tx: Prisma.TransactionClient,
    row: BookingRow,
    templateKey: string,
    extra: Record<string, string>,
  ): Promise<string[]> {
    const variables = { reference: row.reference, ...extra };
    const ids = [
      await this.notifications.enqueue(
        {
          userId: row.customerId,
          channel: NotificationChannel.IN_APP,
          templateKey,
          variables,
        },
        tx,
      ),
    ];
    const account = (await this.users.summaries([row.customerId])).get(
      row.customerId,
    );
    if (account?.email) {
      ids.push(
        await this.notifications.enqueue(
          {
            userId: row.customerId,
            channel: NotificationChannel.EMAIL,
            to: account.email,
            templateKey,
            variables,
          },
          tx,
        ),
      );
    }
    return ids;
  }

  /** Queues an in-app message to the operator's administrators. */
  private async notifyOperator(
    tx: Prisma.TransactionClient,
    row: BookingRow,
    templateKey: string,
  ): Promise<string[]> {
    if (!row.operatorId) return [];
    const administrators = await this.operators.administrators(row.operatorId);
    const ids: string[] = [];
    for (const administrator of administrators) {
      ids.push(
        await this.notifications.enqueue(
          {
            userId: administrator.id,
            channel: NotificationChannel.IN_APP,
            templateKey,
            variables: { reference: row.reference },
          },
          tx,
        ),
      );
    }
    return ids;
  }

  private priceOf(row: BookingRow): BookingPriceDto | null {
    if (isQuoteRequest(row)) return null;
    return {
      priceType: row.priceType,
      amountMinor: minorToNumber(row.totalMinor),
      currency: row.currency,
      validUntil:
        row.priceType === PriceType.ESTIMATE && row.calculation
          ? row.calculation.validUntil.toISOString()
          : null,
    };
  }

  private toOperator(row: BookingRow, now: Date): OperatorBookingRequestDto {
    const itinerary = parseItinerary(row.itinerary);
    const newest = row.quotes[0] ?? null;
    return {
      reference: row.reference,
      status: row.status,
      category: row.category,
      aircraft: {
        id: row.aircraft?.id ?? itinerary.aircraft.id,
        registration: row.aircraft?.registration ?? '',
        manufacturer: itinerary.aircraft.manufacturer,
        model: itinerary.aircraft.model,
      },
      legs: itinerary.legs,
      passengerCount: itinerary.passengerCount,
      price: this.priceOf(row),
      holdExpiresAt: row.holds[0]?.expiresAt?.toISOString() ?? null,
      quote: newest ? this.quotes.toResponse(newest, row.reference, now) : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async detailOf(
    row: BookingRow,
  ): Promise<OperatorBookingRequestDetailDto> {
    const now = new Date();
    const [messages, notes, changeRequests, decided] = await Promise.all([
      this.messagesOf(row.id),
      this.notesOf(row.id),
      this.prisma.changeRequest.findMany({
        where: { bookingId: row.id },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      }),
      decisionNotes(this.prisma, this.cipher, row.id),
    ]);
    return {
      ...this.toOperator(row, now),
      itinerary: parseItinerary(row.itinerary),
      cancellationTerms: parseCancellationTerms(row.cancellationTerms),
      // Requests made before the field was encrypted are plain text.
      specialRequests:
        row.specialRequests === null || !isEncrypted(row.specialRequests)
          ? row.specialRequests
          : this.cipher.decrypt(row.specialRequests),
      quotes: row.quotes.map((quote) =>
        this.quotes.toResponse(quote, row.reference, now),
      ),
      messages,
      notes,
      changeRequests: changeRequests.map((request) =>
        changeRequestView(request, row.reference, decided, this.cipher),
      ),
    };
  }
}

/** The first departure of the booked trip. */
function departureOf(row: { itinerary: Prisma.JsonValue }): Date {
  return new Date(parseItinerary(row.itinerary).legs[0].departureAt);
}
