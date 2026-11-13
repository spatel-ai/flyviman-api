import { describe, expect, it } from 'vitest';
import { calculatePrice, type EngineInput, type PricePoint } from './engine.js';
import { resolveRules, type RuleRow } from './rules.js';

const point = (
  id: string,
  latitude: number,
  longitude: number,
): PricePoint => ({
  id,
  name: id,
  latitude,
  longitude,
  charges: null,
});

// A flat world for exact arithmetic: 1 degree of longitude = 100 km.
const flatKm = (a: PricePoint, b: PricePoint) =>
  Math.abs(a.longitude - b.longitude) * 100;

let seq = 0;
function rule(
  type: string,
  config: unknown,
  scope = 'PLATFORM',
  scopeRef: string | null = null,
  extra: Partial<RuleRow> = {},
): RuleRow {
  seq += 1;
  return {
    id: `r${seq}`,
    scope,
    scopeRef,
    type,
    config,
    priority: 0,
    version: 1,
    ...extra,
  } as RuleRow;
}

const AIRCRAFT = {
  id: 'ac1',
  operatorId: 'op1',
  category: 'LIGHT_JET' as const,
  cruiseSpeedKmh: 600,
};
const A = point('A', 0, 0);
const B = point('B', 0, 6); // 600 km from A: exactly one hour

function run(rows: RuleRow[], overrides: Partial<EngineInput> = {}) {
  return calculatePrice({
    now: new Date('2026-12-01T00:00:00Z'),
    origin: A,
    destination: B,
    departureAt: new Date('2026-12-05T04:30:00Z'),
    aircraft: { ...AIRCRAFT, base: A },
    rules: resolveRules(rows, {
      aircraftId: AIRCRAFT.id,
      operatorId: AIRCRAFT.operatorId,
      category: AIRCRAFT.category,
    }),
    rawDistanceKm: flatKm,
    ...overrides,
  });
}

const RATE = rule(
  'HOURLY_RATE',
  { amountMinor: 10_000_000, currency: 'INR' },
  'AIRCRAFT',
  'ac1',
);

describe('calculatePrice', () => {
  it('prices flight hours at the hourly rate, labelled for the customer', () => {
    const result = run([RATE]);
    expect(result.priced).toBe(true);
    expect(result.flightMinutes).toBe(60);
    expect(result.breakdown[0]).toMatchObject({
      code: 'OPERATING',
      amountMinor: 10_000_000,
    });
  });

  it('applies minimum billable hours', () => {
    const result = run([RATE, rule('MIN_BILLABLE_HOURS', { hours: 2 })]);
    expect(result.breakdown[0].amountMinor).toBe(20_000_000);
  });

  it('adds the routing factor and time allowance to the leg', () => {
    const result = run([
      RATE,
      rule('ROUTING_FACTOR', { factor: 1.1 }, 'CATEGORY', 'LIGHT_JET'),
      rule('TIME_ALLOWANCE', { minutes: 6 }),
    ]);
    expect(result.distanceKm).toBe(660);
    expect(result.flightMinutes).toBe(72);
  });

  it('charges positioning out and back when the aircraft is based elsewhere', () => {
    const C = point('C', 0, -3); // 300 km from A, 900 km from B
    const result = run([RATE, rule('POSITIONING', { rateFactor: 0.5 })], {
      aircraft: { ...AIRCRAFT, base: C },
    });
    const codes = Object.fromEntries(
      result.breakdown.map((line) => [line.code, line.amountMinor]),
    );
    expect(codes.POSITIONING).toBe(2_500_000); // 0.5 h × 0.5
    expect(codes.REPOSITIONING).toBe(7_500_000); // 1.5 h × 0.5
  });

  it('does not charge positioning within the free distance', () => {
    const C = point('C', 0, -0.4); // 40 km
    const result = run(
      [RATE, rule('POSITIONING', { rateFactor: 1, freeWithinKm: 50 })],
      { aircraft: { ...AIRCRAFT, base: C }, destination: C },
    );
    expect(result.breakdown.map((line) => line.code)).toEqual(['OPERATING']);
  });

  it('uses location charges for the category, else the operator fallback', () => {
    const charged = {
      ...B,
      charges: {
        currency: 'INR',
        categories: [
          {
            category: 'LIGHT_JET',
            landingMinor: 100_000,
            parkingMinor: 0,
            handlingMinor: 50_000,
          },
        ],
      },
    };
    const result = run([RATE, rule('HANDLING', { amountMinor: 20_000 })], {
      destination: charged,
    });
    const line = result.breakdown.find((l) => l.code === 'LANDING_HANDLING');
    // landing at B 1,00,000 + handling at A (fallback) 20,000 + at B 50,000
    expect(line?.amountMinor).toBe(170_000);
  });

  it('says what it could not include instead of hiding it', () => {
    const result = run([RATE]);
    expect(result.exclusions).toContain('Landing charges at B');
    expect(result.warnings.join(' ')).toMatch(/not on record/);
  });

  it('raises the operator subtotal to the minimum charge', () => {
    const result = run([RATE, rule('MIN_CHARGE', { amountMinor: 15_000_000 })]);
    expect(result.baseMinor).toBe(15_000_000);
  });

  describe('commission and tax are each applied exactly once', () => {
    const commission = rule('COMMISSION', { percent: 10, mode: 'ADD_ON' });
    const gst = rule('TAX', { name: 'GST', percent: 18 });

    it('exclusive rate: fee on top, tax on subtotal and fee', () => {
      const result = run([RATE, commission, gst]);
      expect(result.baseMinor).toBe(10_000_000);
      expect(result.feesMinor).toBe(1_000_000);
      expect(result.taxMinor).toBe(1_980_000);
      expect(result.totalMinor).toBe(12_980_000);
      expect(result.platformRevenueMinor).toBe(1_000_000);
      expect(result.operatorPayableMinor).toBe(10_000_000);
    });

    it('tax-inclusive rate is reduced to exclusive first', () => {
      const inclusive = rule(
        'HOURLY_RATE',
        { amountMinor: 11_800_000, currency: 'INR', taxInclusive: true },
        'AIRCRAFT',
        'ac1',
        { version: 2 },
      );
      const result = run([inclusive, commission, gst]);
      expect(result.baseMinor).toBe(10_000_000);
      expect(result.totalMinor).toBe(12_980_000);
    });

    it('commission-inclusive rate is reduced to exclusive first', () => {
      const inclusive = rule(
        'HOURLY_RATE',
        { amountMinor: 11_000_000, currency: 'INR', commissionInclusive: true },
        'AIRCRAFT',
        'ac1',
        { version: 2 },
      );
      const result = run([inclusive, commission, gst]);
      expect(result.baseMinor).toBe(10_000_000);
      expect(result.totalMinor).toBe(12_980_000);
    });

    it('deducted commission comes out of the operator payable', () => {
      const deducted = rule(
        'COMMISSION',
        { percent: 10, mode: 'DEDUCTED' },
        'PLATFORM',
        null,
        { version: 2 },
      );
      const result = run([RATE, deducted, gst]);
      expect(result.feesMinor).toBe(0);
      expect(result.totalMinor).toBe(11_800_000);
      expect(result.operatorPayableMinor).toBe(9_000_000);
      expect(result.platformRevenueMinor).toBe(1_000_000);
    });
  });

  it('the total is always the sum of the breakdown', () => {
    const C = point('C', 0, -2.37);
    const result = run(
      [
        rule(
          'HOURLY_RATE',
          { amountMinor: 18_333_333, currency: 'INR', taxInclusive: true },
          'AIRCRAFT',
          'ac1',
        ),
        rule('POSITIONING', { rateFactor: 0.8 }),
        rule('ROUTING_FACTOR', { factor: 1.07 }),
        rule('TIME_ALLOWANCE', { minutes: 11 }),
        rule('HANDLING', { amountMinor: 33_333 }),
        rule('LANDING', { amountMinor: 77_777 }),
        rule('COMMISSION', { percent: 7.5, mode: 'ADD_ON' }),
        rule('TAX', { name: 'GST', percent: 18 }),
      ],
      { aircraft: { ...AIRCRAFT, base: C } },
    );
    const sum = result.breakdown.reduce(
      (total, line) => total + line.amountMinor,
      0,
    );
    expect(result.totalMinor).toBe(sum);
    expect(Number.isInteger(result.totalMinor)).toBe(true);
  });

  it('is not priced without an hourly rate or a cruise speed', () => {
    expect(run([]).priced).toBe(false);
    const noSpeed = run([RATE], {
      aircraft: { ...AIRCRAFT, cruiseSpeedKmh: null, base: A },
    });
    expect(noSpeed.priced).toBe(false);
    expect(noSpeed.warnings.join(' ')).toMatch(/cruise speed/);
  });

  it('stays valid for the configured time', () => {
    const result = run([RATE, rule('VALIDITY', { minutes: 30 })]);
    expect(result.validUntil.toISOString()).toBe('2026-12-01T00:30:00.000Z');
  });
});

describe('resolveRules', () => {
  const target = {
    aircraftId: 'ac1',
    operatorId: 'op1',
    category: 'LIGHT_JET' as const,
  };

  it('the most specific scope wins', () => {
    const resolved = resolveRules(
      [
        rule('HOURLY_RATE', { amountMinor: 1 }, 'OPERATOR', 'op1'),
        rule('HOURLY_RATE', { amountMinor: 2 }, 'AIRCRAFT', 'ac1'),
      ],
      target,
    );
    expect(resolved.HOURLY_RATE?.config.amountMinor).toBe(2);
  });

  it('ignores rules for another aircraft, operator or category', () => {
    const resolved = resolveRules(
      [
        rule('HOURLY_RATE', { amountMinor: 1 }, 'AIRCRAFT', 'other'),
        rule('MIN_BILLABLE_HOURS', { hours: 1 }, 'CATEGORY', 'HELICOPTER'),
      ],
      target,
    );
    expect(resolved).toEqual({});
  });

  it('an operator cannot set its own commission or tax', () => {
    const resolved = resolveRules(
      [
        rule('COMMISSION', { percent: 10, mode: 'ADD_ON' }),
        rule('COMMISSION', { percent: 0, mode: 'ADD_ON' }, 'OPERATOR', 'op1'),
      ],
      target,
    );
    expect(resolved.COMMISSION?.config.percent).toBe(10);
  });
});
