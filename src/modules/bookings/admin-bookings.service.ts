import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher, isEncrypted } from '../../common/crypto/field-cipher.js';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import { minorToNumber } from '../../common/money.js';
import { day } from '../../common/validation/formats.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  BookingEventType,
  BookingStatus,
  PriceType,
  Role,
  UserStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AvailabilityService } from '../availability/availability.service.js';
import { BOOKING_ENDED } from '../empty-legs/empty-leg-rules.js';
import { QuotesService } from '../quotes/quotes.service.js';
import { UsersService } from '../users/users.service.js';
import { parseCancellationTerms, parseItinerary } from './booking-json.js';
import { isQuoteRequest, lastFour } from './booking-snapshot.js';
import { BookingsService } from './bookings.service.js';
import { changeRequestView, decisionNotes } from './change-requests.js';
import { violatesLiveEmptyLeg } from './empty-leg-bookings.service.js';
import type {
  AdminBookingDetailDto,
  AdminBookingEscalationDto,
  AdminBookingEventDto,
  AdminBookingQueryDto,
  AdminBookingSummaryDto,
  OverrideBookingStatusDto,
} from './dto/admin-booking.dto.js';
import type { BookingPriceDto } from './dto/booking.dto.js';
import type { BookingNoteDto } from './dto/booking-request.dto.js';
import { TripsService } from './trips.service.js';

const SUMMARY_INCLUDE = {
  customer: { select: { id: true, email: true, phone: true } },
  operator: { select: { id: true, legalName: true, tradingName: true } },
  aircraft: { select: { registration: true } },
} satisfies Prisma.BookingInclude;

type SummaryRow = Prisma.BookingGetPayload<{ include: typeof SUMMARY_INCLUDE }>;

/** Statuses that end a request: the hold is released, an open quote closed. */
const ENDING: readonly BookingStatus[] = [
  BookingStatus.EXPIRED,
  BookingStatus.QUOTE_DECLINED,
  BookingStatus.OPERATOR_UNAVAILABLE,
];

/** The latest date there is: a hold rechecked "until the trip ends". */
const END_OF_TIME = new Date(8_640_000_000_000_000);

/** `BookingEvent.payload` of an operations note; the body is encrypted. */
interface OperationsNotePayload {
  visibility: 'OPERATIONS';
  body: string;
}

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Booking not found.',
    HttpStatus.NOT_FOUND,
  );
}

/** Finance reads bookings without passenger details or free text (rule 8). */
function restricted(user: AuthUser): boolean {
  return user.role !== Role.OPS && user.role !== Role.SUPER_ADMIN;
}

/**
 * Bookings for Flyviman staff (M8): search and detail (operations, finance,
 * super administrators; finance without passenger details, special
 * requests, notes or other free text), the operations owner, internal
 * notes, and the status override with a reason (operations and super
 * administrators). Status moves go through `BookingsService.transition`;
 * an override to CANCELLED goes through the customer's cancellation path
 * (`TripsService.applyCancellation`), terms and refund due included.
 *
 * Payments are read from their table here: the payments module depends on
 * bookings, so bookings cannot use its service.
 */
@Injectable()
export class AdminBookingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly trips: TripsService,
    private readonly quotes: QuotesService,
    private readonly availability: AvailabilityService,
    private readonly users: UsersService,
    private readonly cipher: FieldCipher,
  ) {}

  async list(
    query: AdminBookingQueryDto,
  ): Promise<Paginated<AdminBookingSummaryDto>> {
    const where: Prisma.BookingWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.paymentStatus ? { paymentStatus: query.paymentStatus } : {}),
      ...(query.category ? { category: query.category } : {}),
      ...(query.operatorId ? { operatorId: query.operatorId } : {}),
      ...(query.escalated ? { escalatedAt: { not: null } } : {}),
      ...(query.from || query.to
        ? {
            createdAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lt: new Date(query.to) } : {}),
            },
          }
        : {}),
      ...(query.q ? { OR: searchTerms(query.q.trim()) } : {}),
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
  ): Promise<AdminBookingDetailDto> {
    const row = await this.prisma.booking.findUnique({
      where: { reference },
      include: {
        ...SUMMARY_INCLUDE,
        passengers: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        changeRequests: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
        events: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
        payments: { orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] },
      },
    });
    if (!row) throw notFound();
    const hide = restricted(user);
    const now = new Date();
    const [quotes, notes] = await Promise.all([
      this.quotes.forBooking(row.id),
      decisionNotes(this.prisma, this.cipher, row.id),
    ]);
    return {
      ...summaryOf(row),
      bookingMode: row.bookingMode,
      paymentModel: row.paymentModel,
      itinerary: parseItinerary(row.itinerary),
      cancellationTerms: parseCancellationTerms(row.cancellationTerms),
      operatorAcceptedAt: row.operatorAcceptedAt?.toISOString() ?? null,
      confirmedAt: row.confirmedAt?.toISOString() ?? null,
      cancelledAt: row.cancelledAt?.toISOString() ?? null,
      passengers: hide
        ? null
        : row.passengers.map((passenger) => ({
            firstName: passenger.firstName,
            lastName: passenger.lastName,
            dateOfBirth: day(passenger.dateOfBirth),
            gender: passenger.gender,
            nationality: passenger.nationality,
            documentType: passenger.documentType,
            documentNumberLast4: lastFour(
              this.reveal(passenger.documentNumber),
            ),
            documentExpiry: day(passenger.documentExpiry),
            specialAssistance: this.reveal(passenger.specialAssistance),
          })),
      specialRequests: hide ? null : this.revealLegacy(row.specialRequests),
      events: row.events.map((event) => eventOf(event, this.cipher)),
      notes: hide ? null : this.notesOf(row.events),
      quotes: quotes.map((quote) =>
        this.quotes.toResponse(quote, row.reference, now),
      ),
      changeRequests: row.changeRequests.map((request) => {
        const view = changeRequestView(
          request,
          row.reference,
          notes,
          this.cipher,
        );
        return hide ? { ...view, details: '', decisionNote: null } : view;
      }),
      escalation: escalationOf(row, this.cipher),
      payments: row.payments.map((payment) => ({
        reference: payment.reference,
        purpose: payment.purpose,
        status: payment.status,
        price: {
          priceType: PriceType.CONFIRMED,
          amountMinor: minorToNumber(payment.amountMinor),
          currency: payment.currency,
          validUntil: null,
        },
        reviewReason: payment.reviewReason,
        paidAt: payment.paidAt?.toISOString() ?? null,
        createdAt: payment.createdAt.toISOString(),
      })),
    };
  }

  /**
   * Sets the operations owner (an active `OPS` or `SUPER_ADMIN` account),
   * or removes it with `null`. Audited, before and after.
   */
  async assign(
    user: AuthUser,
    reference: string,
    assigneeId: string | null,
  ): Promise<AdminBookingDetailDto> {
    if (assigneeId !== null) {
      const account = (await this.users.summaries([assigneeId])).get(
        assigneeId,
      );
      const eligible =
        account !== undefined &&
        account.status === UserStatus.ACTIVE &&
        (account.role === Role.OPS || account.role === Role.SUPER_ADMIN);
      if (!eligible) {
        throw new AppException(
          'VALIDATION_ERROR',
          'The request is not valid.',
          HttpStatus.BAD_REQUEST,
          [
            {
              field: 'assigneeId',
              issue: 'must be an active operations user or super administrator',
            },
          ],
        );
      }
    }
    await this.prisma.$transaction(async (tx) => {
      const row = await lockByReference(tx, reference);
      if (row.assignedToId === assigneeId) return;
      await tx.booking.update({
        where: { id: row.id },
        data: { assignedToId: assigneeId },
      });
      await this.audit.record(
        {
          action: 'booking.assign',
          entityType: 'Booking',
          entityId: row.id,
          before: { reference: row.reference, assignedToId: row.assignedToId },
          after: { reference: row.reference, assignedToId: assigneeId },
        },
        tx,
      );
    });
    return this.detail(user, reference);
  }

  /**
   * An internal note for Flyviman staff, stored encrypted on the booking's
   * timeline. Never shown to the customer, the operator or finance; kept
   * out of the audit trail, as free text.
   */
  async addNote(
    user: AuthUser,
    reference: string,
    note: string,
  ): Promise<BookingNoteDto> {
    const booking = await this.prisma.booking.findUnique({
      where: { reference },
      select: { id: true },
    });
    if (!booking) throw notFound();
    const created = await this.prisma.bookingEvent.create({
      data: {
        bookingId: booking.id,
        type: BookingEventType.NOTE,
        actorId: user.id,
        actorRole: user.role,
        payload: {
          visibility: 'OPERATIONS',
          body: this.cipher.encrypt(note),
        } satisfies OperationsNotePayload,
      },
    });
    return {
      id: created.id,
      body: note,
      createdAt: created.createdAt.toISOString(),
    };
  }

  /**
   * Operations' manual override (state-machines.md: any status to any
   * other, with a recorded reason, audited before and after through the
   * transition). To CANCELLED it applies the cancellation terms and records
   * the refund due exactly as a customer's cancellation does; to a status
   * that ends the request it releases the hold and closes an open quote; to
   * CONFIRMED it rechecks and keeps the held time first (rule 3, 409
   * `BOOKING_UNAVAILABLE` when it is taken). Takes the booking's request
   * lock, then its row, as every other booking change does.
   */
  async overrideStatus(
    user: AuthUser,
    reference: string,
    input: OverrideBookingStatusDto,
  ): Promise<AdminBookingDetailDto> {
    const found = await this.prisma.booking.findUnique({
      where: { reference },
      select: { id: true },
    });
    if (!found) throw notFound();
    try {
      await this.overrideIn(user, found.id, reference, input);
    } catch (error) {
      // The partial unique index is the backstop to `assertOfferFree`.
      if (violatesLiveEmptyLeg(error)) throw offerTaken();
      throw error;
    }
    return this.detail(user, reference);
  }

  private overrideIn(
    user: AuthUser,
    id: string,
    reference: string,
    input: OverrideBookingStatusDto,
  ): Promise<void> {
    return this.prisma.$transaction(async (tx) => {
      const key = `booking_request:${id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const row = await lockByReference(tx, reference);
      const now = new Date();
      await assertOfferFree(tx, row, input.status);
      if (input.status === BookingStatus.CANCELLED) {
        const quote = await this.trips.quoteForCancellation(tx, row, now);
        await this.trips.applyCancellation(tx, row, quote, now, {
          kind: 'OPERATIONS',
          user,
          overrideReason: input.reason,
        });
        return;
      }
      if (
        input.status === BookingStatus.CONFIRMED &&
        row.status !== BookingStatus.CONFIRMED &&
        row.aircraftId !== null &&
        !(await this.availability.recheckBookingHold(tx, row.id, END_OF_TIME))
      ) {
        throw new AppException(
          'BOOKING_UNAVAILABLE',
          'This aircraft is no longer available for this trip.',
          HttpStatus.CONFLICT,
        );
      }
      await this.bookings.transition(
        tx,
        row,
        input.status,
        { kind: 'OPERATIONS', user },
        { override: { reason: input.reason } },
      );
      if (ENDING.includes(input.status)) {
        await this.bookings.endRequest(tx, row.id, now);
      }
    });
  }

  private notesOf(
    events: {
      id: string;
      type: BookingEventType;
      payload: unknown;
      createdAt: Date;
    }[],
  ): BookingNoteDto[] {
    return events.flatMap((event) => {
      const payload = event.payload as Partial<OperationsNotePayload> | null;
      if (
        event.type !== BookingEventType.NOTE ||
        payload?.visibility !== 'OPERATIONS' ||
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

  private reveal(stored: string | null): string | null {
    return stored === null ? null : this.cipher.decrypt(stored);
  }

  private revealLegacy(stored: string | null): string | null {
    return stored === null || !isEncrypted(stored)
      ? stored
      : this.cipher.decrypt(stored);
  }
}

function offerTaken(): AppException {
  return new AppException(
    'BOOKING_UNAVAILABLE',
    'Another booking holds this empty leg, so this one cannot be reopened.',
    HttpStatus.CONFLICT,
  );
}

/**
 * Reviving an ended empty-leg booking (M8-C) needs its offer free: another
 * live booking of the offer is 409 `BOOKING_UNAVAILABLE`, not the partial
 * unique index's failure. Under the offer's row lock, which a customer's
 * request takes too (`EmptyLegsService.forBooking`), so the two are made one
 * after the other; the booking's row is locked first, as a confirmation
 * locks it before marking the offer booked.
 */
async function assertOfferFree(
  tx: Prisma.TransactionClient,
  row: Prisma.BookingGetPayload<object>,
  to: BookingStatus,
): Promise<void> {
  if (
    row.emptyLegId === null ||
    !BOOKING_ENDED.includes(row.status) ||
    BOOKING_ENDED.includes(to)
  ) {
    return;
  }
  await tx.$queryRaw`SELECT 1 FROM "EmptyLeg" WHERE "id" = ${row.emptyLegId}::uuid FOR UPDATE`;
  const other = await tx.booking.findFirst({
    where: {
      emptyLegId: row.emptyLegId,
      id: { not: row.id },
      status: { notIn: BOOKING_ENDED },
    },
    select: { id: true },
  });
  if (other) throw offerTaken();
}

/** The booking by reference, locked (`FOR UPDATE`) for the transaction. */
async function lockByReference(
  tx: Prisma.TransactionClient,
  reference: string,
): Promise<Prisma.BookingGetPayload<object>> {
  const found = await tx.booking.findUnique({
    where: { reference },
    select: { id: true },
  });
  if (!found) throw notFound();
  await tx.$queryRaw`SELECT 1 FROM "Booking" WHERE "id" = ${found.id}::uuid FOR UPDATE`;
  return tx.booking.findUniqueOrThrow({ where: { id: found.id } });
}

/**
 * `q`: the start of a booking reference, or the customer's exact email
 * address (any case) or phone number.
 */
function searchTerms(q: string): Prisma.BookingWhereInput[] {
  return [
    { reference: { startsWith: q.toUpperCase() } },
    { customer: { email: q.toLowerCase() } },
    { customer: { phone: q } },
  ];
}

function priceOf(row: SummaryRow): BookingPriceDto | null {
  if (isQuoteRequest(row)) return null;
  return {
    priceType: row.priceType,
    amountMinor: minorToNumber(row.totalMinor),
    currency: row.currency,
    // The list carries no validity; the estimate's lives on its calculation.
    validUntil: null,
  };
}

function summaryOf(row: SummaryRow): AdminBookingSummaryDto {
  const itinerary = parseItinerary(row.itinerary);
  const first = itinerary.legs[0];
  return {
    reference: row.reference,
    category: row.category,
    status: row.status,
    paymentStatus: row.paymentStatus,
    price: priceOf(row),
    customer: {
      id: row.customer.id,
      email: row.customer.email,
      phone: row.customer.phone,
    },
    operator: row.operator
      ? {
          id: row.operator.id,
          name: row.operator.tradingName ?? row.operator.legalName,
        }
      : null,
    aircraftRegistration: row.aircraft?.registration ?? null,
    originName: first.originName,
    destinationName: first.destinationName,
    departureAt: first.departureAt,
    passengerCount: itinerary.passengerCount,
    assignedToId: row.assignedToId,
    escalatedAt: row.escalatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * A reason kept on an escalation event's payload, or null. Encrypted; one
 * written in plain text before it was (append-only events are never
 * rewritten) is read as it is.
 */
function escalationReason(
  payload: unknown,
  cipher: FieldCipher,
): string | null {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    typeof (payload as Record<string, unknown>).reason !== 'string'
  ) {
    return null;
  }
  const stored = (payload as Record<string, unknown>).reason as string;
  return isEncrypted(stored) ? cipher.decrypt(stored) : stored;
}

/** The open escalation, from the column and the latest ESCALATED event. */
function escalationOf(
  row: {
    escalatedAt: Date | null;
    events: Prisma.BookingEventGetPayload<object>[];
  },
  cipher: FieldCipher,
): AdminBookingEscalationDto | null {
  if (!row.escalatedAt) return null;
  const event = row.events.findLast(
    (e) => e.type === BookingEventType.ESCALATED,
  );
  return {
    escalatedAt: row.escalatedAt.toISOString(),
    reason: escalationReason(event?.payload ?? null, cipher) ?? '',
    escalatedById: event?.actorId ?? null,
  };
}

/**
 * One timeline entry, from a fixed list of fields: payloads hold encrypted
 * text and notes, and are never returned as they are.
 */
function eventOf(
  event: Prisma.BookingEventGetPayload<object>,
  cipher: FieldCipher,
): AdminBookingEventDto {
  const payload = event.payload as Record<string, unknown> | null;
  // The override reason is in the audit trail too, which finance reads.
  const overrideReason =
    event.type === BookingEventType.ESCALATED ||
    event.type === BookingEventType.ESCALATION_RESOLVED
      ? escalationReason(payload, cipher)
      : payload !== null &&
          typeof payload === 'object' &&
          payload.override === true &&
          typeof payload.reason === 'string'
        ? payload.reason
        : null;
  return {
    id: event.id,
    type: event.type,
    fromStatus: event.fromStatus,
    toStatus: event.toStatus,
    actorId: event.actorId,
    actorRole: event.actorRole,
    overrideReason,
    createdAt: event.createdAt.toISOString(),
  };
}
