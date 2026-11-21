import { describe, expect, it } from 'vitest';
import {
  BookingStatus,
  SettlementStatus,
} from '../../generated/prisma/enums.js';
import {
  AWAITING_SYNC,
  canMoveSettlement,
  derivedSettlementStatus,
  figuresTotal,
  notDueReason,
  paidNotDueReason,
  REFUND_EXCEEDS_PAYABLE,
  sameFigures,
  type SettlementCalculation,
  type SettlementState,
  settlementFigures,
  unusableCalculation,
} from './settlement-rules.js';

// A ₹1,000.00 trip: ₹150.00 commission, ₹50.00 tax, ₹800.00 to the operator.
const CALCULATION: SettlementCalculation = {
  totalMinor: 100_000n,
  taxMinor: 5_000n,
  platformRevenueMinor: 15_000n,
  operatorPayableMinor: 80_000n,
};

describe('unusableCalculation', () => {
  it('accepts a calculation that is the booking price and adds up', () => {
    expect(unusableCalculation(CALCULATION, 100_000n)).toBeNull();
  });

  it('refuses a missing calculation', () => {
    expect(unusableCalculation(null, 100_000n)).toBe(
      'The booking has no price calculation.',
    );
  });

  it('refuses a calculation for another total', () => {
    expect(unusableCalculation(CALCULATION, 100_001n)).toMatch(
      /not the booking’s price/,
    );
  });

  it('refuses a negative part', () => {
    expect(
      unusableCalculation(
        {
          ...CALCULATION,
          taxMinor: -5_000n,
          operatorPayableMinor: 90_000n,
        },
        100_000n,
      ),
    ).toMatch(/negative part/);
  });

  it('refuses parts that do not add up to the total', () => {
    expect(
      unusableCalculation(
        { ...CALCULATION, operatorPayableMinor: 79_999n },
        100_000n,
      ),
    ).toMatch(/do not add up/);
  });
});

describe('settlementFigures', () => {
  it('with the whole price kept, the payable is the calculation’s', () => {
    expect(settlementFigures(100_000n, CALCULATION)).toEqual({
      payableMinor: 80_000n,
      commissionMinor: 15_000n,
      taxMinor: 5_000n,
    });
  });

  it('a partial refund after the trip comes out of the payable only', () => {
    const figures = settlementFigures(90_000n, CALCULATION);
    expect(figures).toEqual({
      payableMinor: 70_000n,
      commissionMinor: 15_000n,
      taxMinor: 5_000n,
    });
    expect(figuresTotal(figures)).toBe(90_000n);
  });

  it('a refund larger than the payable leaves the payable at 0, not negative', () => {
    const figures = settlementFigures(10_000n, CALCULATION);
    expect(figures.payableMinor).toBe(0n);
    expect(figures.commissionMinor).toBe(15_000n);
    expect(figures.taxMinor).toBe(5_000n);
    // The figures now exceed the money kept: notDueReason says so.
    expect(figuresTotal(figures)).toBeGreaterThan(10_000n);
  });

  it('money kept above the price is not counted', () => {
    expect(settlementFigures(130_000n, CALCULATION)).toEqual({
      payableMinor: 80_000n,
      commissionMinor: 15_000n,
      taxMinor: 5_000n,
    });
  });
});

describe('sameFigures', () => {
  it('compares all three figures', () => {
    const a = settlementFigures(100_000n, CALCULATION);
    expect(sameFigures(a, { ...a })).toBe(true);
    expect(sameFigures(a, { ...a, payableMinor: 79_999n })).toBe(false);
    expect(sameFigures(a, { ...a, commissionMinor: 1n })).toBe(false);
    expect(sameFigures(a, { ...a, taxMinor: 1n })).toBe(false);
  });
});

describe('notDueReason and derivedSettlementStatus', () => {
  const due: SettlementState = {
    bookingStatus: BookingStatus.COMPLETED,
    keptMinor: 100_000n,
    fullyPaid: true,
    refundOpen: false,
    figures: settlementFigures(100_000n, CALCULATION),
  };

  it('is due when completed, fully paid, no refund open and the figures add up', () => {
    expect(notDueReason(due)).toBeNull();
    expect(derivedSettlementStatus(due)).toBe(SettlementStatus.DUE);
  });

  const cases: [string, SettlementState, string][] = [
    [
      'the trip is not completed',
      { ...due, bookingStatus: BookingStatus.CONFIRMED },
      'The trip is not completed.',
    ],
    [
      'the price was not paid in full',
      { ...due, fullyPaid: false },
      'The price was not paid in full.',
    ],
    [
      'no money is kept',
      {
        ...due,
        keptMinor: 0n,
        figures: { payableMinor: 0n, commissionMinor: 0n, taxMinor: 0n },
      },
      'No money is kept on the booking.',
    ],
    [
      'a refund is on its way',
      { ...due, refundOpen: true },
      'A refund is on its way.',
    ],
    [
      'a refund after the trip is larger than the payable',
      {
        ...due,
        keptMinor: 10_000n,
        figures: settlementFigures(10_000n, CALCULATION),
      },
      REFUND_EXCEEDS_PAYABLE,
    ],
    [
      'more is kept than the price',
      { ...due, keptMinor: 130_000n },
      'More money is kept than the price — finance to resolve.',
    ],
  ];
  for (const [name, state, reason] of cases) {
    it(`is not due when ${name}`, () => {
      expect(notDueReason(state)).toBe(reason);
      expect(derivedSettlementStatus(state)).toBe(SettlementStatus.NOT_DUE);
    });
  }

  it('checks the trip before payment, and payment before open refunds', () => {
    expect(
      notDueReason({
        ...due,
        bookingStatus: BookingStatus.CANCELLED,
        fullyPaid: false,
        refundOpen: true,
      }),
    ).toBe('The trip is not completed.');
    expect(notDueReason({ ...due, fullyPaid: false, refundOpen: true })).toBe(
      'The price was not paid in full.',
    );
  });
});

describe('the MOVES table (canMoveSettlement)', () => {
  const { NOT_DUE, DUE, ON_HOLD, PAID } = SettlementStatus;
  const all = [NOT_DUE, DUE, ON_HOLD, PAID];
  const allowed: [SettlementStatus, SettlementStatus][] = [
    [NOT_DUE, ON_HOLD],
    [DUE, ON_HOLD],
    [DUE, PAID],
    [ON_HOLD, DUE],
  ];

  for (const from of all) {
    for (const to of all) {
      const ok = allowed.some(([f, t]) => f === from && t === to);
      it(`${from} -> ${to} is ${ok ? 'allowed' : 'refused'}`, () => {
        expect(canMoveSettlement(from, to)).toBe(ok);
      });
    }
  }

  it('a NOT_DUE record can never be paid, and a PAID record never moves', () => {
    expect(canMoveSettlement(NOT_DUE, PAID)).toBe(false);
    for (const to of all) expect(canMoveSettlement(PAID, to)).toBe(false);
  });
});

describe('paidNotDueReason (marking PAID answers SETTLEMENT_NOT_DUE)', () => {
  const { NOT_DUE, DUE, ON_HOLD, PAID } = SettlementStatus;
  const refund = 'A refund is on its way.';

  it('a DUE record still due may be paid; one no longer due gives the reason', () => {
    expect(paidNotDueReason(DUE, null)).toBeNull();
    expect(paidNotDueReason(DUE, refund)).toBe(refund);
  });

  it('a NOT_DUE record (a stale Due screen) always gives a reason', () => {
    expect(paidNotDueReason(NOT_DUE, refund)).toBe(refund);
    expect(paidNotDueReason(NOT_DUE, null)).toBe(AWAITING_SYNC);
  });

  it('ON_HOLD and PAID records are left to the move table', () => {
    expect(paidNotDueReason(ON_HOLD, refund)).toBeNull();
    expect(paidNotDueReason(PAID, refund)).toBeNull();
  });
});
