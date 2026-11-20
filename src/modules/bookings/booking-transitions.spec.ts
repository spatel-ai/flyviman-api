import { describe, expect, it } from 'vitest';
import {
  BookingMode,
  BookingStatus,
  PriceType,
  Role,
  ServiceCategory,
} from '../../generated/prisma/enums.js';
import {
  actorFor,
  afterRequested,
  type BookingActor,
  CANCELLABLE,
  checkTransition,
  statusTimestamps,
  type TransitionContext,
} from './booking-transitions.js';

const S = BookingStatus;
const ACTORS: BookingActor[] = ['CUSTOMER', 'OPERATOR', 'OPERATIONS', 'SYSTEM'];
const STATUSES = Object.values(BookingStatus);

/** Every condition met, so only the table itself decides. */
const OPEN: TransitionContext = {
  category: ServiceCategory.PRIVATE_CHARTER,
  bookingMode: BookingMode.INSTANT,
  priceType: PriceType.CONFIRMED,
  operatorAccepted: true,
  paymentConditionMet: true,
  liveFareRevalidated: true,
  feasibilityComplete: true,
  departed: true,
};

/**
 * The table in state-machines.md (Booking), written out by hand: from, to,
 * who, and the quote condition the move needs, if any. Cancellation is "any
 * status before COMPLETED" by customer, operator or operations.
 */
type Row = [
  BookingStatus,
  BookingStatus,
  BookingActor[],
  Partial<TransitionContext>?,
];
const LIVE: Partial<TransitionContext> = { quote: 'LIVE' };
const TABLE: Row[] = [
  [S.REQUESTED, S.AWAITING_PAYMENT, ['SYSTEM']],
  [S.OPERATOR_PENDING, S.CLARIFICATION_REQUESTED, ['OPERATOR']],
  [S.CLARIFICATION_REQUESTED, S.OPERATOR_PENDING, ['CUSTOMER', 'OPERATIONS']],
  [S.OPERATOR_PENDING, S.PRICE_CONFIRMED, ['OPERATOR']],
  [S.OPERATOR_PENDING, S.PRICE_CONFIRMED, ['CUSTOMER'], LIVE],
  [S.OPERATOR_PENDING, S.QUOTE_DECLINED, ['CUSTOMER'], LIVE],
  [S.OPERATOR_PENDING, S.EXPIRED, ['SYSTEM'], { quote: 'LAPSED' }],
  [S.CLARIFICATION_REQUESTED, S.EXPIRED, ['SYSTEM']],
  [S.OPERATOR_PENDING, S.OPERATOR_UNAVAILABLE, ['OPERATOR', 'SYSTEM']],
  [S.PRICE_CONFIRMED, S.AWAITING_PAYMENT, ['SYSTEM']],
  [S.PRICE_CONFIRMED, S.QUOTE_DECLINED, ['CUSTOMER']],
  [S.AWAITING_PAYMENT, S.CONFIRMED, ['SYSTEM']],
  [S.AWAITING_PAYMENT, S.EXPIRED, ['SYSTEM']],
  [S.CONFIRMED, S.SCHEDULED, ['OPERATOR', 'OPERATIONS']],
  [S.SCHEDULED, S.COMPLETED, ['OPERATOR', 'OPERATIONS']],
  ...CANCELLABLE.map((from): Row => [
    from,
    S.CANCELLED,
    ['CUSTOMER', 'OPERATOR', 'OPERATIONS'],
  ]),
];

describe('checkTransition: the full table', () => {
  // Every pair of statuses and every actor, against the table above.
  for (const from of STATUSES) {
    for (const to of STATUSES) {
      for (const actor of ACTORS) {
        const rows = TABLE.filter(([f, t]) => f === from && t === to);
        const row = rows.find(([, , by]) => by.includes(actor)) ?? rows[0];
        const context = { ...OPEN, ...row?.[3] };
        // REQUESTED -> OPERATOR_PENDING is allowed only when the booking is
        // not instant with a confirmed price; OPEN is, so it is tested below.
        const expected =
          from === S.REQUESTED && to === S.OPERATOR_PENDING
            ? false
            : Boolean(row?.[2].includes(actor));
        it(`${from} -> ${to} by ${actor}: ${expected ? 'allowed' : 'refused'}`, () => {
          expect(checkTransition(from, to, actor, context).allowed).toBe(
            expected,
          );
        });
      }
    }
  }

  it('cancels from every status before COMPLETED and none after', () => {
    expect(CANCELLABLE).toEqual([
      S.REQUESTED,
      S.OPERATOR_PENDING,
      S.CLARIFICATION_REQUESTED,
      S.PRICE_CONFIRMED,
      S.AWAITING_PAYMENT,
      S.CONFIRMED,
      S.SCHEDULED,
    ]);
  });
});

describe('checkTransition: conditions', () => {
  it('sends a request-mode booking to the operator', () => {
    const context = { ...OPEN, bookingMode: BookingMode.REQUEST };
    expect(
      checkTransition(S.REQUESTED, S.OPERATOR_PENDING, 'SYSTEM', context)
        .allowed,
    ).toBe(true);
    expect(
      checkTransition(S.REQUESTED, S.AWAITING_PAYMENT, 'SYSTEM', context)
        .allowed,
    ).toBe(false);
  });

  it('never takes an instant booking with an estimate to payment', () => {
    const context = { ...OPEN, priceType: PriceType.ESTIMATE };
    expect(
      checkTransition(S.REQUESTED, S.AWAITING_PAYMENT, 'SYSTEM', context),
    ).toEqual({ allowed: false, reason: 'the price is not confirmed' });
    expect(afterRequested(context)).toBe(S.OPERATOR_PENDING);
  });

  it('takes an instant booking with a confirmed price to payment', () => {
    expect(afterRequested(OPEN)).toBe(S.AWAITING_PAYMENT);
    expect(
      afterRequested({
        ...OPEN,
        priceType: PriceType.LIVE_FARE,
        liveFareRevalidated: true,
      }),
    ).toBe(S.AWAITING_PAYMENT);
    expect(
      afterRequested({
        ...OPEN,
        priceType: PriceType.LIVE_FARE,
        liveFareRevalidated: false,
      }),
    ).toBe(S.OPERATOR_PENDING);
  });

  it('never makes air ambulance instant (rule 7)', () => {
    const context = { ...OPEN, category: ServiceCategory.AIR_AMBULANCE };
    expect(
      checkTransition(S.REQUESTED, S.AWAITING_PAYMENT, 'SYSTEM', context),
    ).toEqual({ allowed: false, reason: 'air ambulance is never instant' });
    expect(afterRequested(context)).toBe(S.OPERATOR_PENDING);
  });

  it('never confirms air ambulance without acceptance and feasibility (rule 7)', () => {
    const base = { ...OPEN, category: ServiceCategory.AIR_AMBULANCE };
    const confirm = (context: TransitionContext) =>
      checkTransition(S.AWAITING_PAYMENT, S.CONFIRMED, 'SYSTEM', context);
    expect(confirm({ ...base, operatorAccepted: false }).allowed).toBe(false);
    expect(confirm({ ...base, feasibilityComplete: false }).allowed).toBe(
      false,
    );
    expect(confirm(base).allowed).toBe(true);
  });

  it('never confirms on payment alone (rule 2)', () => {
    const paidOnly: TransitionContext = {
      ...OPEN,
      bookingMode: BookingMode.REQUEST,
      operatorAccepted: false,
      paymentConditionMet: true,
    };
    expect(
      checkTransition(S.AWAITING_PAYMENT, S.CONFIRMED, 'SYSTEM', paidOnly),
    ).toEqual({ allowed: false, reason: 'the operator has not accepted' });
    expect(
      checkTransition(S.AWAITING_PAYMENT, S.CONFIRMED, 'SYSTEM', {
        ...OPEN,
        priceType: PriceType.QUOTE,
      }),
    ).toEqual({ allowed: false, reason: 'the price is not confirmed' });
    expect(
      checkTransition(S.AWAITING_PAYMENT, S.CONFIRMED, 'SYSTEM', {
        ...OPEN,
        paymentConditionMet: false,
      }),
    ).toEqual({ allowed: false, reason: 'the payment condition is not met' });
  });

  it('lets the customer accept or decline only a live quote', () => {
    for (const to of [S.PRICE_CONFIRMED, S.QUOTE_DECLINED]) {
      for (const quote of ['NONE', 'LAPSED', undefined] as const) {
        expect(
          checkTransition(S.OPERATOR_PENDING, to, 'CUSTOMER', {
            ...OPEN,
            quote,
          }).allowed,
        ).toBe(false);
      }
      expect(
        checkTransition(S.OPERATOR_PENDING, to, 'CUSTOMER', {
          ...OPEN,
          quote: 'LIVE',
        }).allowed,
      ).toBe(true);
    }
  });

  it('refuses the operator’s plain accept while a quote waits, or with no price', () => {
    const accept = (context: Partial<TransitionContext>) =>
      checkTransition(S.OPERATOR_PENDING, S.PRICE_CONFIRMED, 'OPERATOR', {
        ...OPEN,
        ...context,
      });
    expect(accept({ quote: 'LIVE' })).toEqual({
      allowed: false,
      reason: 'a quote is waiting for the customer',
    });
    expect(accept({ priceOnRequest: true })).toEqual({
      allowed: false,
      reason: 'the request has no price to accept: send a quote',
    });
    // A lapsed quote no longer stands in the way of the proposed price.
    expect(accept({ quote: 'LAPSED' }).allowed).toBe(true);
  });

  it('expires a pending request only when its quote lapsed', () => {
    const expire = (quote: TransitionContext['quote']) =>
      checkTransition(S.OPERATOR_PENDING, S.EXPIRED, 'SYSTEM', {
        ...OPEN,
        quote,
      }).allowed;
    expect(expire('LAPSED')).toBe(true);
    expect(expire('LIVE')).toBe(false);
    expect(expire('NONE')).toBe(false);
  });

  it('completes only after departure', () => {
    expect(
      checkTransition(S.SCHEDULED, S.COMPLETED, 'OPERATOR', {
        ...OPEN,
        departed: false,
      }).allowed,
    ).toBe(false);
  });
});

describe('checkTransition: manual override', () => {
  it('lets operations move between any two statuses with a reason', () => {
    for (const from of STATUSES) {
      for (const to of STATUSES) {
        if (from === to) continue;
        expect(
          checkTransition(from, to, 'OPERATIONS', OPEN, { reason: 'Agreed' })
            .allowed,
        ).toBe(true);
      }
    }
  });

  it('needs a reason, and only operations may use it', () => {
    expect(
      checkTransition(S.REQUESTED, S.CONFIRMED, 'OPERATIONS', OPEN, {
        reason: '  ',
      }).allowed,
    ).toBe(false);
    for (const actor of ['CUSTOMER', 'OPERATOR', 'SYSTEM'] as const) {
      expect(
        checkTransition(S.REQUESTED, S.CONFIRMED, actor, OPEN, {
          reason: 'x',
        }).allowed,
      ).toBe(false);
    }
  });
});

describe('actorFor', () => {
  it('maps roles to actors', () => {
    expect(actorFor(Role.CUSTOMER)).toBe('CUSTOMER');
    expect(actorFor(Role.OPERATOR_ADMIN)).toBe('OPERATOR');
    expect(actorFor(Role.OPERATOR_STAFF)).toBe('OPERATOR');
    expect(actorFor(Role.OPS)).toBe('OPERATIONS');
    expect(actorFor(Role.SUPER_ADMIN)).toBe('OPERATIONS');
    expect(actorFor(Role.FINANCE_ADMIN)).toBeNull();
  });
});

describe('statusTimestamps', () => {
  const now = new Date('2026-11-20T10:00:00.000Z');

  it('sets confirmedAt on CONFIRMED and cancelledAt on CANCELLED only', () => {
    expect(statusTimestamps(S.CONFIRMED, now)).toEqual({ confirmedAt: now });
    expect(statusTimestamps(S.CANCELLED, now)).toEqual({ cancelledAt: now });
    for (const status of STATUSES) {
      if (status === S.CONFIRMED || status === S.CANCELLED) continue;
      expect(statusTimestamps(status, now)).toEqual({});
    }
  });
});
