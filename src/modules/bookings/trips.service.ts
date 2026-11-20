import { HttpStatus, Injectable } from '@nestjs/common';
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
import { AvailabilityService } from '../availability/availability.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { OperatorsService } from '../operators/operators.service.js';
import { parseCancellationTerms, parseItinerary } from './booking-json.js';
import { CANCELLABLE } from './booking-transitions.js';
import { isQuoteRequest } from './booking-snapshot.js';
import { BookingsService } from './bookings.service.js';
import { evaluateCancellation } from './cancellation.js';
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
 */
@Injectable()
export class TripsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly operators: OperatorsService,
    private readonly availability: AvailabilityService,
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
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.booking.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.booking.count({ where }),
    ]);
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
    return quoteFor(booking, new Date());
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
      const quote = quoteFor(booking, now);
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
              issue:
                quote.refundMinor === null ? 'null' : String(quote.refundMinor),
            },
          ],
        );
      }
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
        { kind: 'CUSTOMER', user },
        { event: { cancellation: applied } },
      );
      // The request has ended: the aircraft's time is offered again at once.
      await this.availability.releaseBookingHolds(tx, booking.id);
      // The time the transition stamped, so the answer matches the record.
      const { cancelledAt } = await tx.booking.update({
        where: { id: booking.id },
        data:
          input.reason === undefined
            ? {}
            : { cancellationReason: input.reason },
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
          details: CANCELLED_BY_CUSTOMER,
          chargeMinor: BigInt(quote.chargeMinor),
          refundMinor:
            quote.refundMinor === null ? null : BigInt(quote.refundMinor),
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
            ...applied,
          },
        },
        tx,
      );
      return {
        reference: booking.reference,
        status: BookingStatus.CANCELLED,
        cancelledAt: cancelledAt.toISOString(),
        cancellation: quoteFor(booking, now, BookingStatus.CANCELLED),
      };
    });
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
            details: input.details,
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
        return changeRequestView(row, booking.reference, new Map());
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
          payload: decisionPayload(id, input.decision, input.note),
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
      const notes = await decisionNotes(tx, row.booking.id);
      return changeRequestView(
        {
          ...row,
          status: input.decision,
          decidedById: user.id,
          decidedAt: now,
        },
        row.booking.reference,
        notes,
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

function quoteFor(
  booking: BookingRow,
  now: Date,
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
    paymentStatus: booking.paymentStatus,
  });
  const refundMinor =
    outcome.refundMinor === null ? null : minorToNumber(outcome.refundMinor);
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
    paidMinor:
      outcome.paidMinor === null ? null : minorToNumber(outcome.paidMinor),
    refundMinor,
    explanation: explain(outcome, booking.priceType),
    evaluatedAt: now.toISOString(),
  };
}

function explain(
  outcome: ReturnType<typeof evaluateCancellation>,
  priceType: PriceType,
): string {
  const refund =
    outcome.refundMinor === null
      ? ' What is refunded is worked out from your payments.'
      : '';
  if (!outcome.appliedCharge) {
    return `These terms carry no cancellation charge.${refund}`;
  }
  const percent = outcome.appliedCharge.chargePercent;
  if (!outcome.amountKnown) {
    return `The operator’s terms charge ${percent}% at this notice, but the price is not confirmed yet (${priceType}), so nothing is charged.${refund}`;
  }
  return `The operator’s terms charge ${percent}% of the confirmed price at this notice.${refund}`;
}
