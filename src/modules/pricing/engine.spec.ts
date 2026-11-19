import { describe, expect, it } from 'vitest';
import {
  calculatePrice,
  localNights,
  type EngineInput,
  type PricePoint,
} from './engine.js';
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
  timeZone: 'UTC',
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
  pricingModel: 'HOURLY' as 'HOURLY' | 'SECTOR' | 'FIXED_ROUTE',
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

  it('assumes a return to base only when the return is charged', () => {
    const C = point('C', 0, -3);
    const far = run([RATE, rule('POSITIONING', { rateFactor: 0.5 })], {
      aircraft: { ...AIRCRAFT, base: C },
    });
    expect(far.assumptions.join(' ')).toMatch(/returns to C/);
    const near = point('N', 0, 6.3); // 30 km from B, within the free distance
    const free = run(
      [RATE, rule('POSITIONING', { rateFactor: 0.5, freeWithinKm: 50 })],
      { aircraft: { ...AIRCRAFT, base: near }, origin: near },
    );
    expect(free.assumptions.join(' ')).not.toMatch(/returns to/);
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

describe('round trips', () => {
  // Out at 04:30 UTC, an hour's flight: lands at B at 05:30.
  const at = (iso: string) => new Date(iso);
  const POSITIONING = rule('POSITIONING', { rateFactor: 0.5 });
  const WAITING = rule('WAITING', { amountMinor: 1_000_000, freeHours: 1 });
  const OVERNIGHT = rule('OVERNIGHT', { amountMinor: 3_000_000 });
  const CREW = rule('CREW', { amountMinor: 2_000_000 });
  const ALL = [RATE, POSITIONING, WAITING, OVERNIGHT, CREW];
  const codes = (result: ReturnType<typeof run>) =>
    Object.fromEntries(result.breakdown.map((l) => [l.code, l.amountMinor]));
  const sum = (result: ReturnType<typeof run>) =>
    result.breakdown.reduce((total, line) => total + line.amountMinor, 0);

  it('prices both flights, each with the minimum billable hours', () => {
    const result = run([RATE, rule('MIN_BILLABLE_HOURS', { hours: 2 })], {
      returnAt: at('2026-12-05T05:30:00Z'),
    });
    expect(codes(result)).toMatchObject({
      OPERATING: 20_000_000,
      OPERATING_RETURN: 20_000_000,
    });
    expect(result.distanceKm).toBe(1200);
    expect(result.flightMinutes).toBe(120);
  });

  it('waits on a same-day return: hours beyond the free allowance', () => {
    // On the ground 05:30 to 09:00: 3.5 h, 1 h free.
    const result = run(ALL, { returnAt: at('2026-12-05T09:00:00Z') });
    expect(result.roundTrip?.strategy).toBe('WAIT');
    expect(result.roundTrip?.nights).toBe(0);
    expect(codes(result).WAITING).toBe(2_500_000);
    expect(codes(result).OVERNIGHT).toBeUndefined();
    expect(result.assumptions.join(' ')).toMatch(/waits at B/);
  });

  it('charges no waiting within the free hours, and none at zero', () => {
    const within = run(ALL, { returnAt: at('2026-12-05T06:30:00Z') });
    expect(within.roundTrip?.strategy).toBe('WAIT');
    expect(codes(within).WAITING).toBeUndefined();
    const free = run(
      [RATE, rule('WAITING', { amountMinor: 1, freeHours: 0 })],
      {
        returnAt: at('2026-12-05T05:30:00Z'),
      },
    );
    expect(codes(free).WAITING).toBeUndefined();
    expect(free.warnings.join(' ')).not.toMatch(/waiting/);
  });

  it('charges overnight and crew per night away, not waiting hours', () => {
    const result = run(ALL, { returnAt: at('2026-12-07T04:00:00Z') });
    expect(result.roundTrip?.nights).toBe(2);
    expect(codes(result)).toMatchObject({
      OVERNIGHT: 6_000_000,
      CREW: 4_000_000,
    });
    expect(codes(result).WAITING).toBeUndefined();
  });

  it('counts nights in local dates at the destination', () => {
    // 20:00 UTC is 01:30 the next day in India.
    const from = at('2026-12-05T17:00:00Z');
    const to = at('2026-12-05T20:00:00Z');
    expect(localNights('UTC', from, to)).toBe(0);
    expect(localNights('Asia/Kolkata', from, to)).toBe(1);
  });

  it('returns to base when that is cheaper than nights away', () => {
    // Based at A (the origin), 2 nights at B cost 1,00,00,000; flying back
    // and out again costs 2 × 1 h × 0.5 × 1,00,00,000.
    const result = run(ALL, { returnAt: at('2026-12-07T04:00:00Z') });
    expect(result.roundTrip?.options).toEqual([
      expect.objectContaining({ strategy: 'WAIT', complete: true }),
      expect.objectContaining({ strategy: 'RETURN_TO_BASE', complete: true }),
    ]);
    const cheaper = run(
      [
        RATE,
        POSITIONING,
        WAITING,
        CREW,
        rule('OVERNIGHT', { amountMinor: 9_000_000 }),
      ],
      { returnAt: at('2026-12-07T04:00:00Z') },
    );
    expect(cheaper.roundTrip?.strategy).toBe('RETURN_TO_BASE');
    expect(codes(cheaper)).toMatchObject({
      INTERIM_REPOSITIONING: 5_000_000,
      INTERIM_POSITIONING: 5_000_000,
    });
    expect(codes(cheaper).OVERNIGHT).toBeUndefined();
    expect(cheaper.assumptions.join(' ')).toMatch(/returns to A between/);
    expect(cheaper.totalMinor).toBe(sum(cheaper));
  });

  it('keeps the waiting price when it is cheaper, and WAIT on a tie', () => {
    const result = run(ALL, { returnAt: at('2026-12-07T04:00:00Z') });
    // WAIT 10,00,000 × 2 nights = 1,00,00,000 = RETURN_TO_BASE: a tie.
    expect(result.roundTrip?.strategy).toBe('WAIT');
    expect(result.assumptions.join(' ')).toMatch(
      /waits 2 nights at B .* priced below returning to A/,
    );
  });

  it('only waits when there is not time to fly to base and back', () => {
    // 3.5 h on the ground; to a base 3 h away and back takes 6 h.
    const C = point('C', 0, -12); // 1,800 km from B: 3 h each way
    const result = run([RATE, POSITIONING, WAITING], {
      aircraft: { ...AIRCRAFT, base: C },
      returnAt: at('2026-12-05T09:00:00Z'),
    });
    expect(result.roundTrip?.options.map((o) => o.strategy)).toEqual(['WAIT']);
    expect(result.assumptions.join(' ')).toMatch(/not time to return to C/);
  });

  it('a strategy with an input not on record loses to a complete one', () => {
    // No overnight or crew rule: waiting 2 nights cannot be fully priced.
    const result = run([RATE, POSITIONING], {
      returnAt: at('2026-12-07T04:00:00Z'),
    });
    expect(result.roundTrip?.strategy).toBe('RETURN_TO_BASE');
    expect(result.warnings.join(' ')).not.toMatch(/overnight/);
  });

  it('warns and excludes what it cannot price when nothing is complete', () => {
    const C = point('C', 0, -12);
    const result = run([RATE, POSITIONING], {
      aircraft: { ...AIRCRAFT, base: C },
      returnAt: at('2026-12-05T09:00:00Z'),
    });
    expect(result.roundTrip?.strategy).toBe('WAIT');
    expect(result.roundTrip?.options[0].complete).toBe(false);
    expect(result.warnings.join(' ')).toMatch(/No waiting charge/);
    expect(result.exclusions).toContain('Waiting at B');
  });

  it('an aircraft based at the destination stays at home between flights', () => {
    const result = run(ALL, {
      aircraft: { ...AIRCRAFT, base: B },
      returnAt: at('2026-12-07T04:00:00Z'),
    });
    expect(result.roundTrip?.strategy).toBe('RETURN_TO_BASE');
    expect(codes(result).OVERNIGHT).toBeUndefined();
    expect(codes(result).INTERIM_REPOSITIONING).toBeUndefined();
    expect(result.assumptions.join(' ')).toMatch(/stays at its base, B/);
  });

  it('lands and handles at both ends of both flights', () => {
    const result = run(
      [
        RATE,
        rule('LANDING', { amountMinor: 100 }),
        rule('HANDLING', { amountMinor: 10 }),
      ],
      { returnAt: at('2026-12-05T05:30:00Z') },
    );
    expect(codes(result).LANDING_HANDLING).toBe(240);
  });

  it('is not priced when the return leaves before the outbound lands', () => {
    const result = run(ALL, { returnAt: at('2026-12-05T05:00:00Z') });
    expect(result.priced).toBe(false);
    expect(result.roundTrip?.strategy).toBeNull();
  });

  it('the same inputs give the same price, and the total is the breakdown', () => {
    const rows = [
      ...ALL,
      rule('COMMISSION', { percent: 7.5, mode: 'ADD_ON' }),
      rule('TAX', { name: 'GST', percent: 18 }),
      rule('TIME_ALLOWANCE', { minutes: 7 }),
    ];
    const input = { returnAt: at('2026-12-06T11:13:00Z') };
    const first = run(rows, input);
    expect(run(rows, input)).toEqual(first);
    expect(first.totalMinor).toBe(sum(first));
    expect(Number.isInteger(first.totalMinor)).toBe(true);
  });

  it('a one-way trip has no round-trip pricing', () => {
    expect(run(ALL).roundTrip).toBeNull();
  });
});

describe('sector and fixed-route pricing (M5 4c)', () => {
  const at = (iso: string) => new Date(iso);
  const SECTOR = rule(
    'SECTOR_RATE',
    { amountMinor: 8_000_000, currency: 'INR' },
    'AIRCRAFT',
    'ac1',
  );
  const FIXED = rule(
    'FIXED_ROUTE',
    {
      currency: 'INR',
      routes: [{ originId: 'B', destinationId: 'A', amountMinor: 7_000_000 }],
    },
    'AIRCRAFT',
    'ac1',
  );
  const model = (pricingModel: 'HOURLY' | 'SECTOR' | 'FIXED_ROUTE') => ({
    aircraft: { ...AIRCRAFT, pricingModel, base: A },
  });
  const ruleIds = (result: ReturnType<typeof run>) =>
    result.appliedRules.map((applied) => applied.id);

  it('a sector aircraft pays its sector rate per flight, whatever the hours', () => {
    const minimum = rule('MIN_BILLABLE_HOURS', { hours: 3 });
    const result = run([RATE, SECTOR, minimum], model('SECTOR'));
    expect(result.breakdown[0]).toMatchObject({
      code: 'OPERATING',
      amountMinor: 8_000_000,
    });
    expect(ruleIds(result)).toContain(SECTOR.id);
    // Neither the hourly rate nor the minimum hours priced anything.
    expect(ruleIds(result)).not.toContain(RATE.id);
    expect(ruleIds(result)).not.toContain(minimum.id);
    const back = run([SECTOR], {
      ...model('SECTOR'),
      returnAt: at('2026-12-05T08:00:00Z'),
    });
    expect(back.breakdown.slice(0, 2).map((l) => l.amountMinor)).toEqual([
      8_000_000, 8_000_000,
    ]);
  });

  it('each model reads only its own rate', () => {
    expect(run([RATE], model('SECTOR')).priced).toBe(false);
    expect(run([RATE], model('SECTOR')).warnings.join(' ')).toMatch(
      /No sector rate/,
    );
    expect(run([SECTOR, FIXED], model('HOURLY')).priced).toBe(false);
    expect(run([RATE, SECTOR], model('FIXED_ROUTE')).priced).toBe(false);
  });

  it('a fixed route is priced in either direction, and another route is on request', () => {
    const out = run([FIXED], model('FIXED_ROUTE'));
    expect(out.breakdown[0].amountMinor).toBe(7_000_000);
    expect(ruleIds(out)).toEqual([FIXED.id]);
    const C = point('C', 0, 3);
    const other = run([FIXED], { ...model('FIXED_ROUTE'), destination: C });
    expect(other.priced).toBe(false);
    expect(other.warnings.join(' ')).toMatch(/No fixed price/);
  });

  it('positions at the hourly rate, or says it cannot without one', () => {
    const C = point('C', 0, -3); // 300 km from A, 900 km from B
    const positioning = rule('POSITIONING', { rateFactor: 0.5 });
    const based = {
      aircraft: { ...AIRCRAFT, pricingModel: 'SECTOR' as const, base: C },
    };
    const withRate = run([SECTOR, RATE, positioning], based);
    expect(withRate.breakdown.map((l) => [l.code, l.amountMinor])).toEqual([
      ['OPERATING', 8_000_000],
      ['POSITIONING', 2_500_000],
      ['REPOSITIONING', 7_500_000],
    ]);
    expect(ruleIds(withRate)).toContain(RATE.id);
    const without = run([SECTOR, positioning], based);
    expect(without.priced).toBe(true);
    expect(without.breakdown.map((l) => l.code)).toEqual(['OPERATING']);
    expect(without.warnings.join(' ')).toMatch(
      /No hourly rate is set; positioning/,
    );
    expect(without.exclusions).toContain('Aircraft positioning');
  });

  it('a sector aircraft without an hourly rate does not return to base between flights', () => {
    const result = run(
      [
        SECTOR,
        rule('POSITIONING', { rateFactor: 0.5 }),
        rule('OVERNIGHT', { amountMinor: 1 }),
        rule('CREW', { amountMinor: 1 }),
      ],
      {
        ...model('SECTOR'),
        destination: B,
        returnAt: at('2026-12-07T04:00:00Z'),
      },
    );
    // Based at the origin A: returning to base would need the hourly rate.
    expect(result.roundTrip?.options).toEqual([
      expect.objectContaining({ strategy: 'WAIT', complete: true }),
      expect.objectContaining({ strategy: 'RETURN_TO_BASE', complete: false }),
    ]);
    expect(result.roundTrip?.strategy).toBe('WAIT');
  });

  describe('every operator rate is normalised before commission and tax', () => {
    const addOn = rule('COMMISSION', { percent: 10, mode: 'ADD_ON' });
    const deducted = rule('COMMISSION', { percent: 10, mode: 'DEDUCTED' });
    const gst = rule('TAX', { name: 'GST', percent: 18 });
    // An exclusive 1,00,00,000 flight: with tax, plus 10%, or both.
    const cases = [
      { flags: {}, amount: 10_000_000 },
      { flags: { taxInclusive: true }, amount: 11_800_000 },
      { flags: { commissionInclusive: true }, amount: 11_000_000 },
      {
        flags: { taxInclusive: true, commissionInclusive: true },
        amount: 12_980_000,
      },
    ];
    const rates = (amountMinor: number, flags: object) => ({
      HOURLY: rule(
        'HOURLY_RATE',
        { amountMinor, currency: 'INR', ...flags },
        'AIRCRAFT',
        'ac1',
      ),
      SECTOR: rule(
        'SECTOR_RATE',
        { amountMinor, currency: 'INR', ...flags },
        'AIRCRAFT',
        'ac1',
      ),
      FIXED_ROUTE: rule(
        'FIXED_ROUTE',
        {
          currency: 'INR',
          ...flags,
          routes: [{ originId: 'A', destinationId: 'B', amountMinor }],
        },
        'AIRCRAFT',
        'ac1',
      ),
    });

    for (const pricingModel of ['HOURLY', 'SECTOR', 'FIXED_ROUTE'] as const) {
      for (const { flags, amount } of cases) {
        it(`${pricingModel} ${JSON.stringify(flags)}: commission and tax once`, () => {
          const rate = rates(amount, flags)[pricingModel];
          const result = run([rate, addOn, gst], model(pricingModel));
          expect(result.baseMinor).toBe(10_000_000);
          expect(result.feesMinor).toBe(1_000_000);
          expect(result.taxMinor).toBe(1_980_000);
          expect(result.totalMinor).toBe(12_980_000);
        });
      }
      it(`${pricingModel}: under deducted commission only tax is taken out`, () => {
        const rate = rates(11_800_000, {
          taxInclusive: true,
          commissionInclusive: true,
        })[pricingModel];
        const result = run([rate, deducted, gst], model(pricingModel));
        expect(result.baseMinor).toBe(10_000_000);
        expect(result.feesMinor).toBe(0);
        expect(result.totalMinor).toBe(11_800_000);
        expect(result.operatorPayableMinor).toBe(9_000_000);
      });
    }
  });
});

describe('trip charges, parking and the per-day minimum (M5 4c)', () => {
  const at = (iso: string) => new Date(iso);
  const codes = (result: ReturnType<typeof run>) =>
    Object.fromEntries(result.breakdown.map((l) => [l.code, l.amountMinor]));
  const sum = (result: ReturnType<typeof run>) =>
    result.breakdown.reduce((total, line) => total + line.amountMinor, 0);
  const CHARGES = [
    rule('FUEL_SURCHARGE', { amountMinor: 100_000 }, 'OPERATOR', 'op1'),
    rule('PERMIT', { amountMinor: 50_000 }, 'OPERATOR', 'op1'),
    rule('NAVIGATION', { amountMinor: 20_000 }, 'OPERATOR', 'op1'),
    rule(
      'OTHER',
      { label: 'De-icing', amountMinor: 30_000 },
      'OPERATOR',
      'op1',
    ),
  ];

  it('charges fuel, permits and navigation per flight and the other charge once', () => {
    const one = run([RATE, ...CHARGES]);
    expect(codes(one)).toMatchObject({
      FUEL_SURCHARGE: 100_000,
      PERMIT: 50_000,
      NAVIGATION: 20_000,
      OTHER: 30_000,
    });
    expect(one.breakdown.find((l) => l.code === 'OTHER')?.label).toBe(
      'De-icing',
    );
    const both = run([RATE, ...CHARGES], {
      returnAt: at('2026-12-05T05:30:00Z'),
    });
    expect(codes(both)).toMatchObject({
      FUEL_SURCHARGE: 200_000,
      PERMIT: 100_000,
      NAVIGATION: 40_000,
      OTHER: 30_000,
    });
  });

  it('trip charges are exclusive amounts: an inclusive rate does not reduce them', () => {
    const inclusive = rule(
      'HOURLY_RATE',
      {
        amountMinor: 12_980_000,
        currency: 'INR',
        taxInclusive: true,
        commissionInclusive: true,
      },
      'AIRCRAFT',
      'ac1',
    );
    const result = run([
      inclusive,
      ...CHARGES,
      rule('COMMISSION', { percent: 10, mode: 'ADD_ON' }),
      rule('TAX', { name: 'GST', percent: 18 }),
    ]);
    // 1,00,00,000 flying + 2,00,000 charges, then 10% and 18% once each.
    expect(result.baseMinor).toBe(10_200_000);
    expect(result.feesMinor).toBe(1_020_000);
    expect(result.taxMinor).toBe(2_019_600);
    expect(result.totalMinor).toBe(13_239_600);
    expect(result.totalMinor).toBe(sum(result));
  });

  it('a zero charge adds no line', () => {
    const result = run([RATE, rule('PERMIT', { amountMinor: 0 })]);
    expect(codes(result).PERMIT).toBeUndefined();
  });

  it('a per-day minimum bills the days together, not each flight', () => {
    const perDay = rule('MIN_BILLABLE_HOURS', { hours: 2, per: 'DAY' });
    // One way, 1 h flown, 2 h a day: 1 h short.
    const one = run([RATE, perDay]);
    expect(codes(one)).toMatchObject({
      OPERATING: 10_000_000,
      MIN_BILLABLE: 10_000_000,
    });
    // Same day out and back: 2 h flown covers the day.
    const sameDay = run([RATE, perDay], {
      returnAt: at('2026-12-05T08:00:00Z'),
    });
    expect(codes(sameDay).MIN_BILLABLE).toBeUndefined();
    // 5 to 7 December is 3 days: 6 h billed, 2 h flown.
    const threeDays = run([RATE, perDay], {
      returnAt: at('2026-12-07T08:00:00Z'),
    });
    expect(codes(threeDays)).toMatchObject({
      OPERATING: 10_000_000,
      OPERATING_RETURN: 10_000_000,
      MIN_BILLABLE: 40_000_000,
    });
    expect(threeDays.totalMinor).toBe(sum(threeDays));
    // Per leg (no `per`), the same day bills 2 h on each flight.
    const perLeg = run([RATE, rule('MIN_BILLABLE_HOURS', { hours: 2 })], {
      returnAt: at('2026-12-05T08:00:00Z'),
    });
    expect(codes(perLeg)).toMatchObject({
      OPERATING: 20_000_000,
      OPERATING_RETURN: 20_000_000,
    });
  });

  describe('parking', () => {
    const parked = (parkingMinor: number) => ({
      ...B,
      charges: {
        currency: 'INR',
        categories: [
          {
            category: 'LIGHT_JET',
            landingMinor: 0,
            parkingMinor,
            handlingMinor: 0,
          },
        ],
      },
    });
    const WAITING = [
      RATE,
      rule('OVERNIGHT', { amountMinor: 1_000 }),
      rule('CREW', { amountMinor: 1_000 }),
      rule('WAITING', { amountMinor: 1_000, freeHours: 0 }),
    ];

    it('charges the destination parking per night the aircraft waits there', () => {
      const result = run(WAITING, {
        destination: parked(500_000),
        returnAt: at('2026-12-07T04:00:00Z'),
      });
      expect(result.roundTrip?.strategy).toBe('WAIT');
      expect(codes(result).PARKING).toBe(1_000_000);
      expect(result.totalMinor).toBe(sum(result));
    });

    it('charges no parking on a same-day return', () => {
      const result = run(WAITING, {
        destination: parked(500_000),
        returnAt: at('2026-12-05T09:00:00Z'),
      });
      expect(codes(result).PARKING).toBeUndefined();
    });

    it('parking not on record is a warning and an exclusion, not a lost strategy', () => {
      const result = run(WAITING, { returnAt: at('2026-12-07T04:00:00Z') });
      expect(result.roundTrip?.options[0]).toMatchObject({
        strategy: 'WAIT',
        complete: true,
      });
      expect(result.warnings.join(' ')).toMatch(/Parking charges at B/);
      expect(result.exclusions).toContain('Parking at B');
    });
  });
});

describe('markup, service fee and discount (M5 4c)', () => {
  const sum = (result: ReturnType<typeof run>) =>
    result.breakdown.reduce((total, line) => total + line.amountMinor, 0);
  const gst = rule('TAX', { name: 'GST', percent: 18 });
  const PLATFORM = [
    gst,
    rule('MARKUP', { percent: 5 }),
    rule('SERVICE_FEE', { amountMinor: 200_000 }),
    rule('DISCOUNT', { name: 'Launch offer', percent: 10 }),
  ];

  it('adds markup and fee, takes the discount before tax, and Flyviman funds it', () => {
    const result = run([
      RATE,
      rule('COMMISSION', { percent: 10, mode: 'ADD_ON' }),
      ...PLATFORM,
    ]);
    expect(result.breakdown.map((l) => [l.code, l.amountMinor])).toEqual([
      ['OPERATING', 10_000_000],
      ['PLATFORM_FEE', 1_000_000],
      ['MARKUP', 500_000],
      ['SERVICE_FEE', 200_000],
      ['DISCOUNT', -1_170_000],
      ['TAX', 1_895_400],
    ]);
    expect(result.breakdown.find((l) => l.code === 'DISCOUNT')?.label).toBe(
      'Launch offer',
    );
    expect(result).toMatchObject({
      baseMinor: 10_000_000,
      feesMinor: 1_700_000,
      discountMinor: 1_170_000,
      taxMinor: 1_895_400,
      totalMinor: 12_425_400,
      operatorPayableMinor: 10_000_000,
      platformRevenueMinor: 530_000,
    });
    expect(result.totalMinor).toBe(sum(result));
    expect(
      result.operatorPayableMinor +
        result.platformRevenueMinor +
        result.taxMinor,
    ).toBe(result.totalMinor);
  });

  it('holds under deducted commission too', () => {
    const result = run([
      RATE,
      rule('COMMISSION', { percent: 10, mode: 'DEDUCTED' }),
      ...PLATFORM,
    ]);
    expect(result).toMatchObject({
      feesMinor: 700_000,
      discountMinor: 1_070_000,
      taxMinor: 1_733_400,
      totalMinor: 11_363_400,
      operatorPayableMinor: 9_000_000,
      platformRevenueMinor: 630_000,
    });
    expect(result.totalMinor).toBe(sum(result));
    expect(
      result.operatorPayableMinor +
        result.platformRevenueMinor +
        result.taxMinor,
    ).toBe(result.totalMinor);
  });

  it('a tax- and commission-inclusive rate gives the same platform charges', () => {
    const inclusive = rule(
      'HOURLY_RATE',
      {
        amountMinor: 12_980_000,
        currency: 'INR',
        taxInclusive: true,
        commissionInclusive: true,
      },
      'AIRCRAFT',
      'ac1',
    );
    const result = run([
      inclusive,
      rule('COMMISSION', { percent: 10, mode: 'ADD_ON' }),
      ...PLATFORM,
    ]);
    expect(result).toMatchObject({
      baseMinor: 10_000_000,
      feesMinor: 1_700_000,
      discountMinor: 1_170_000,
      taxMinor: 1_895_400,
      totalMinor: 12_425_400,
    });
  });

  it('caps the discount at what Flyviman earns on the trip', () => {
    const result = run([
      RATE,
      rule('COMMISSION', { percent: 10, mode: 'DEDUCTED' }),
      gst,
      rule('SERVICE_FEE', { amountMinor: 200_000 }),
      rule('DISCOUNT', { name: 'Big offer', percent: 50 }),
    ]);
    // Offered 50% of 1,02,00,000; Flyviman earns 10,00,000 + 2,00,000.
    expect(result).toMatchObject({
      discountMinor: 1_200_000,
      platformRevenueMinor: 0,
      operatorPayableMinor: 9_000_000,
      taxMinor: 1_620_000, // 18% of 1,02,00,000 − 12,00,000
      totalMinor: 10_620_000,
    });
    expect(result.totalMinor).toBe(sum(result));
    expect(result.assumptions.join(' ')).toMatch(/Big offer is limited/);
    // Uncapped, nothing is said.
    const small = run([
      RATE,
      rule('COMMISSION', { percent: 10, mode: 'ADD_ON' }),
      ...PLATFORM,
    ]);
    expect(small.assumptions.join(' ')).not.toMatch(/limited/);
  });

  it('a zero setting adds no line', () => {
    const result = run([
      RATE,
      rule('MARKUP', { percent: 0 }),
      rule('SERVICE_FEE', { amountMinor: 0 }),
      rule('DISCOUNT', { name: 'Off', percent: 0 }),
    ]);
    expect(result.breakdown.map((l) => l.code)).toEqual(['OPERATING']);
    expect(result.totalMinor).toBe(10_000_000);
  });

  it('an operator cannot set markup, a service fee or a discount', () => {
    const result = run([
      RATE,
      rule('MARKUP', { percent: 20 }, 'OPERATOR', 'op1'),
      rule('SERVICE_FEE', { amountMinor: 1 }, 'AIRCRAFT', 'ac1'),
      rule('DISCOUNT', { name: 'Mine', percent: 20 }, 'OPERATOR', 'op1'),
    ]);
    expect(result.breakdown.map((l) => l.code)).toEqual(['OPERATING']);
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
