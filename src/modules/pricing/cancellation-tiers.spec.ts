import { describe, expect, it } from 'vitest';
import { PriceType } from '../../generated/prisma/enums.js';
import { evaluateCancellation } from '../bookings/cancellation.js';
import { requestTerms } from '../bookings/booking-snapshot.js';
import { checkTiers, tierLines, tiersSummary } from './cancellation-tiers.js';

const STARTING = [
  { minHoursBeforeDeparture: 72, chargePercent: 10 },
  { minHoursBeforeDeparture: 24, chargePercent: 50 },
  { minHoursBeforeDeparture: 0, chargePercent: 100 },
];

const DEPARTURE = '2026-12-10T10:00:00.000Z';
const HOUR = 3_600_000;

function chargeAt(msBeforeDeparture: number, totalMinor = 10_000_000n) {
  return evaluateCancellation({
    terms: requestTerms(
      { summary: tiersSummary(STARTING), tiers: STARTING },
      new Date('2026-12-01T00:00:00.000Z'),
    ),
    departureAt: DEPARTURE,
    now: new Date(Date.parse(DEPARTURE) - msBeforeDeparture),
    totalMinor,
    priceType: PriceType.CONFIRMED,
    paidMinor: 0n,
  });
}

describe('checkTiers', () => {
  it('accepts the starting table', () => {
    expect(checkTiers({ tiers: STARTING })).toEqual({
      ok: true,
      config: { tiers: STARTING },
    });
  });

  it.each([
    ['no tiers', { tiers: [] }, 'tiers'],
    [
      'eleven tiers',
      {
        tiers: Array.from({ length: 11 }, (_, i) => ({
          minHoursBeforeDeparture: 10 - i,
          chargePercent: 100,
        })),
      },
      'tiers',
    ],
    [
      'notice not longest first',
      { tiers: [STARTING[1], STARTING[0], STARTING[2]] },
      'tiers.1.minHoursBeforeDeparture',
    ],
    [
      'a repeated notice',
      { tiers: [STARTING[0], STARTING[0], STARTING[2]] },
      'tiers.1.minHoursBeforeDeparture',
    ],
    [
      'no tier at 0 hours',
      { tiers: [STARTING[0], STARTING[1]] },
      'tiers.1.minHoursBeforeDeparture',
    ],
    [
      'a charge that falls as notice shortens',
      {
        tiers: [
          { minHoursBeforeDeparture: 72, chargePercent: 50 },
          { minHoursBeforeDeparture: 0, chargePercent: 10 },
        ],
      },
      'tiers.1.chargePercent',
    ],
    [
      'a percent over 100',
      { tiers: [{ minHoursBeforeDeparture: 0, chargePercent: 101 }] },
      'tiers.0.chargePercent',
    ],
    [
      'a fractional percent',
      { tiers: [{ minHoursBeforeDeparture: 0, chargePercent: 10.5 }] },
      'tiers.0.chargePercent',
    ],
    [
      'fractional hours',
      {
        tiers: [
          { minHoursBeforeDeparture: 1.5, chargePercent: 10 },
          STARTING[2],
        ],
      },
      'tiers.0.minHoursBeforeDeparture',
    ],
    [
      'an unknown tier key',
      { tiers: [{ ...STARTING[2], note: 'x' }] },
      'tiers.0.note',
    ],
    ['an unknown key', { tiers: STARTING, extra: 1 }, 'config.extra'],
  ])('refuses %s', (_name, config, field) => {
    const check = checkTiers(config);
    expect(check.ok).toBe(false);
    if (!check.ok) expect(check.errors.map((e) => e.field)).toContain(field);
  });
});

describe('tiersSummary', () => {
  it('words each tier as the evaluator applies it (boundaries in the cheaper tier)', () => {
    expect(tierLines(STARTING)).toEqual([
      '72 hours or more before departure: 10% of the price',
      '24 hours to under 72 hours before departure: 50% of the price',
      'Under 24 hours before departure, or a no-show: 100% of the price',
    ]);
    expect(tiersSummary(STARTING)).toContain('the same for every operator');
  });

  it('words a single tier', () => {
    expect(
      tierLines([{ minHoursBeforeDeparture: 0, chargePercent: 0 }]),
    ).toEqual(['Any time before departure, or a no-show: 0% of the price']);
  });
});

describe('the starting tiers at their boundaries', () => {
  it('charges 10% with more than 72 hours left', () => {
    expect(chargeAt(100 * HOUR).chargeMinor).toBe(1_000_000n);
  });

  it('charges 10% at exactly 72 hours (the cheaper tier, as the summary says)', () => {
    expect(chargeAt(72 * HOUR).chargeMinor).toBe(1_000_000n);
  });

  it('charges 50% a moment under 72 hours', () => {
    expect(chargeAt(72 * HOUR - 1).chargeMinor).toBe(5_000_000n);
  });

  it('charges 50% at exactly 24 hours', () => {
    expect(chargeAt(24 * HOUR).chargeMinor).toBe(5_000_000n);
  });

  it('charges 100% a moment under 24 hours', () => {
    expect(chargeAt(24 * HOUR - 1).chargeMinor).toBe(10_000_000n);
  });

  it('charges 100% after departure (a no-show)', () => {
    expect(chargeAt(-2 * HOUR).chargeMinor).toBe(10_000_000n);
  });

  it('rounds a charge down to the paisa', () => {
    expect(chargeAt(100 * HOUR, 999n).chargeMinor).toBe(99n);
  });
});
