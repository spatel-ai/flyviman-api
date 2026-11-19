import { describe, expect, it } from 'vitest';
import { customerBreakdown } from './breakdown.js';

const line = (code: string, amountMinor: number, extra: object = {}) => ({
  code,
  label: `${code} label`,
  amountMinor,
  ...extra,
});

describe('customerBreakdown', () => {
  it('combines every flight line into one Flying line, keeping the rest and the total', () => {
    const stored = [
      line('OPERATING', 1_000_000, { basis: '1.50 h × hourly rate' }),
      line('OPERATING_RETURN', 1_000_000),
      line('MIN_BILLABLE', 100_000),
      line('POSITIONING', 300_000),
      line('INTERIM_REPOSITIONING', 200_000),
      line('INTERIM_POSITIONING', 200_000),
      line('REPOSITIONING', 300_000),
      line('WAITING', 50_000),
      line('OVERNIGHT', 70_000),
      line('CREW', 10_000),
      line('LANDING_HANDLING', 40_000),
      line('PLATFORM_FEE', 90_000),
      line('MARKUP', 30_000),
      line('DISCOUNT', -20_000),
      line('TAX', 180_000),
    ];
    const shown = customerBreakdown(stored);
    expect(shown).toEqual([
      { code: 'FLYING', label: 'Flying', amountMinor: 3_130_000 },
      line('WAITING', 50_000),
      line('OVERNIGHT', 70_000),
      line('CREW', 10_000),
      line('LANDING_HANDLING', 40_000),
      line('PLATFORM_FEE', 90_000),
      line('DISCOUNT', -20_000),
      line('TAX', 180_000),
    ]);
    const sum = (lines: { amountMinor: number }[]) =>
      lines.reduce((total, entry) => total + entry.amountMinor, 0);
    expect(sum(shown)).toBe(sum(stored));
    expect(JSON.stringify(shown)).not.toMatch(/basis|INTERIM|OPERATING|MARKUP/);
  });

  it('shows no Flying line when there is no flight line, and nothing for none', () => {
    expect(customerBreakdown([line('TAX', 5)])).toEqual([line('TAX', 5)]);
    expect(customerBreakdown([])).toEqual([]);
  });
});
