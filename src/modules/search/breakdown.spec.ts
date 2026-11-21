import { describe, expect, it } from 'vitest';
import {
  calculatePrice,
  LINE_CODES,
  type EngineInput,
  type PricePoint,
} from '../pricing/engine.js';
import { priceEmptyLegTotal } from '../pricing/empty-leg-price.js';
import { ASSUMPTION_CODES } from '../pricing/notes.js';
import { priceOperatorQuote } from '../pricing/quote-price.js';
import { resolveRules, type RuleRow } from '../pricing/rules.js';
import {
  CUSTOMER_ASSUMPTIONS,
  customerAssumptions,
  customerBreakdown,
  FLIGHT_LINES,
  SHOWN_LINES,
} from './breakdown.js';

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

  it('shows an override line as it is, so the lines still add up (D-179)', () => {
    const stored = [
      line('OPERATING', 1_000_000),
      line('TAX', 180_000),
      line('OVERRIDE', -80_000, { basis: 'Manual override' }),
    ];
    const shown = customerBreakdown(stored);
    expect(shown).toContainEqual(line('OVERRIDE', -80_000));
    expect(shown.reduce((sum, entry) => sum + entry.amountMinor, 0)).toBe(
      1_100_000,
    );
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
  const price = (
    overnight: number,
    returnAt: string | null,
    extra: {
      rows?: RuleRow[];
      base?: PricePoint;
      promotion?: EngineInput['promotion'];
    } = {},
  ) =>
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
        base: extra.base ?? BASE,
      },
      promotion: extra.promotion ?? null,
      rules: resolveRules(
        [
          ...(extra.rows ?? ROWS),
          rule('OVERNIGHT', { amountMinor: overnight }),
        ],
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

  describe('customer assumptions (D-099)', () => {
    const scope = {
      aircraftId: 'ac1',
      operatorId: 'op1',
      category: 'LIGHT_JET',
    } as const;
    const withoutDiscount = ROWS.filter((row) => row.type !== 'DISCOUNT');
    // Every assumption each pricing path can write, as stored.
    const stored = {
      ...Object.fromEntries(
        Object.entries(cases).map(([name, result]) => [
          name,
          result.assumptions,
        ]),
      ),
      atBase: price(3_000_000, '2026-12-07T12:00:00Z', { base: DESTINATION })
        .assumptions,
      discountCapped: price(3_000_000, null, {
        rows: [
          ...withoutDiscount,
          rule('DISCOUNT', { name: 'Launch', percent: 100 }),
        ],
      }).assumptions,
      promotionCapped: price(3_000_000, null, {
        promotion: {
          id: 'p1',
          code: 'BIG',
          name: 'Big code',
          kind: 'FIXED',
          amountMinor: 1_000_000_000,
        },
      }).assumptions,
      quote: priceOperatorQuote({
        operatorPriceMinor: 1_000_000,
        rules: resolveRules(ROWS, scope),
      }).assumptions,
      emptyLeg: priceEmptyLegTotal({
        totalMinor: 1_000_000,
        rules: resolveRules(ROWS, scope),
      }).assumptions,
      // Appended by PricingService.saveOverride.
      override: [
        {
          code: 'PRICE_OVERRIDE',
          text: 'Price set by hand by Flyviman; tax was not worked out again',
        },
      ],
    };

    it('the cases write every assumption code, and the stored text names the base', () => {
      const written = new Set(
        Object.values(stored).flatMap((list) => list.map((a) => a.code)),
      );
      expect([...written].sort()).toEqual([...ASSUMPTION_CODES].sort());
      expect(Object.keys(CUSTOMER_ASSUMPTIONS).sort()).toEqual(
        [...ASSUMPTION_CODES].sort(),
      );
      // So the checks below mean something: finance's wording keeps both.
      const said = Object.values(stored)
        .flatMap((list) => list.map((a) => a.text))
        .join(' ');
      expect(said).toMatch(/Secret Base/);
      expect(said).toMatch(/priced below/);
    });

    it.each(Object.entries(stored))(
      '%s: customers read no place name and no commercial reasoning',
      (_name, assumptions) => {
        for (const sentence of customerAssumptions(assumptions)) {
          expect(sentence).not.toMatch(
            /Secret Base|Destination Town|Origin City|priced below|costs the same|could not|not time|tax was not/,
          );
        }
      },
    );

    it('generalises the base and the strategy, keeps safe wording, and hides the override note', () => {
      expect(customerAssumptions(cases.oneWay.assumptions)).toEqual([
        'Great-circle distance with routing factor 1.00',
        "Includes the aircraft's positioning flights",
      ]);
      expect(customerAssumptions(stored.override)).toEqual([]);
      expect(customerAssumptions(stored.discountCapped)).toContain(
        'Launch applied up to its limit for this trip',
      );
    });

    it('leaves out plain strings stored before codes, and says each sentence once', () => {
      expect(
        customerAssumptions([
          'Aircraft returns to Secret Base after drop-off',
          { code: 'REPOSITIONING', text: 'Aircraft returns to A' },
          { code: 'REPOSITIONING', text: 'Aircraft returns to B' },
          { code: 'UNKNOWN', text: 'Something new' },
        ]),
      ).toEqual(["Includes the aircraft's positioning flights"]);
      expect(customerAssumptions(null)).toEqual([]);
    });
  });
});
