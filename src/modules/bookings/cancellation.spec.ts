import { describe, expect, it } from 'vitest';
import { PriceType } from '../../generated/prisma/enums.js';
import type { CancellationTerms } from './booking-json.js';
import { chargeFor, evaluateCancellation } from './cancellation.js';

const TIERS = [
  { minHoursBeforeDeparture: 72, chargePercent: 0 },
  { minHoursBeforeDeparture: 24, chargePercent: 50 },
  { minHoursBeforeDeparture: 6, chargePercent: 90 },
];

function terms(charges = TIERS): CancellationTerms {
  return {
    version: 1,
    source: 'OPERATOR_QUOTE',
    summary: 'Free up to 72 hours, then 50%, then 90%.',
    charges,
    acceptedAt: '2026-11-20T00:00:00.000Z',
  };
}

const NOW = new Date('2026-11-20T00:00:00.000Z');
const hoursFromNow = (hours: number) =>
  new Date(NOW.getTime() + hours * 3_600_000).toISOString();

function evaluate(
  hours: number,
  overrides: Partial<Parameters<typeof evaluateCancellation>[0]> = {},
) {
  return evaluateCancellation({
    terms: terms(),
    departureAt: hoursFromNow(hours),
    now: NOW,
    totalMinor: 1_000_001n,
    priceType: PriceType.CONFIRMED,
    paidMinor: 0n,
    ...overrides,
  });
}

describe('chargeFor', () => {
  it('picks the first rule whose notice is met, at the boundary too', () => {
    expect(chargeFor(TIERS, 100)?.chargePercent).toBe(0);
    expect(chargeFor(TIERS, 72)?.chargePercent).toBe(0);
    expect(chargeFor(TIERS, 71)?.chargePercent).toBe(50);
    expect(chargeFor(TIERS, 24)?.chargePercent).toBe(50);
    expect(chargeFor(TIERS, 6)?.chargePercent).toBe(90);
  });

  it('gives the shortest-notice rule when notice is shorter than every rule', () => {
    expect(chargeFor(TIERS, 2)?.chargePercent).toBe(90);
  });

  it('is null when the terms carry no charges', () => {
    expect(chargeFor([], 10)).toBeNull();
  });
});

describe('evaluateCancellation', () => {
  it('charges a confirmed price by the rule, rounded down to the paisa', () => {
    const outcome = evaluate(30);
    expect(outcome.hoursBeforeDeparture).toBe(30);
    expect(outcome.appliedCharge).toEqual(TIERS[1]);
    expect(outcome.amountKnown).toBe(true);
    expect(outcome.chargeMinor).toBe(500_000n);
  });

  it('shows the rule but charges 0 while the price is not confirmed', () => {
    for (const priceType of [
      PriceType.ESTIMATE,
      PriceType.QUOTE,
      PriceType.LIVE_FARE,
    ]) {
      const outcome = evaluate(30, { priceType });
      expect(outcome.appliedCharge).toEqual(TIERS[1]);
      expect(outcome.amountKnown).toBe(false);
      expect(outcome.chargeMinor).toBe(0n);
    }
  });

  it('charges nothing when the terms carry no charges', () => {
    const outcome = evaluate(30, { terms: terms([]) });
    expect(outcome.appliedCharge).toBeNull();
    expect(outcome.chargeMinor).toBe(0n);
  });

  it('counts whole hours, and 0 once departure has passed', () => {
    expect(evaluate(24.9).hoursBeforeDeparture).toBe(24);
    const late = evaluate(-5);
    expect(late.hoursBeforeDeparture).toBe(0);
    expect(late.appliedCharge).toEqual(TIERS[2]);
  });

  it('refunds nothing when nothing is paid', () => {
    const outcome = evaluate(100);
    expect(outcome.paidMinor).toBe(0n);
    expect(outcome.refundMinor).toBe(0n);
  });

  it('refunds what was paid less the charge (W4-1)', () => {
    const outcome = evaluate(30, { paidMinor: 1_000_001n });
    expect(outcome.chargeMinor).toBe(500_000n);
    expect(outcome.paidMinor).toBe(1_000_001n);
    expect(outcome.refundMinor).toBe(500_001n);
    // A Model C deposit only: the refund is the part above the charge.
    expect(evaluate(30, { paidMinor: 250_001n }).refundMinor).toBe(0n);
    expect(evaluate(100, { paidMinor: 250_001n }).refundMinor).toBe(250_001n);
  });

  it('never refunds below 0, whatever the charge', () => {
    expect(evaluate(1, { paidMinor: 10n }).refundMinor).toBe(0n);
  });
});
