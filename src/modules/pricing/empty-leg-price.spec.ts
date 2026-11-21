import { describe, expect, it } from 'vitest';
import { priceEmptyLegTotal } from './empty-leg-price.js';
import { resolveRules, type RuleRow } from './rules.js';

let seq = 0;
function rule(type: string, config: unknown): RuleRow {
  seq += 1;
  return {
    id: `r${seq}`,
    scope: 'PLATFORM',
    scopeRef: null,
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
const TAX = rule('TAX', { name: 'GST', percent: 18 });
const DEDUCTED = rule('COMMISSION', { percent: 10, mode: 'DEDUCTED' });
const ADD_ON = rule('COMMISSION', { percent: 10, mode: 'ADD_ON' });

/** The customer's total is the parts: breakdown, and payable plus revenue plus tax. */
function expectConsistent(
  totalMinor: number,
  result: ReturnType<typeof priceEmptyLegTotal>,
) {
  expect(result.totalMinor).toBe(totalMinor);
  expect(
    result.breakdown.reduce((sum, line) => sum + line.amountMinor, 0),
  ).toBe(totalMinor);
  expect(
    result.operatorPayableMinor + result.platformRevenueMinor + result.taxMinor,
  ).toBe(totalMinor);
  expect(result.baseMinor + result.feesMinor + result.taxMinor).toBe(
    totalMinor,
  );
  for (const part of [
    result.baseMinor,
    result.feesMinor,
    result.taxMinor,
    result.operatorPayableMinor,
    result.platformRevenueMinor,
  ]) {
    expect(Number.isInteger(part)).toBe(true);
    expect(part).toBeGreaterThanOrEqual(0);
  }
  expect(result.discountMinor).toBe(0);
}

describe('priceEmptyLegTotal (M8-C)', () => {
  it('takes tax out of the total, then DEDUCTED commission out of the rest', () => {
    const result = priceEmptyLegTotal({
      totalMinor: 11_800_000,
      rules: resolved([TAX, DEDUCTED]),
    });
    expect(result).toMatchObject({
      baseMinor: 10_000_000,
      feesMinor: 0,
      taxMinor: 1_800_000,
      operatorPayableMinor: 9_000_000,
      platformRevenueMinor: 1_000_000,
      currency: 'INR',
      warnings: [],
    });
    expectConsistent(11_800_000, result);
  });

  it('ADD_ON commission is a platform fee on top of the operator subtotal', () => {
    const result = priceEmptyLegTotal({
      totalMinor: 11_800_000,
      rules: resolved([TAX, ADD_ON]),
    });
    // 10 000 000 before tax = 9 090 909 + a 10% fee of 909 091.
    expect(result).toMatchObject({
      baseMinor: 9_090_909,
      feesMinor: 909_091,
      taxMinor: 1_800_000,
      operatorPayableMinor: 9_090_909,
      platformRevenueMinor: 909_091,
    });
    expect(result.breakdown.map((line) => line.code)).toEqual([
      'OPERATING',
      'PLATFORM_FEE',
      'TAX',
    ]);
    expectConsistent(11_800_000, result);
  });

  it('parts add up and are never negative across awkward totals and percents', () => {
    const totals = [0, 1, 2, 3, 7, 99, 100, 101, 12_345_679, 18_500_000];
    const rows: RuleRow[][] = [
      [TAX, DEDUCTED],
      [TAX, ADD_ON],
      [
        rule('TAX', { name: 'GST', percent: 5.5 }),
        rule('COMMISSION', { percent: 12.5, mode: 'DEDUCTED' }),
      ],
      [
        rule('TAX', { name: 'GST', percent: 5.5 }),
        rule('COMMISSION', { percent: 12.5, mode: 'ADD_ON' }),
      ],
      [rule('COMMISSION', { percent: 100, mode: 'DEDUCTED' })],
      [rule('TAX', { name: 'GST', percent: 18 })],
      [],
    ];
    for (const set of rows) {
      for (const totalMinor of totals) {
        expectConsistent(
          totalMinor,
          priceEmptyLegTotal({ totalMinor, rules: resolved(set) }),
        );
      }
    }
  });

  it('rounds half up in whole paise', () => {
    // 105 / 1.18 = 88.98 -> 89; tax 16; 89 * 10% = 8.9 -> 9 commission.
    const result = priceEmptyLegTotal({
      totalMinor: 105,
      rules: resolved([TAX, DEDUCTED]),
    });
    expect(result).toMatchObject({
      taxMinor: 16,
      operatorPayableMinor: 80,
      platformRevenueMinor: 9,
    });
    expectConsistent(105, result);
  });

  it('with no rules in force the operator is paid the whole total, with warnings', () => {
    const result = priceEmptyLegTotal({
      totalMinor: 5_000,
      rules: resolved([]),
    });
    expect(result).toMatchObject({
      taxMinor: 0,
      operatorPayableMinor: 5_000,
      platformRevenueMinor: 0,
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.exclusions).toEqual(['Taxes']);
  });

  it('names the rules it applied', () => {
    const result = priceEmptyLegTotal({
      totalMinor: 11_800_000,
      rules: resolved([TAX, DEDUCTED]),
    });
    expect(result.appliedRules.map((r) => r.type).sort()).toEqual([
      'COMMISSION',
      'TAX',
    ]);
  });
});
