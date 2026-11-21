import { describe, expect, it } from 'vitest';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  BookingEventType,
  BookingStatus,
  Role,
} from '../../generated/prisma/enums.js';
import { customerEvent, orderTimeline } from './booking-timeline.js';

type Row = Prisma.BookingEventGetPayload<object>;

function row(overrides: Partial<Row>): Row {
  return {
    id: 'e1',
    bookingId: 'b1',
    type: BookingEventType.NOTE,
    fromStatus: null,
    toStatus: null,
    actorId: 'u1',
    actorRole: Role.OPS,
    payload: {},
    createdAt: new Date('2026-11-21T10:00:00.000Z'),
    ...overrides,
  } as Row;
}

const reveal = (stored: string) => stored;
const none = new Map<string, string>();

describe('customerEvent', () => {
  it('drops notes with a visibility, however they are shaped', () => {
    const note = row({
      type: BookingEventType.NOTE,
      payload: {
        visibility: 'INTERNAL',
        note: 'secret',
        decision: 'APPROVED',
        changeRequestId: 'c1',
      },
    });
    expect(customerEvent(note, reveal, none)).toBeNull();
  });

  it('shows a change request answer with its note, by FLYVIMAN or OPERATOR only', () => {
    const answered = customerEvent(
      row({
        type: BookingEventType.NOTE,
        actorRole: Role.OPERATOR_STAFF,
        payload: { changeRequestId: 'c1', decision: 'APPROVED', note: 'Fine' },
      }),
      reveal,
      none,
    );
    expect(answered).toMatchObject({
      kind: 'CHANGE_REQUEST_ANSWERED',
      by: 'OPERATOR',
      note: 'Fine',
    });
  });

  it('never shows escalations, operator responses or unknown types', () => {
    for (const type of [
      BookingEventType.ESCALATED,
      BookingEventType.ESCALATION_RESOLVED,
      BookingEventType.OPERATOR_RESPONSE,
      BookingEventType.CANCELLATION_REQUESTED,
      'SOMETHING_NEW' as BookingEventType,
    ]) {
      expect(
        customerEvent(
          row({ type, payload: { reason: 'secret' } }),
          reveal,
          none,
        ),
      ).toBeNull();
    }
  });

  it('labels a quote as QUOTE and passes no other payload field', () => {
    const entry = customerEvent(
      row({
        type: BookingEventType.QUOTE_ISSUED,
        payload: {
          quoteReference: 'Q1',
          totalMinor: 100,
          currency: 'INR',
          validUntil: null,
          internalMargin: 99,
        },
      }),
      reveal,
      none,
    );
    expect(entry?.price).toEqual({
      priceType: 'QUOTE',
      amountMinor: 100,
      currency: 'INR',
      validUntil: null,
    });
    expect(JSON.stringify(entry)).not.toContain('internalMargin');
  });

  it('shows a passenger change without the counts or names, and never the actor id or staff role', () => {
    const entry = customerEvent(
      row({
        type: BookingEventType.PASSENGERS_CHANGED,
        actorRole: Role.CUSTOMER,
        payload: { before: 1, after: 2, names: ['Ada'] },
      }),
      reveal,
      none,
    );
    expect(entry).toMatchObject({ kind: 'PASSENGERS_UPDATED', by: 'YOU' });
    expect(JSON.stringify(entry)).not.toMatch(/Ada|u1|OPS/);
  });

  it('drops malformed payloads', () => {
    expect(
      customerEvent(
        row({ type: BookingEventType.QUOTE_ISSUED, payload: 'x' }),
        reveal,
        none,
      ),
    ).toBeNull();
    expect(
      customerEvent(
        row({ type: BookingEventType.PAYMENT_UPDATE, payload: { to: 'NOPE' } }),
        reveal,
        none,
      ),
    ).toBeNull();
    expect(
      customerEvent(
        row({ type: BookingEventType.STATUS_CHANGED }),
        reveal,
        none,
      ),
    ).toBeNull();
  });
});

describe('orderTimeline', () => {
  it('puts other entries before status changes at one time, and chains the moves', () => {
    const at = '2026-11-21T10:00:00.000Z';
    const base = {
      by: 'SYSTEM',
      price: null,
      quoteReference: null,
      paymentStatus: null,
      changeRequestId: null,
      decision: null,
      note: null,
      createdAt: at,
    } as const;
    const ordered = orderTimeline([
      {
        ...base,
        id: 'b',
        kind: 'STATUS_CHANGED',
        fromStatus: BookingStatus.AWAITING_PAYMENT,
        toStatus: BookingStatus.CONFIRMED,
      },
      {
        ...base,
        id: 'a',
        kind: 'STATUS_CHANGED',
        fromStatus: BookingStatus.OPERATOR_PENDING,
        toStatus: BookingStatus.AWAITING_PAYMENT,
      },
      {
        ...base,
        id: 'p',
        kind: 'PAYMENT_UPDATED',
        fromStatus: null,
        toStatus: null,
      },
    ] as never);
    expect(ordered.map((entry) => entry.id)).toEqual(['p', 'a', 'b']);
  });
});
