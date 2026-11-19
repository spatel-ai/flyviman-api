import { describe, expect, it } from 'vitest';
import {
  calculatePrice,
  LINE_CODES,
  type EngineInput,
  type PricePoint,
} from '../pricing/engine.js';
import { resolveRules, type RuleRow } from '../pricing/rules.js';
import { customerBreakdown, FLIGHT_LINES, SHOWN_LINES } from './breakdown.js';

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

describe('every engine line code is classified', () => {
  it('is either folded into Flying or shown as is, never both or neither', () => {
    for (const code of LINE_CODES) {
      expect(
        [FLIGHT_LINES.has(code), SHOWN_LINES.has(code)],
        `${code} must be in exactly one of FLIGHT_LINES and SHOWN_LINES`,
      ).toSatisfy(([folded, shown]: boolean[]) => folded !== shown);
    }
    // And nothing classified that the engine does not write.
    const known = new Set<string>(LINE_CODES);
    for (const code of [...FLIGHT_LINES, ...SHOWN_LINES]) {
      expect(known.has(code), code).toBe(true);
    }
  });
});

describe('customer lines from real engine output', () => {
  // A flat world: 1 degree of longitude = 100 km, 600 km/h.
  const place = (id: string, name: string, longitude: number): PricePoint => ({
    id,
    name,
    latitude: 0,
    longitude,
    timeZone: 'UTC',
    charges: {
      currency: 'INR',
      categories: [
        {
          category: 'LIGHT_JET',
          landingMinor: 100_000,
          parkingMinor: 50_000,
          handlingMinor: 20_000,
        },
      ],
    },
  });
  const ORIGIN = place('o', 'Origin City', 0);
  const DESTINATION = place('d', 'Destination Town', 6);
  const BASE = place('b', 'Secret Base', 9);
  let seq = 0;
  const rule = (type: string, config: unknown): RuleRow =>
    ({
      id: `r${(seq += 1)}`,
      scope: 'PLATFORM',
      scopeRef: null,
      type,
      config,
      priority: 0,
      version: 1,
    }) as RuleRow;
  const ROWS = [
    rule('HOURLY_RATE', { amountMinor: 10_000_000, currency: 'INR' }),
    rule('MIN_BILLABLE_HOURS', { hours: 3, per: 'DAY' }),
    rule('POSITIONING', { rateFactor: 0.5 }),
    rule('WAITING', { amountMinor: 1_000_000, freeHours: 1 }),
    rule('CREW', { amountMinor: 2_000_000 }),
    rule('FUEL_SURCHARGE', { amountMinor: 10_000 }),
    rule('PERMIT', { amountMinor: 10_000 }),
    rule('NAVIGATION', { amountMinor: 10_000 }),
    rule('OTHER', { label: 'Catering', amountMinor: 10_000 }),
    rule('MIN_CHARGE', { amountMinor: 1 }),
    rule('COMMISSION', { percent: 10, mode: 'ADD_ON' }),
    rule('MARKUP', { percent: 5 }),
    rule('SERVICE_FEE', { amountMinor: 50_000 }),
    rule('DISCOUNT', { name: 'Launch', percent: 1 }),
    rule('TAX', { name: 'GST', percent: 18 }),
  ];
  const price = (overnight: number, returnAt: string | null) =>
    calculatePrice({
      now: new Date('2026-12-01T00:00:00Z'),
      origin: ORIGIN,
      destination: DESTINATION,
      departureAt: new Date('2026-12-05T04:30:00Z'),
      returnAt: returnAt ? new Date(returnAt) : null,
      aircraft: {
        id: 'ac1',
        operatorId: 'op1',
        category: 'LIGHT_JET',
        pricingModel: 'HOURLY',
        cruiseSpeedKmh: 600,
        base: BASE,
      },
      rules: resolveRules(
        [...ROWS, rule('OVERNIGHT', { amountMinor: overnight })],
        { aircraftId: 'ac1', operatorId: 'op1', category: 'LIGHT_JET' },
      ),
      rawDistanceKm: (a, b) => Math.abs(a.longitude - b.longitude) * 100,
    } satisfies EngineInput);
  const cases = {
    oneWay: price(3_000_000, null),
    sameDay: price(3_000_000, '2026-12-05T07:00:00Z'),
    nightsWaiting: price(100, '2026-12-07T12:00:00Z'),
    returnToBase: price(90_000_000, '2026-12-07T12:00:00Z'),
  };

  it('covers the flight lines that could name the base', () => {
    const written = new Set<string>(
      Object.values(cases).flatMap((r) => r.breakdown.map((l) => l.code)),
    );
    for (const code of [
      'POSITIONING',
      'REPOSITIONING',
      'INTERIM_REPOSITIONING',
      'INTERIM_POSITIONING',
      'MIN_BILLABLE',
      'WAITING',
      'OVERNIGHT',
      'PARKING',
    ]) {
      expect(written.has(code), code).toBe(true);
    }
    expect(cases.returnToBase.roundTrip?.strategy).toBe('RETURN_TO_BASE');
    // The stored lines do name it, so the check below means something.
    expect(
      cases.returnToBase.breakdown.some((l) => l.label.includes('Secret Base')),
    ).toBe(true);
  });

  it.each(Object.entries(cases))(
    '%s: no customer label names the base, and the lines add up to the total',
    (_name, result) => {
      expect(result.priced).toBe(true);
      const shown = customerBreakdown(result.breakdown);
      for (const { label } of shown) expect(label).not.toMatch(/Secret Base/);
      expect(shown.reduce((sum, l) => sum + l.amountMinor, 0)).toBe(
        result.totalMinor,
      );
      expect(result.exclusions.join(' ')).not.toMatch(/Secret Base/);
    },
  );
});
