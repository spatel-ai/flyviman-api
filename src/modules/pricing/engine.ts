import type { AircraftCategory } from '../../generated/prisma/enums.js';
import type { ResolvedRules, RuleRow } from './rules.js';

/**
 * The charter and helicopter price engine (docs/architecture/pricing-engine.md),
 * one-way and round trips. Pure: everything it needs is passed in, so the
 * same inputs and rule versions always give the same price.
 */

export interface PricePoint {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** IANA time zone: nights away are counted in local dates. */
  timeZone: string;
  /** `Location.charges`: per-category landing, parking and handling. */
  charges: unknown;
}

export interface EngineInput {
  now: Date;
  origin: PricePoint;
  destination: PricePoint;
  departureAt: Date;
  /** Set for a round trip: when the return flight leaves the destination. */
  returnAt?: Date | null;
  aircraft: {
    id: string;
    operatorId: string;
    category: AircraftCategory;
    cruiseSpeedKmh: number | null;
    /** Where it is: current location, else home base. */
    base: PricePoint | null;
  };
  rules: ResolvedRules;
  /** Great-circle (or provider) distance, before the routing factor. */
  rawDistanceKm: (from: PricePoint, to: PricePoint) => number;
}

export interface LineItem {
  code: string;
  label: string;
  amountMinor: number;
  basis?: string;
}

export interface AppliedRule {
  id: string;
  type: string;
  scope: string;
  version: number;
}

export type RoundTripStrategy = 'WAIT' | 'RETURN_TO_BASE';

/** How a round trip was priced, for the stored calculation's inputs. */
export interface RoundTripPricing {
  /** Null when the trip could not be priced. */
  strategy: RoundTripStrategy | null;
  /** From landing at the destination to the return departure. */
  groundMinutes: number;
  /** Local dates at the destination between landing and the return. */
  nights: number;
  /** Every strategy priced, and whether all its inputs were on record. */
  options: {
    strategy: RoundTripStrategy;
    totalMinor: number;
    complete: boolean;
  }[];
}

export interface EngineResult {
  /** False when an input is missing: shown as "price on request". */
  priced: boolean;
  /** The customer's flying: one leg, or out and back for a round trip. */
  distanceKm: number;
  /** Null when the cruise speed is unknown. Out and back for a round trip. */
  flightMinutes: number | null;
  positioningMinutes: number;
  repositioningMinutes: number;
  /** Null for a one-way trip. */
  roundTrip: RoundTripPricing | null;
  breakdown: LineItem[];
  baseMinor: number;
  feesMinor: number;
  taxMinor: number;
  discountMinor: number;
  totalMinor: number;
  operatorPayableMinor: number;
  platformRevenueMinor: number;
  currency: 'INR';
  validUntil: Date;
  appliedRules: AppliedRule[];
  assumptions: string[];
  exclusions: string[];
  warnings: string[];
}

const DEFAULT_VALIDITY_MINUTES = 60;

export function legMetrics(
  rules: ResolvedRules,
  rawKm: number,
  cruiseSpeedKmh: number | null,
): { distanceKm: number; minutes: number | null } {
  const factor = rules.ROUTING_FACTOR?.config.factor ?? 1;
  const allowance = rules.TIME_ALLOWANCE?.config.minutes ?? 0;
  const distanceKm = Math.round(rawKm * factor);
  const minutes =
    cruiseSpeedKmh && cruiseSpeedKmh > 0
      ? Math.round((distanceKm / cruiseSpeedKmh) * 60 + allowance)
      : null;
  return { distanceKm, minutes };
}

interface CategoryCharge {
  category: string;
  landingMinor: number;
  parkingMinor: number;
  handlingMinor: number;
}

function chargeAt(
  point: PricePoint,
  category: AircraftCategory,
): CategoryCharge | null {
  const charges = point.charges as {
    currency?: string;
    categories?: CategoryCharge[];
  } | null;
  if (!charges || charges.currency !== 'INR') return null;
  return (
    charges.categories?.find((entry) => entry.category === category) ?? null
  );
}

/**
 * Prices a trip. A round trip is priced both ways where both are possible:
 * the aircraft waits at the destination, or it returns to base between the
 * flights and comes back. The cheaper of those whose inputs are all on
 * record is kept (WAIT on a tie), and the choice is stated as an assumption.
 */
export function calculatePrice(input: EngineInput): EngineResult {
  const { returnAt } = input;
  if (!returnAt) return priceTrip(input, null).result;

  const { rules, aircraft, origin, destination } = input;
  const outbound = legMetrics(
    rules,
    input.rawDistanceKm(origin, destination),
    aircraft.cruiseSpeedKmh,
  );
  const landed = new Date(
    input.departureAt.getTime() + (outbound.minutes ?? 0) * 60_000,
  );
  const groundMinutes = Math.round(
    (returnAt.getTime() - landed.getTime()) / 60_000,
  );
  const nights = localNights(destination.timeZone, landed, returnAt);

  const base = aircraft.base;
  const strategies: RoundTripStrategy[] = [];
  let ferryFits = false;
  if (base?.id === destination.id) {
    // At home between the flights: nothing to fly, no nights away.
    strategies.push('RETURN_TO_BASE');
  } else {
    strategies.push('WAIT');
    if (base && aircraft.cruiseSpeedKmh) {
      const there = legMetrics(
        rules,
        input.rawDistanceKm(destination, base),
        aircraft.cruiseSpeedKmh,
      );
      const back = legMetrics(
        rules,
        input.rawDistanceKm(base, destination),
        aircraft.cruiseSpeedKmh,
      );
      ferryFits = (there.minutes ?? 0) + (back.minutes ?? 0) <= groundMinutes;
      if (ferryFits) strategies.push('RETURN_TO_BASE');
    }
  }

  const priced = strategies.map((strategy) =>
    priceTrip(input, { strategy, groundMinutes, nights }),
  );
  const complete = priced.filter((entry) => entry.missing.length === 0);
  const pool = complete.length > 0 ? complete : priced;
  const chosen = pool.reduce((best, entry) =>
    entry.result.totalMinor < best.result.totalMinor ? entry : best,
  );
  const { result } = chosen;
  const strategy = result.priced ? chosen.strategy : null;
  result.roundTrip = {
    strategy,
    groundMinutes,
    nights,
    options: result.priced
      ? priced.map((entry) => ({
          strategy: entry.strategy,
          totalMinor: entry.result.totalMinor,
          complete: entry.missing.length === 0,
        }))
      : [],
  };
  if (strategy) {
    result.assumptions.push(
      strategyAssumption(strategy, priced.length, ferryFits, {
        base: base?.name ?? null,
        destination: destination.name,
        nights,
      }),
    );
  }
  return result;
}

function strategyAssumption(
  strategy: RoundTripStrategy,
  options: number,
  ferryFits: boolean,
  names: { base: string | null; destination: string; nights: number },
): string {
  const { base, destination, nights } = names;
  if (strategy === 'RETURN_TO_BASE' && options === 1) {
    return `Round trip: the aircraft stays at its base, ${destination}, between the flights`;
  }
  if (strategy === 'RETURN_TO_BASE') {
    return `Round trip: the aircraft returns to ${base} between the flights and comes back for the return, priced below waiting at ${destination}`;
  }
  const stay =
    nights > 0
      ? `${nights} night${nights === 1 ? '' : 's'} at ${destination}`
      : `at ${destination}`;
  if (options > 1) {
    return `Round trip: the aircraft waits ${stay} until the return flight, priced below returning to ${base} between the flights`;
  }
  return base && !ferryFits
    ? `Round trip: the aircraft waits ${stay} until the return flight; there is not time to return to ${base} between the flights`
    : `Round trip: the aircraft waits ${stay} until the return flight`;
}

/** One date formatter per time zone: building one is costly. */
const dateFormats = new Map<string, Intl.DateTimeFormat>();

/** Local dates passed at `timeZone` from `from` to `to`: nights away. */
export function localNights(timeZone: string, from: Date, to: Date): number {
  let format = dateFormats.get(timeZone);
  if (!format) {
    // Throws for an unknown zone, as before; only a valid one is kept.
    format = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    dateFormats.set(timeZone, format);
  }
  const day = (date: Date) =>
    Date.parse(`${format.format(date)}T00:00:00Z`) / 86_400_000;
  return Math.max(0, day(to) - day(from));
}

interface Turnaround {
  strategy: RoundTripStrategy;
  groundMinutes: number;
  nights: number;
}

/**
 * One itinerary: one way when `turn` is null, else out, the strategy
 * between the flights, and back. `missing` names the strategy's inputs
 * that are not on record (each also a warning and an exclusion).
 */
function priceTrip(
  input: EngineInput,
  turn: Turnaround | null,
): { result: EngineResult; strategy: RoundTripStrategy; missing: string[] } {
  const { rules, aircraft, origin, destination } = input;
  const missing: string[] = [];
  const assumptions: string[] = [];
  const exclusions: string[] = [];
  const warnings: string[] = [];
  const used: RuleRow[] = [];
  const use = <T>(entry: { rule: RuleRow; config: T } | undefined) => {
    if (entry) used.push(entry.rule);
    return entry?.config;
  };

  const factor = use(rules.ROUTING_FACTOR)?.factor ?? 1;
  use(rules.TIME_ALLOWANCE);
  assumptions.push(
    `Great-circle distance with routing factor ${factor.toFixed(2)}`,
  );

  const leg = legMetrics(
    rules,
    input.rawDistanceKm(origin, destination),
    aircraft.cruiseSpeedKmh,
  );
  const legs = turn ? 2 : 1;
  // A round trip ends where it started.
  const end = turn ? origin : destination;

  // Positioning to the origin and back to base afterwards.
  const position = { out: 0, back: 0, outKm: 0, backKm: 0 };
  const positioning = rules.POSITIONING?.config;
  if (aircraft.base && aircraft.cruiseSpeedKmh) {
    const free = positioning?.freeWithinKm ?? 0;
    if (aircraft.base.id !== origin.id) {
      const out = legMetrics(
        rules,
        input.rawDistanceKm(aircraft.base, origin),
        aircraft.cruiseSpeedKmh,
      );
      if (out.distanceKm > free) {
        position.out = out.minutes ?? 0;
        position.outKm = out.distanceKm;
      }
    }
    if (aircraft.base.id !== end.id) {
      const back = legMetrics(
        rules,
        input.rawDistanceKm(end, aircraft.base),
        aircraft.cruiseSpeedKmh,
      );
      if (back.distanceKm > free) {
        position.back = back.minutes ?? 0;
        position.backKm = back.distanceKm;
        assumptions.push(
          turn
            ? `Aircraft returns to ${aircraft.base.name} after the return flight`
            : `Aircraft returns to ${aircraft.base.name} after drop-off`,
        );
      }
    }
  }

  const validityMinutes =
    use(rules.VALIDITY)?.minutes ?? DEFAULT_VALIDITY_MINUTES;
  const validUntil = new Date(input.now.getTime() + validityMinutes * 60_000);

  const distanceKm = leg.distanceKm * legs;
  const flightMinutes = leg.minutes == null ? null : leg.minutes * legs;
  const strategy = turn?.strategy ?? 'WAIT';
  const unpriced = (reason: string) => ({
    strategy,
    missing,
    result: {
      priced: false,
      distanceKm,
      flightMinutes,
      positioningMinutes: position.out,
      repositioningMinutes: position.back,
      roundTrip: null,
      breakdown: [],
      baseMinor: 0,
      feesMinor: 0,
      taxMinor: 0,
      discountMinor: 0,
      totalMinor: 0,
      operatorPayableMinor: 0,
      platformRevenueMinor: 0,
      currency: 'INR',
      validUntil,
      appliedRules: applied(used),
      assumptions,
      exclusions,
      warnings: [...warnings, reason],
    } satisfies EngineResult,
  });

  const rate = use(rules.HOURLY_RATE);
  if (!rate) return unpriced('No hourly rate is set for this aircraft.');
  if (rate.currency !== 'INR') {
    return unpriced('The hourly rate is not in INR.');
  }
  if (leg.minutes == null) {
    return unpriced('The aircraft has no cruise speed recorded.');
  }
  if (turn && turn.groundMinutes < 0) {
    return unpriced('The return departs before the outbound flight lands.');
  }

  const commission = use(rules.COMMISSION);
  const tax = use(rules.TAX);

  // Operator rates normalised to tax- and commission-exclusive amounts, so
  // commission and tax are each added exactly once (pricing-engine.md, step 6).
  let hourlyMinor = rate.amountMinor;
  if (rate.taxInclusive && tax) hourlyMinor /= 1 + tax.percent / 100;
  if (rate.commissionInclusive && commission?.mode === 'ADD_ON') {
    hourlyMinor /= 1 + commission.percent / 100;
  }

  const breakdown: LineItem[] = [];
  const minimum = use(rules.MIN_BILLABLE_HOURS)?.hours ?? 0;
  const hours = leg.minutes / 60;
  const billable = Math.max(hours, minimum);
  // The minimum applies to each of the customer's legs.
  const operating = {
    amountMinor: Math.round(billable * hourlyMinor),
    basis:
      billable > hours
        ? `${minimum} h minimum billable × hourly rate`
        : `${hours.toFixed(2)} h × hourly rate`,
  };
  breakdown.push({
    code: 'OPERATING',
    label: turn ? 'Outbound flight operating cost' : 'Flight operating cost',
    ...operating,
  });
  if (turn) {
    breakdown.push({
      code: 'OPERATING_RETURN',
      label: 'Return flight operating cost',
      ...operating,
    });
  }

  if (positioning && (position.out || position.back)) {
    used.push(rules.POSITIONING!.rule);
    const rateFactor = positioning.rateFactor;
    if (position.out) {
      breakdown.push({
        code: 'POSITIONING',
        label: `Positioning from ${aircraft.base!.name}`,
        amountMinor: Math.round((position.out / 60) * hourlyMinor * rateFactor),
        basis: `${position.outKm} km, ${(position.out / 60).toFixed(2)} h × ${rateFactor} × hourly rate`,
      });
    }
    if (position.back) {
      breakdown.push({
        code: 'REPOSITIONING',
        label: `Return to ${aircraft.base!.name}`,
        amountMinor: Math.round(
          (position.back / 60) * hourlyMinor * rateFactor,
        ),
        basis: `${position.backKm} km, ${(position.back / 60).toFixed(2)} h × ${rateFactor} × hourly rate`,
      });
    }
  } else if (position.out || position.back) {
    warnings.push('No positioning rate is set; positioning is not included.');
    exclusions.push('Aircraft positioning');
  }

  if (turn) {
    breakdown.push(
      ...turnaroundLines(input, turn, hourlyMinor, use, {
        missing,
        warnings,
        exclusions,
      }),
    );
  }

  // Landing at each arrival; handling at both ends of each leg.
  const arrivals = turn ? [destination, origin] : [destination];
  let landing = 0;
  for (const point of arrivals) {
    const landingAt = chargeAt(point, aircraft.category);
    const fallbackLanding = rules.LANDING?.config;
    const amount = landingAt?.landingMinor ?? fallbackLanding?.amountMinor;
    if (landingAt == null && fallbackLanding) used.push(rules.LANDING!.rule);
    if (amount == null) {
      warnings.push(`Landing charges at ${point.name} are not on record.`);
      exclusions.push(`Landing charges at ${point.name}`);
    } else landing += amount;
  }
  let handling = 0;
  let handlingKnown = true;
  const stops = turn
    ? [origin, destination, destination, origin]
    : [origin, destination];
  for (const point of stops) {
    const at = chargeAt(point, aircraft.category);
    const amount = at?.handlingMinor ?? rules.HANDLING?.config.amountMinor;
    if (at == null && rules.HANDLING) used.push(rules.HANDLING.rule);
    if (amount == null) {
      handlingKnown = false;
      if (!exclusions.includes(`Handling at ${point.name}`)) {
        exclusions.push(`Handling at ${point.name}`);
      }
    } else handling += amount;
  }
  if (!handlingKnown) warnings.push('Some handling charges are not on record.');
  const landingHandling = landing + handling;
  if (landingHandling > 0) {
    breakdown.push({
      code: 'LANDING_HANDLING',
      label: 'Landing and handling',
      amountMinor: landingHandling,
    });
  }

  let baseMinor = breakdown.reduce((sum, line) => sum + line.amountMinor, 0);
  const minCharge = use(rules.MIN_CHARGE)?.amountMinor;
  if (minCharge != null && baseMinor < minCharge) {
    breakdown.push({
      code: 'MIN_CHARGE',
      label: 'Minimum charge adjustment',
      amountMinor: minCharge - baseMinor,
    });
    baseMinor = minCharge;
  }

  let feesMinor = 0;
  let commissionMinor = 0;
  if (commission) {
    commissionMinor = Math.round((baseMinor * commission.percent) / 100);
    if (commission.mode === 'ADD_ON') {
      feesMinor = commissionMinor;
      breakdown.push({
        code: 'PLATFORM_FEE',
        label: 'Platform fee',
        amountMinor: feesMinor,
      });
    }
  } else {
    warnings.push('No commission rule is in force.');
  }

  let taxMinor = 0;
  if (tax) {
    taxMinor = Math.round(((baseMinor + feesMinor) * tax.percent) / 100);
    breakdown.push({ code: 'TAX', label: tax.name, amountMinor: taxMinor });
  } else {
    warnings.push('No tax rule is in force; tax is not included.');
    exclusions.push('Taxes');
  }

  return {
    strategy,
    missing,
    result: {
      priced: true,
      distanceKm,
      flightMinutes,
      positioningMinutes: position.out,
      repositioningMinutes: position.back,
      roundTrip: null,
      breakdown,
      baseMinor,
      feesMinor,
      taxMinor,
      discountMinor: 0,
      totalMinor: baseMinor + feesMinor + taxMinor,
      operatorPayableMinor:
        commission?.mode === 'DEDUCTED'
          ? baseMinor - commissionMinor
          : baseMinor,
      platformRevenueMinor: commissionMinor,
      currency: 'INR',
      validUntil,
      appliedRules: applied(used),
      assumptions,
      exclusions,
      warnings,
    },
  };
}

/**
 * The round trip's cost between the flights. WAIT: waiting hours beyond the
 * free allowance on a same-day return, or overnight and crew charges per
 * night away. RETURN_TO_BASE: the flights back to base and out again, at
 * the positioning rate (within `freeWithinKm` they are free). Amounts are
 * the operator's, tax- and commission-exclusive, like landing and handling.
 */
function turnaroundLines(
  input: EngineInput,
  turn: Turnaround,
  hourlyMinor: number,
  use: <T>(entry: { rule: RuleRow; config: T } | undefined) => T | undefined,
  out: { missing: string[]; warnings: string[]; exclusions: string[] },
): LineItem[] {
  const { rules, aircraft, destination } = input;
  const lines: LineItem[] = [];
  const lack = (what: string, warning: string) => {
    out.missing.push(what);
    out.warnings.push(warning);
    out.exclusions.push(what);
  };

  if (turn.strategy === 'RETURN_TO_BASE') {
    const base = aircraft.base!;
    if (base.id === destination.id) return lines;
    const free = rules.POSITIONING?.config.freeWithinKm ?? 0;
    const ferries = [
      {
        code: 'INTERIM_REPOSITIONING',
        label: `Return to ${base.name} between the flights`,
        leg: legMetrics(
          rules,
          input.rawDistanceKm(destination, base),
          aircraft.cruiseSpeedKmh,
        ),
      },
      {
        code: 'INTERIM_POSITIONING',
        label: `Positioning from ${base.name} for the return`,
        leg: legMetrics(
          rules,
          input.rawDistanceKm(base, destination),
          aircraft.cruiseSpeedKmh,
        ),
      },
    ].filter((ferry) => ferry.leg.distanceKm > free);
    if (ferries.length === 0) return lines;
    const positioning = use(rules.POSITIONING);
    if (!positioning) {
      lack(
        'Return to base between the flights',
        'No positioning rate is set; returning to base between the flights is not included.',
      );
      return lines;
    }
    for (const { code, label, leg } of ferries) {
      const hours = (leg.minutes ?? 0) / 60;
      lines.push({
        code,
        label,
        amountMinor: Math.round(hours * hourlyMinor * positioning.rateFactor),
        basis: `${leg.distanceKm} km, ${hours.toFixed(2)} h × ${positioning.rateFactor} × hourly rate`,
      });
    }
    return lines;
  }

  if (turn.nights === 0) {
    if (turn.groundMinutes === 0) return lines;
    const waiting = use(rules.WAITING);
    if (!waiting) {
      lack(
        `Waiting at ${destination.name}`,
        'No waiting charge is set; waiting between the flights is not included.',
      );
      return lines;
    }
    const hours = Math.max(0, turn.groundMinutes / 60 - waiting.freeHours);
    if (hours > 0) {
      lines.push({
        code: 'WAITING',
        label: `Waiting at ${destination.name}`,
        amountMinor: Math.round(hours * waiting.amountMinor),
        basis: `${hours.toFixed(2)} h beyond ${waiting.freeHours} h free × waiting rate`,
      });
    }
    return lines;
  }

  const nights = turn.nights;
  const plural = `${nights} night${nights === 1 ? '' : 's'}`;
  const overnight = use(rules.OVERNIGHT);
  if (overnight) {
    lines.push({
      code: 'OVERNIGHT',
      label: `Overnight at ${destination.name}, ${plural}`,
      amountMinor: nights * overnight.amountMinor,
      basis: `${plural} × overnight charge`,
    });
  } else {
    lack(
      `Overnight charges at ${destination.name}`,
      'No overnight charge is set; nights away from base are not included.',
    );
  }
  const crew = use(rules.CREW);
  if (crew) {
    lines.push({
      code: 'CREW',
      label: `Crew allowance, ${plural}`,
      amountMinor: nights * crew.amountMinor,
      basis: `${plural} × crew allowance`,
    });
  } else {
    lack(
      'Crew overnight costs',
      'No crew allowance is set; crew costs for nights away are not included.',
    );
  }
  return lines;
}

function applied(rules: RuleRow[]): AppliedRule[] {
  const seen = new Map<string, AppliedRule>();
  for (const rule of rules) {
    seen.set(rule.id, {
      id: rule.id,
      type: rule.type,
      scope: rule.scope,
      version: rule.version,
    });
  }
  return [...seen.values()];
}
