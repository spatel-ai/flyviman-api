import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { minorToNumber } from '../../common/money.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  BookingEventType,
  BookingStatus,
  ChangeRequestKind,
  ChangeRequestStatus,
  OperatorStatus,
  PriceType,
  Role,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertCan } from '../operators/operator-access.js';
import { NotificationEventsService } from '../notifications/events/notification-events.service.js';
import { OperatorsService } from '../operators/operators.service.js';
import { parseCancellationTerms, parseItinerary } from './booking-json.js';
import { CANCELLABLE } from './booking-transitions.js';
import {
  bookingIdsByDeparture,
  CREATED_DESC,
  inIdOrder,
} from './departure-order.js';
import { isQuoteRequest } from './booking-snapshot.js';
import { BookingsService } from './bookings.service.js';
import { evaluateCancellation } from './cancellation.js';
import { readPaidMinor } from './paid-amount.js';
import { paymentInProgressWhere } from './payment-in-progress.js';
import {
  changeRequestView,
  decisionNotes,
  decisionPayload,
} from './change-requests.js';
import type { ChangeRequestResponseDto } from './dto/booking.dto.js';
import type {
  BookingCancelledDto,
  CancelBookingDto,
  CancellationQuoteDto,
  CreateChangeRequestDto,
  DecideChangeRequestDto,
  TripSummaryDto,
  TripsQueryDto,
} from './dto/trips.dto.js';

type BookingRow = Prisma.BookingGetPayload<object>;

/** The note on a change request closed because its booking was cancelled. */
const CLOSED_BY_CANCELLATION = 'Closed because the booking was cancelled.';

/** What a customer-made cancellation request records as its details. */
const CANCELLED_BY_CUSTOMER = 'Cancelled by the customer.';

/** What a cancellation by operations (status override) records. */
const CANCELLED_BY_OPERATIONS = 'Cancelled by Flyviman operations.';

/** What an operator's cancellation records (its reason is kept apart). */
const CANCELLED_BY_OPERATOR = 'Cancelled by the operator.';

function notFound(what = 'Booking'): AppException {
  return new AppException(
    'NOT_FOUND',
    `${what} not found.`,
    HttpStatus.NOT_FOUND,
  );
}

function notCancellable(status: BookingStatus): AppException {
  return new AppException(
    'BOOKING_NOT_CANCELLABLE',
    'This booking can no longer be cancelled.',
    HttpStatus.CONFLICT,
    [{ field: 'status', issue: status }],
  );
}

/**
 * The customer's trips (M8): the list, the cancellation quote and the
 * cancellation itself (rule 9: the charge is shown, then echoed back), and
 * change requests with the operator's or operations' decision. Status moves
 * go through `BookingsService.transition`. No passenger data, special
 * requests or free text reaches the audit trail or the events' payloads,
 * except a decision's note, which is written to be shown to the customer.
 * Free text (a request's details, a decision's note, the cancellation
 * reason) is encrypted at rest (`FieldCipher`).
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly operators: OperatorsService,
    private readonly cipher: FieldCipher,
    private readonly events: NotificationEventsService,
  ) {}

  async list(
    user: AuthUser,
    query: TripsQueryDto,
  ): Promise<{ items: TripSummaryDto[]; total: number }> {
    const upcoming = query.view === 'upcoming';
    const where: Prisma.BookingWhereInput = {
      customerId: user.id,
      status: upcoming ? { in: [...CANCELLABLE] } : { notIn: [...CANCELLABLE] },
    };
    let rows: Prisma.BookingGetPayload<object>[];
    let total: number;
    if (query.sort === 'created_desc') {
      [rows, total] = await this.prisma.$transaction([
        this.prisma.booking.findMany({
          where,
          orderBy: CREATED_DESC,
          skip: (query.page - 1) * query.pageSize,
          take: query.pageSize,
        }),
        this.prisma.booking.count({ where }),
      ]);
    } else {
      const picked = await bookingIdsByDeparture(
        this.prisma,
        where,
        query.sort,
        query.page,
        query.pageSize,
      );
      total = picked.total;
      rows = inIdOrder(
        await this.prisma.booking.findMany({
          where: { AND: [where, { id: { in: picked.ids } }] },
        }),
        picked.ids,
      );
    }
    return {
      items: rows.map((row) => {
        const itinerary = parseItinerary(row.itinerary);
        const [first] = itinerary.legs;
        return {
          reference: row.reference,
          category: row.category,
          status: row.status,
          paymentStatus: row.paymentStatus,
          // The list carries no validity; the detail does.
          price: isQuoteRequest(row)
            ? null
            : {
                priceType: row.priceType,
                amountMinor: minorToNumber(row.totalMinor),
                currency: row.currency,
                validUntil: null,
              },
          tripType: itinerary.tripType,
          originName: first.originName,
          destinationName: first.destinationName,
          departureAt: first.departureAt,
          passengerCount: itinerary.passengerCount,
          createdAt: row.createdAt.toISOString(),
        };
      }),
      total,
    };
  }

  /** What cancelling now would cost; 409 when it can no longer be cancelled. */
  async cancellationQuote(
    user: AuthUser,
    reference: string,
  ): Promise<CancellationQuoteDto> {
    const booking = await this.prisma.booking.findFirst({
      where: { reference, customerId: user.id },
    });
    if (!booking) throw notFound();
    if (!CANCELLABLE.includes(booking.status)) {
      throw notCancellable(booking.status);
    }
    const paidMinor = await readPaidMinor(this.prisma, booking.id);
    return quoteFor(booking, new Date(), paidMinor);
  }

  /**
   * Cancels the caller's booking at the charge they were shown. In one
   * transaction: the idempotency key, the move to CANCELLED (with the terms
   * applied and the refund due on its event), a completed CANCELLATION
   * request holding the charge and the refund due (refunds pick it up,
   * M9), open change requests closed, and the audit record.
   */
  async cancel(
    user: AuthUser,
    reference: string,
    input: CancelBookingDto,
    claim: IdempotencyClaim,
  ): Promise<BookingCancelledDto> {
    return this.prisma.$transaction(async (tx) => {
      await markIdempotencyCommitted(tx, claim);
      const booking = await lockOwn(tx, reference, user.id);
      if (!CANCELLABLE.includes(booking.status)) {
        throw notCancellable(booking.status);
      }
      const now = new Date();
      // Read under the booking's lock: payments write after locking it too.
      const paidMinor = await readPaidMinor(tx, booking.id);
      const quote = quoteFor(booking, now, paidMinor);
      if (
        quote.chargeMinor !== input.expectedChargeMinor ||
        quote.currency !== input.currency
      ) {
        throw new AppException(
          'BOOKING_CANCELLATION_CHANGED',
          'The cancellation charge has changed since it was shown.',
          HttpStatus.CONFLICT,
          [
            { field: 'chargeMinor', issue: String(quote.chargeMinor) },
            { field: 'currency', issue: quote.currency },
            {
              field: 'refundMinor',
              issue: String(quote.refundMinor),
            },
          ],
        );
      }
      const cancelledAt = await this.applyCancellation(
        tx,
        booking,
        quote,
        now,
        {
          kind: 'CUSTOMER',
          user,
          reason: input.reason,
        },
      );
      return {
        reference: booking.reference,
        status: BookingStatus.CANCELLED,
        cancelledAt: cancelledAt.toISOString(),
        cancellation: quoteFor(
          booking,
          now,
          paidMinor,
          BookingStatus.CANCELLED,
        ),
      };
    });
  }

  /**
   * What cancelling `booking` costs now (the same evaluation the customer
   * is shown, rule 9), for a cancellation by operations, with what was
   * paid read in the caller's transaction, under the booking's lock (W4-1).
   */
  async quoteForCancellation(
    tx: Prisma.TransactionClient,
    booking: BookingRow,
    now: Date,
  ): Promise<CancellationQuoteDto> {
    return quoteFor(booking, now, await readPaidMinor(tx, booking.id));
  }

  /**
   * Cancels a booking already locked by the caller's transaction, at
   * `quote`: the move to CANCELLED (the terms applied and the refund due on
   * its event; an operations override with its reason), the hold released
   * and any open quote closed `EXPIRED`, a completed CANCELLATION request
   * holding the charge and the refund due (refunds pick it up, M9), open
   * change requests closed, and the audit record. The customer's own
   * cancellation, the operator's and the override to CANCELLED all come
   * here (the caller decides the charge in `quote`). Returns the
   * time the transition stamped.
   */
  async applyCancellation(
    tx: Prisma.TransactionClient,
    booking: BookingRow,
    quote: CancellationQuoteDto,
    now: Date,
    by:
      | { kind: 'CUSTOMER' | 'OPERATOR'; user: AuthUser; reason?: string }
      | { kind: 'OPERATIONS'; user: AuthUser; overrideReason: string },
  ): Promise<Date> {
    await assertNoPaymentPending(tx, booking.id);
    const { user } = by;
    const applied = {
      termsSource: quote.terms.source,
      appliedCharge: quote.appliedCharge && {
        minHoursBeforeDeparture: quote.appliedCharge.minHoursBeforeDeparture,
        chargePercent: quote.appliedCharge.chargePercent,
      },
      hoursBeforeDeparture: quote.hoursBeforeDeparture,
      amountKnown: quote.amountKnown,
      chargeMinor: quote.chargeMinor,
      refundMinor: quote.refundMinor,
      currency: quote.currency,
    };
    await this.bookings.transition(
      tx,
      booking,
      BookingStatus.CANCELLED,
      { kind: by.kind, user },
      {
        event: { cancellation: applied },
        ...(by.kind === 'OPERATIONS'
          ? { override: { reason: by.overrideReason } }
          : {}),
      },
    );
    // The request has ended: the aircraft's time is offered again at once,
    // and a quote still open closes.
    await this.bookings.endRequest(tx, booking.id, now);
    const reason = by.kind === 'OPERATIONS' ? undefined : by.reason;
    // The time the transition stamped, so the answer matches the record.
    const { cancelledAt } = await tx.booking.update({
      where: { id: booking.id },
      data:
        reason === undefined
          ? {}
          : { cancellationReason: this.cipher.encrypt(reason) },
      select: { cancelledAt: true },
    });
    if (!cancelledAt)
      throw new Error('A cancelled booking has no cancelledAt.');
    const open = await tx.changeRequest.findMany({
      where: { bookingId: booking.id, status: ChangeRequestStatus.REQUESTED },
      select: { id: true },
    });
    let closed = 0;
    for (const { id } of open) {
      // Only if still open: a decision made meanwhile stands.
      const { count } = await tx.changeRequest.updateMany({
        where: { id, status: ChangeRequestStatus.REQUESTED },
        data: {
          status: ChangeRequestStatus.REJECTED,
          decidedById: user.id,
          decidedAt: now,
        },
      });
      if (count !== 1) continue;
      closed += 1;
      await tx.bookingEvent.create({
        data: {
          bookingId: booking.id,
          type: BookingEventType.NOTE,
          actorId: user.id,
          actorRole: user.role,
          payload: decisionPayload(
            this.cipher,
            id,
            ChangeRequestStatus.REJECTED,
            CLOSED_BY_CANCELLATION,
          ),
        },
      });
    }
    const request = await tx.changeRequest.create({
      data: {
        bookingId: booking.id,
        kind: ChangeRequestKind.CANCELLATION,
        details: this.cipher.encrypt(
          by.kind === 'CUSTOMER'
            ? CANCELLED_BY_CUSTOMER
            : by.kind === 'OPERATOR'
              ? CANCELLED_BY_OPERATOR
              : CANCELLED_BY_OPERATIONS,
        ),
        chargeMinor: BigInt(quote.chargeMinor),
        refundMinor: BigInt(quote.refundMinor),
        currency: quote.currency,
        status: ChangeRequestStatus.COMPLETED,
        decidedById: user.id,
        decidedAt: now,
      },
    });
    await this.audit.record(
      {
        action: 'booking.cancel',
        entityType: 'Booking',
        entityId: booking.id,
        before: { reference: booking.reference, status: booking.status },
        after: {
          reference: booking.reference,
          status: BookingStatus.CANCELLED,
          changeRequestId: request.id,
          closedChangeRequests: closed,
          cancelledBy: by.kind,
          ...applied,
        },
      },
      tx,
    );
    return cancelledAt;
  }

  /** A customer's free-text change request; one open per booking. */
  async requestChange(
    user: AuthUser,
    reference: string,
    input: CreateChangeRequestDto,
  ): Promise<ChangeRequestResponseDto> {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const booking = await lockOwn(tx, reference, user.id);
        if (!CANCELLABLE.includes(booking.status)) {
          throw new AppException(
            'CHANGE_REQUEST_NOT_ALLOWED',
            'Changes can be requested only while a booking is in progress.',
            HttpStatus.CONFLICT,
            [{ field: 'status', issue: booking.status }],
          );
        }
        const row = await tx.changeRequest.create({
          data: {
            bookingId: booking.id,
            kind: ChangeRequestKind.CHANGE,
            details: this.cipher.encrypt(input.details),
            currency: booking.currency,
          },
        });
        await tx.bookingEvent.create({
          data: {
            bookingId: booking.id,
            type: BookingEventType.CHANGE_REQUESTED,
            actorId: user.id,
            actorRole: user.role,
            payload: { changeRequestId: row.id },
          },
        });
        // The details are the customer's words: not in the audit trail.
        await this.audit.record(
          {
            action: 'changeRequest.create',
            entityType: 'ChangeRequest',
            entityId: row.id,
            after: {
              bookingReference: booking.reference,
              kind: row.kind,
              status: row.status,
            },
          },
          tx,
        );
        await this.events.notifyBooking(
          tx,
          'booking.change_requested',
          booking.id,
        );
        return changeRequestView(
          row,
          booking.reference,
          new Map(),
          this.cipher,
        );
      });
    } catch (error) {
      if (
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new AppException(
          'CHANGE_REQUEST_OPEN',
          'This booking already has a change request waiting for an answer.',
          HttpStatus.CONFLICT,
        );
      }
      throw error;
    }
  }

  /**
   * Approves or declines an open change request. Operator administrators
   * decide for their operator's bookings, staff for bookings on aircraft in
   * their reach; operations for any booking. Anything else is 404. A price
   * change goes through a revised quote, not here.
   */
  async decide(
    user: AuthUser,
    id: string,
    input: DecideChangeRequestDto,
  ): Promise<ChangeRequestResponseDto> {
    const scope = await this.scopeFor(user);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.changeRequest.findUnique({
        where: { id },
        include: {
          booking: {
            select: {
              id: true,
              reference: true,
              operatorId: true,
              aircraftId: true,
            },
          },
        },
      });
      if (
        !row ||
        row.kind !== ChangeRequestKind.CHANGE ||
        !scope(row.booking)
      ) {
        throw notFound('Change request');
      }
      const now = new Date();
      const { count } = await tx.changeRequest.updateMany({
        where: { id, status: ChangeRequestStatus.REQUESTED },
        data: { status: input.decision, decidedById: user.id, decidedAt: now },
      });
      if (count !== 1) {
        throw new AppException(
          'CHANGE_REQUEST_DECIDED',
          'This change request has already been answered.',
          HttpStatus.CONFLICT,
          [{ field: 'status', issue: row.status }],
        );
      }
      await tx.bookingEvent.create({
        data: {
          bookingId: row.booking.id,
          type: BookingEventType.NOTE,
          actorId: user.id,
          actorRole: user.role,
          payload: decisionPayload(this.cipher, id, input.decision, input.note),
        },
      });
      // The note is free text: kept on the timeline, not in the audit trail.
      await this.audit.record(
        {
          action: 'changeRequest.decide',
          entityType: 'ChangeRequest',
          entityId: id,
          before: { status: ChangeRequestStatus.REQUESTED },
          after: {
            bookingReference: row.booking.reference,
            status: input.decision,
          },
        },
        tx,
      );
      await this.events.notifyBooking(
        tx,
        'booking.change_decided',
        row.booking.id,
        {
          decision:
            input.decision === ChangeRequestStatus.APPROVED
              ? 'approved'
              : 'declined',
        },
      );
      const notes = await decisionNotes(tx, this.cipher, row.booking.id);
      return changeRequestView(
        {
          ...row,
          status: input.decision,
          decidedById: user.id,
          decidedAt: now,
        },
        row.booking.reference,
        notes,
        this.cipher,
      );
    });
  }

  /** Which bookings the caller may decide requests on. */
  private async scopeFor(
    user: AuthUser,
  ): Promise<
    (booking: {
      operatorId: string | null;
      aircraftId: string | null;
    }) => boolean
  > {
    if (user.role === Role.OPS || user.role === Role.SUPER_ADMIN) {
      return () => true;
    }
    const { operator, access } = await this.operators.accessFor(user);
    assertCan(access, 'MANAGE_BOOKINGS');
    if (operator.status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can answer change requests.',
        HttpStatus.CONFLICT,
      );
    }
    return (booking) =>
      booking.operatorId === access.operatorId &&
      (access.aircraft === 'ALL' ||
        (booking.aircraftId !== null &&
          access.aircraft.includes(booking.aircraftId)));
  }
}

/**
 * The caller's booking, locked for the rest of the transaction so a
 * cancellation and a change request cannot cross; anyone else's is 404.
 */
async function lockOwn(
  tx: Prisma.TransactionClient,
  reference: string,
  customerId: string,
): Promise<BookingRow> {
  const found = await tx.booking.findFirst({
    where: { reference, customerId },
    select: { id: true },
  });
  if (!found) throw notFound();
  await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE id = ${found.id}::uuid FOR UPDATE`;
  return tx.booking.findUniqueOrThrow({ where: { id: found.id } });
}

/**
 * 409 `BOOKING_PAYMENT_IN_PROGRESS` while a payment waits for the gateway's
 * final answer (`PENDING`): money may be moving, so the refund the
 * cancellation records could be wrong. An order the customer never paid
 * (`INITIATED`) does not block; if it is captured later, the payment is
 * recorded and flagged `BOOKING_CLOSED` for a refund. The payments table is
 * read directly here (payments depends on bookings, not the other way).
 */
async function assertNoPaymentPending(
  tx: Prisma.TransactionClient,
  bookingId: string,
): Promise<void> {
  const pending = await tx.payment.count({
    where: { bookingId, ...paymentInProgressWhere() },
  });
  if (pending > 0) {
    throw new AppException(
      'BOOKING_PAYMENT_IN_PROGRESS',
      'A payment for this booking is still being processed. Try again in a few minutes.',
      HttpStatus.CONFLICT,
    );
  }
}

/**
 * `paidMinor` is required (W4-1): every caller reads it with
 * `readPaidMinor`, under the booking's lock when it cancels.
 */
function quoteFor(
  booking: BookingRow,
  now: Date,
  paidMinor: bigint,
  status: BookingStatus = booking.status,
): CancellationQuoteDto {
  const terms = parseCancellationTerms(booking.cancellationTerms);
  const itinerary = parseItinerary(booking.itinerary);
  const outcome = evaluateCancellation({
    terms,
    departureAt: itinerary.legs[0].departureAt,
    now,
    totalMinor: booking.totalMinor,
    priceType: booking.priceType,
    paidMinor,
  });
  const refundMinor = minorToNumber(outcome.refundMinor);
  return {
    reference: booking.reference,
    status,
    terms,
    hoursBeforeDeparture: outcome.hoursBeforeDeparture,
    appliedCharge: outcome.appliedCharge,
    priceType: booking.priceType,
    totalMinor: isQuoteRequest(booking)
      ? null
      : minorToNumber(booking.totalMinor),
    currency: booking.currency,
    amountKnown: outcome.amountKnown,
    chargeMinor: minorToNumber(outcome.chargeMinor),
    paidMinor: minorToNumber(outcome.paidMinor),
    refundMinor,
    explanation: explain(outcome, booking.priceType),
    evaluatedAt: now.toISOString(),
  };
}

const PRICE_TYPE_WORDS: Record<PriceType, string> = {
  ESTIMATE: 'an estimate',
  QUOTE: 'a quote',
  LIVE_FARE: 'a live fare',
  CONFIRMED: 'confirmed',
};

export function explain(
  outcome: ReturnType<typeof evaluateCancellation>,
  priceType: PriceType,
): string {
  if (!outcome.appliedCharge) {
    return 'These terms carry no cancellation charge.';
  }
  const percent = outcome.appliedCharge.chargePercent;
  if (!outcome.amountKnown) {
    return `Flyviman’s cancellation terms charge ${percent}% at this notice, but the price is still ${PRICE_TYPE_WORDS[priceType]}, so nothing is charged.`;
  }
  return `Flyviman’s cancellation terms charge ${percent}% of the confirmed price at this notice.`;
}
