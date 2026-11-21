import {
  BookingStatus,
  SettlementStatus,
} from '../../generated/prisma/enums.js';

/**
 * The settlement rules (M9, W4-2, `SETTLEMENT_MODE=manual`), pure: what
 * Flyviman owes an operator for one booking and when it is due. Phase 1
 * records and tracks payouts by hand (open decision 8); nothing here moves
 * money.
 *
 * - A record is created once the booking is `COMPLETED` (the trip flown)
 *   with money kept towards it (`netPaidMinor`: credited less refunds).
 * - Commission is the platform's revenue on the price
 *   (`PriceCalculation.platformRevenueMinor`: commission, markup and service
 *   fee less Flyviman's discount, plus any manual override's difference);
 *   tax is the calculation's tax, which Flyviman collected. Both are taken
 *   as priced; the operator's payable is what is kept less the two
 *   (`payable = kept − commission − tax`, never below 0). With the whole
 *   price kept, that is the calculation's `operatorPayableMinor`.
 * - It is `DUE` while the booking is `COMPLETED`, its whole price was paid
 *   (`creditedMinor` at least the total, so an unpaid Model C balance is
 *   never passed to the operator as a smaller payout), no refund is on its
 *   way and the three figures add up to the money kept; otherwise `NOT_DUE`.
 *   So a refund after the trip (goodwill) comes out of the operator's
 *   payable (assumed, lead 2026-11-21), and a refund larger than the
 *   payable leaves the record `NOT_DUE` with the reason
 *   `REFUND_EXCEEDS_PAYABLE` for finance (the reconciliation report flags
 *   it too).
 * - `ON_HOLD` and `PAID` are a person's decisions: the system never moves a
 *   record into or out of them. Releasing a hold returns the record to what
 *   the rules give now. A `PAID` record is never changed again.
 */

/** The stored price a settlement is worked out from. */
export interface SettlementCalculation {
  totalMinor: bigint;
  taxMinor: bigint;
  operatorPayableMinor: bigint;
  platformRevenueMinor: bigint;
}

export interface SettlementFigures {
  payableMinor: bigint;
  commissionMinor: bigint;
  taxMinor: bigint;
}

/**
 * Why a calculation cannot price the settlement, or null when it can: it
 * must be the booking's price (same total) and its parts must add up to it.
 */
export function unusableCalculation(
  calculation: SettlementCalculation | null,
  bookingTotalMinor: bigint,
): string | null {
  if (!calculation) return 'The booking has no price calculation.';
  if (calculation.totalMinor !== bookingTotalMinor) {
    return 'The price calculation is not the booking’s price.';
  }
  const { taxMinor, operatorPayableMinor, platformRevenueMinor } = calculation;
  if (taxMinor < 0n || operatorPayableMinor < 0n || platformRevenueMinor < 0n) {
    return 'The price calculation has a negative part.';
  }
  if (
    operatorPayableMinor + platformRevenueMinor + taxMinor !==
    calculation.totalMinor
  ) {
    return 'The price calculation’s parts do not add up to its total.';
  }
  return null;
}

/**
 * The figures for the money kept. Kept money above the price is not the
 * operator's (it is flagged, and refunded), so at most the price counts.
 */
export function settlementFigures(
  keptMinor: bigint,
  calculation: SettlementCalculation,
): SettlementFigures {
  const counted =
    keptMinor < calculation.totalMinor ? keptMinor : calculation.totalMinor;
  const payable =
    counted - calculation.platformRevenueMinor - calculation.taxMinor;
  return {
    payableMinor: payable > 0n ? payable : 0n,
    commissionMinor: calculation.platformRevenueMinor,
    taxMinor: calculation.taxMinor,
  };
}

export function figuresTotal(figures: SettlementFigures): bigint {
  return figures.payableMinor + figures.commissionMinor + figures.taxMinor;
}

export function sameFigures(
  a: SettlementFigures,
  b: SettlementFigures,
): boolean {
  return (
    a.payableMinor === b.payableMinor &&
    a.commissionMinor === b.commissionMinor &&
    a.taxMinor === b.taxMinor
  );
}

export interface SettlementState {
  bookingStatus: BookingStatus;
  keptMinor: bigint;
  /** Whether the money credited towards the booking reached its price. */
  fullyPaid: boolean;
  refundOpen: boolean;
  figures: SettlementFigures;
}

/** Shown for a refund after the trip larger than the payable (lead, W4-2). */
export const REFUND_EXCEEDS_PAYABLE =
  'Refund exceeds payable — finance to resolve.';

/** Why a record is not due, for finance; null when it is due. */
export function notDueReason(state: SettlementState): string | null {
  if (state.bookingStatus !== BookingStatus.COMPLETED) {
    return 'The trip is not completed.';
  }
  if (!state.fullyPaid) return 'The price was not paid in full.';
  if (state.keptMinor <= 0n) return 'No money is kept on the booking.';
  if (state.refundOpen) return 'A refund is on its way.';
  const total = figuresTotal(state.figures);
  if (total > state.keptMinor) return REFUND_EXCEEDS_PAYABLE;
  if (total < state.keptMinor) {
    return 'More money is kept than the price — finance to resolve.';
  }
  return null;
}

/** What the system says the record is: `DUE` or `NOT_DUE`. */
export function derivedSettlementStatus(
  state: SettlementState,
): typeof SettlementStatus.DUE | typeof SettlementStatus.NOT_DUE {
  return notDueReason(state) === null
    ? SettlementStatus.DUE
    : SettlementStatus.NOT_DUE;
}

/**
 * Where finance may move a record (`PATCH /admin/settlements/:id`). `DUE`
 * from `ON_HOLD` releases the hold: the record then takes whatever the rules
 * give now, `DUE` or `NOT_DUE`.
 */
const MOVES: Record<SettlementStatus, readonly SettlementStatus[]> = {
  NOT_DUE: [SettlementStatus.ON_HOLD],
  DUE: [SettlementStatus.ON_HOLD, SettlementStatus.PAID],
  ON_HOLD: [SettlementStatus.DUE],
  PAID: [],
};

export function canMoveSettlement(
  from: SettlementStatus,
  to: SettlementStatus,
): boolean {
  return MOVES[from].includes(to);
}
