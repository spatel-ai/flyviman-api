import { describe, expect, it } from 'vitest';
import { calculatePrice, type PricePoint } from './engine.js';
import { priceOperatorQuote } from './quote-price.js';
import { resolveRules, type RuleRow } from './rules.js';

let seq = 0;
function rule(type: string, config: unknown, scope = 'PLATFORM'): RuleRow {
  seq += 1;
  return {
    id: `r${seq}`,
    scope,
    scopeRef: scope === 'PLATFORM' ? null : 'LIGHT_JET',
    type,
    config,
    priority: 0,
    version: seq,
  } as RuleRow;
}

const TARGET = {
  aircraftId: 'ac1',
  operatorId: 'op1',
  category: 'LIGHT_JET' as const,
};
const resolved = (rows: RuleRow[]) => resolveRules(rows, TARGET);

const COMMISSION = rule('COMMISSION', { percent: 10, mode: 'ADD_ON' });
const TAX = rule('TAX', { name: 'GST', percent: 18 });

describe('priceOperatorQuote (D-172 B)', () => {
  it("adds Flyviman's commission and tax to the operator's price", () => {
    const result = priceOperatorQuote({
      operatorPriceMinor: 40_000_000,
      rules: resolved([COMMISSION, TAX]),
    });
    expect(result).toMatchObject({
      baseMinor: 40_000_000,
      feesMinor: 4_000_000,
      taxMinor: 7_920_000,
      totalMinor: 51_920_000,
      operatorPayableMinor: 40_000_000,
      platformRevenueMinor: 4_000_000,
      currency: 'INR',
      warnings: [],
    });
  });

  it('is traceable: the breakdown sums to the total and names every rule applied', () => {
    const markup = rule('MARKUP', { percent: 2.5 });
    const fee = rule('SERVICE_FEE', { amountMinor: 150_000 });
    const discount = rule('DISCOUNT', { name: 'Launch', percent: 1 });
    const result = priceOperatorQuote({
      operatorPriceMinor: 12_345_678,
      rules: resolved([COMMISSION, TAX, markup, fee, discount]),
    });
    const sum = result.breakdown.reduce(
      (total, line) => total + line.amountMinor,
      0,
    );
    expect(sum).toBe(result.totalMinor);
    expect(result.appliedRules.map((r) => r.id).sort()).toEqual(
      [COMMISSION, TAX, markup, fee, discount].map((r) => r.id).sort(),
    );
    expect(result.breakdown[0]).toMatchObject({
      code: 'OPERATING',
      amountMinor: 12_345_678,
    });
  });

  it("keeps the booking's promotion code: after tax-free charges, before tax, capped with any discount at Flyviman's charges", () => {
    const promotion = {
      id: 'promo1',
      code: 'WELCOME',
      name: 'Welcome offer',
      kind: 'FIXED' as const,
      amountMinor: 1_000_000,
    };
    const result = priceOperatorQuote({
      operatorPriceMinor: 40_000_000,
      rules: resolved([COMMISSION, TAX]),
      promotion,
    });
    // 40,00,000 + 4,00,000 fee − 1,00,000 code = 43,00,000; 18% GST on it.
    expect(result).toMatchObject({
      discountMinor: 1_000_000,
      taxMinor: 7_740_000,
      totalMinor: 50_740_000,
      operatorPayableMinor: 40_000_000,
      platformRevenueMinor: 3_000_000,
    });
    expect(result.breakdown).toContainEqual(
      expect.objectContaining({ code: 'PROMOTION', amountMinor: -1_000_000 }),
    );
    expect(result.appliedRules).toContainEqual(
      expect.objectContaining({ id: 'promo1', type: 'PROMOTION' }),
    );
    // Never more than Flyviman earns: the operator's payable never moves.
    const capped = priceOperatorQuote({
      operatorPriceMinor: 40_000_000,
      rules: resolved([COMMISSION, TAX]),
      promotion: { ...promotion, amountMinor: 9_000_000 },
    });
    expect(capped).toMatchObject({
      discountMinor: 4_000_000,
      platformRevenueMinor: 0,
      operatorPayableMinor: 40_000_000,
    });
  });

  it('rounds each percentage half up to whole paise, once', () => {
    // 12,345 × 0.57% = 70.3665 → 70; 12,345 × 10% = 1,234.5 → 1,235.
    const result = priceOperatorQuote({
      operatorPriceMinor: 12_345,
      rules: resolved([
        rule('COMMISSION', { percent: 10, mode: 'ADD_ON' }),
        rule('TAX', { name: 'GST', percent: 0.57 }),
      ]),
    });
    expect(result.feesMinor).toBe(1_235);
    // (12,345 + 1,235) × 0.57% = 77.406 → 77.
    expect(result.taxMinor).toBe(77);
    expect(result.totalMinor).toBe(12_345 + 1_235 + 77);
    expect(Number.isInteger(result.totalMinor)).toBe(true);
  });

  it('takes deducted commission out of the payable, not added to the total', () => {
    const result = priceOperatorQuote({
      operatorPriceMinor: 10_000_000,
      rules: resolved([
        rule('COMMISSION', { percent: 10, mode: 'DEDUCTED' }),
        TAX,
      ]),
    });
    expect(result.feesMinor).toBe(0);
    expect(result.totalMinor).toBe(11_800_000);
    expect(result.operatorPayableMinor).toBe(9_000_000);
    expect(result.platformRevenueMinor).toBe(1_000_000);
  });

  it('does not apply the minimum charge: the operator named its price', () => {
    const result = priceOperatorQuote({
      operatorPriceMinor: 100_000,
      rules: resolved([
        COMMISSION,
        TAX,
        rule('MIN_CHARGE', { amountMinor: 5_000_000 }),
      ]),
    });
    expect(result.baseMinor).toBe(100_000);
    expect(result.breakdown.some((line) => line.code === 'MIN_CHARGE')).toBe(
      false,
    );
  });

  it('warns when commission or tax is not in force', () => {
    const result = priceOperatorQuote({
      operatorPriceMinor: 100_000,
      rules: resolved([]),
    });
    expect(result.totalMinor).toBe(100_000);
    expect(result.warnings).toEqual([
      'No commission rule is in force.',
      'No tax rule is in force; tax is not included.',
    ]);
    expect(result.exclusions).toEqual(['Taxes']);
  });

  it('is deterministic for the same inputs and rule versions', () => {
    const rules = resolved([
      COMMISSION,
      TAX,
      rule('DISCOUNT', { name: 'D', percent: 50 }),
    ]);
    expect(
      priceOperatorQuote({ operatorPriceMinor: 9_999_999, rules }),
    ).toEqual(priceOperatorQuote({ operatorPriceMinor: 9_999_999, rules }));
  });

  it("matches the engine's commercial step for the same operator subtotal", () => {
    const at = (id: string, longitude: number): PricePoint => ({
      id,
      name: id,
      latitude: 0,
      longitude,
      timeZone: 'UTC',
      charges: { LIGHT_JET: { landingMinor: 0, handlingMinor: 0 } },
    });
    const A = at('A', 0);
    const B = at('B', 6);
    const rows = [
      rule(
        'HOURLY_RATE',
        { amountMinor: 10_000_000, currency: 'INR' },
        'AIRCRAFT',
      ),
      rule('COMMISSION', { percent: 12.5, mode: 'ADD_ON' }),
      rule('MARKUP', { percent: 3 }),
      rule('SERVICE_FEE', { amountMinor: 250_000 }),
      rule('DISCOUNT', { name: 'Promo', percent: 40 }),
      TAX,
    ];
    rows[0].scopeRef = 'ac1';
    const estimate = calculatePrice({
      now: new Date('2026-12-01T00:00:00Z'),
      origin: A,
      destination: B,
      departureAt: new Date('2026-12-05T04:30:00Z'),
      aircraft: {
        id: 'ac1',
        operatorId: 'op1',
        category: 'LIGHT_JET',
        pricingModel: 'HOURLY',
        cruiseSpeedKmh: 600,
        base: A,
      },
      rules: resolved(rows),
      rawDistanceKm: (a, b) => Math.abs(a.longitude - b.longitude) * 100,
    });
    const quote = priceOperatorQuote({
      operatorPriceMinor: estimate.baseMinor,
      rules: resolved(rows),
    });
    for (const key of [
      'baseMinor',
      'feesMinor',
      'discountMinor',
      'taxMinor',
      'totalMinor',
      'operatorPayableMinor',
      'platformRevenueMinor',
    ] as const) {
      expect(quote[key], key).toBe(estimate[key]);
    }
  });
});
