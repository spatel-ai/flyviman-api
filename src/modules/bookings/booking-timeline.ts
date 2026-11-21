import type { Prisma } from '../../generated/prisma/client.js';
import {
  BookingEventType,
  BookingPaymentStatus,
  ChangeRequestStatus,
  PriceType,
  Role,
} from '../../generated/prisma/enums.js';
import type {
  CustomerBookingEventDto,
  CustomerEventKind,
  EventActor,
} from './dto/customer-booking.dto.js';

/**
 * The customer's own timeline (`GET /bookings/:reference/events`), from the
 * booking's events. Pure, so it can be unit tested. Each type is read
 * through an allowlist of fields: payloads hold encrypted free text,
 * internal notes, the operator's reject reason and override reasons, and
 * none of it is passed through. Unknown types and shapes are dropped.
 */

type EventRow = Prisma.BookingEventGetPayload<object>;

const DECISIONS: readonly ChangeRequestStatus[] = [
  ChangeRequestStatus.APPROVED,
  ChangeRequestStatus.REJECTED,
];

function actorOf(role: Role | null): EventActor {
  switch (role) {
    case null:
      return 'SYSTEM';
    case Role.CUSTOMER:
      return 'YOU';
    case Role.OPERATOR_ADMIN:
    case Role.OPERATOR_STAFF:
      return 'OPERATOR';
    default:
      return 'FLYVIMAN';
  }
}

function record(payload: unknown): Record<string, unknown> {
  return typeof payload === 'object' && payload !== null
    ? (payload as Record<string, unknown>)
    : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * One event as the customer sees it, or null when it is not theirs to see.
 * `reveal` decrypts a decision note (plain notes written before encryption
 * are returned as stored); `details` holds each change request's details,
 * already decrypted, by ID.
 */
export function customerEvent(
  event: EventRow,
  reveal: (stored: string) => string,
  details: ReadonlyMap<string, string>,
): CustomerBookingEventDto | null {
  const payload = record(event.payload);
  const entry = (
    kind: CustomerEventKind,
    fields: Partial<CustomerBookingEventDto> = {},
  ): CustomerBookingEventDto =>
    Object.assign(
      {
        id: event.id,
        kind,
        by: actorOf(event.actorRole),
        fromStatus: null,
        toStatus: null,
        price: null,
        quoteReference: null,
        paymentStatus: null,
        changeRequestId: null,
        decision: null,
        note: null,
        createdAt: event.createdAt.toISOString(),
      },
      fields,
    );
  switch (event.type) {
    case BookingEventType.STATUS_CHANGED:
      if (!event.toStatus) return null;
      return entry('STATUS_CHANGED', {
        fromStatus: event.fromStatus,
        toStatus: event.toStatus,
      });
    case BookingEventType.QUOTE_ISSUED: {
      const quoteReference = text(payload.quoteReference);
      const totalMinor = payload.totalMinor;
      const currency = text(payload.currency);
      if (!quoteReference || typeof totalMinor !== 'number' || !currency) {
        return null;
      }
      return entry('QUOTE_SENT', {
        quoteReference,
        price: {
          priceType: PriceType.QUOTE,
          amountMinor: totalMinor,
          currency,
          validUntil: text(payload.validUntil),
        },
      });
    }
    case BookingEventType.PAYMENT_UPDATE: {
      const to = text(payload.to);
      if (!to || !Object.hasOwn(BookingPaymentStatus, to)) return null;
      return entry('PAYMENT_UPDATED', {
        paymentStatus: to as BookingPaymentStatus,
      });
    }
    case BookingEventType.MESSAGE:
      // The words are in `GET /bookings/:reference/messages`.
      if (payload.from === 'OPERATOR') {
        return entry('QUESTION_ASKED');
      }
      if (payload.from === 'CUSTOMER') {
        return entry('QUESTION_ANSWERED');
      }
      return null;
    case BookingEventType.CHANGE_REQUESTED: {
      const id = text(payload.changeRequestId);
      if (!id) return null;
      return entry('CHANGE_REQUESTED', {
        changeRequestId: id,
        note: details.get(id) ?? null,
      });
    }
    case BookingEventType.NOTE: {
      // Only a change request's answer: notes with a `visibility` are the
      // operator's or Flyviman's own, never the customer's.
      if ('visibility' in payload) return null;
      const id = text(payload.changeRequestId);
      const note = text(payload.note);
      const decision = text(payload.decision);
      if (!id || note === null || !decision) return null;
      if (!DECISIONS.includes(decision as ChangeRequestStatus)) return null;
      return entry('CHANGE_REQUEST_ANSWERED', {
        changeRequestId: id,
        decision: decision as ChangeRequestStatus,
        note: reveal(note),
      });
    }
    default:
      // OPERATOR_RESPONSE (the status change says it, the reason is
      // internal), CANCELLATION_REQUESTED (unused) and any later type.
      return null;
  }
}

/**
 * Oldest first. Events written in one transaction can share a time, and
 * their IDs are random, so within one time the other entries come first
 * (a payment or an answer before the status change it led to) and status
 * changes follow their chain: each one starts where the previous ended.
 */
export function orderTimeline(
  entries: CustomerBookingEventDto[],
): CustomerBookingEventDto[] {
  const byTime = new Map<string, CustomerBookingEventDto[]>();
  for (const entry of entries) {
    const group = byTime.get(entry.createdAt) ?? [];
    group.push(entry);
    byTime.set(entry.createdAt, group);
  }
  const times = [...byTime.keys()].sort(
    (a, b) => Date.parse(a) - Date.parse(b),
  );
  return times.flatMap((time) => {
    const group = byTime.get(time) ?? [];
    const others = group.filter((entry) => entry.kind !== 'STATUS_CHANGED');
    const moves = group.filter((entry) => entry.kind === 'STATUS_CHANGED');
    const chained: CustomerBookingEventDto[] = [];
    while (moves.length > 0) {
      // The move no other remaining move leads into; else the first left.
      const index = moves.findIndex(
        (move) =>
          !moves.some(
            (other) => other !== move && other.toStatus === move.fromStatus,
          ),
      );
      chained.push(...moves.splice(index === -1 ? 0 : index, 1));
    }
    return [...others, ...chained];
  });
}
