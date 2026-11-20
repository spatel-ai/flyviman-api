import type {
  AircraftCategory,
  AircraftPricingModel,
} from '../../generated/prisma/enums.js';
import type { OperatorRate, ResolvedRules, RuleRow } from './rules.js';

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
    /** How the flying is priced: hourly, per sector or per fixed route. */
    pricingModel: AircraftPricingModel;
    cruiseSpeedKmh: number | null;
    /** Where it is: current location, else home base. */
    base: PricePoint | null;
  };
  rules: ResolvedRules;
  /** Great-circle (or provider) distance, before the routing factor. */
  rawDistanceKm: (from: PricePoint, to: PricePoint) => number;
  /**
   * A promotion code the customer entered, already checked as applicable
   * (`pricing/promotions.ts`). Applied after the `DISCOUNT` rule, before tax.
   */
  promotion?: PromotionInput | null;
}

/** A promotion code as the engine applies it. Funded by Flyviman. */
export interface PromotionInput {
  id: string;
  code: string;
  /** The label of the customer's discount line. */
  name: string;
  kind: 'PERCENT' | 'FIXED';
  /** PERCENT: a share of the price before tax, two decimals at most. */
  percent?: number;
  /** FIXED: paise off. */
  amountMinor?: number;
}

/**
 * Every breakdown line code the engine writes. `search/breakdown.ts`
 * classifies each as folded into the customer's "Flying" line or shown as
 * is; its spec fails when a code here is not classified.
 */
export const LINE_CODES = [
  'OPERATING',
  'OPERATING_RETURN',
  'MIN_BILLABLE',
  'POSITIONING',
  'REPOSITIONING',
  'INTERIM_REPOSITIONING',
  'INTERIM_POSITIONING',
  'WAITING',
  'OVERNIGHT',
  'CREW',
  'PARKING',
  'FUEL_SURCHARGE',
  'PERMIT',
  'NAVIGATION',
  'OTHER',
  'LANDING_HANDLING',
  'MIN_CHARGE',
  'PLATFORM_FEE',
  'MARKUP',
  'SERVICE_FEE',
  'DISCOUNT',
  'PROMOTION',
  // Written only on a manual override's calculation (pricing.service.ts).
  'OVERRIDE',
  'TAX',
] as const;

export type LineCode = (typeof LINE_CODES)[number];

export interface LineItem {
  code: LineCode;
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
  /** The `DISCOUNT` rule and any promotion code together. */
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
/**
 * Minimum time on the ground at each end of a return to base between the
 * flights (at the destination and at the base), unless the `TIME_ALLOWANCE`
 * rule sets `turnaroundMinutes`.
 */
export const DEFAULT_TURNAROUND_MINUTES = 45;

/**
 * The one rounding rule for percentages (commission, markup, discount, tax):
 * `amountMinor × percent / 100`, with the percent taken as whole basis
 * points (it has at most two decimals) and the product in exact integers,
 * rounded half up to whole paise. So 12,345,000 × 0.57% = 70,366.5 gives
 * 70,367 every time, with no floating-point error.
 */
export function percentOf(amountMinor: number, percent: number): number {
  const product = BigInt(amountMinor) * BigInt(Math.round(percent * 100));
  // Half up for the non-negative amounts the engine passes.
  return Number((product * 2n + 10_000n) / 20_000n);
}

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
 * flights and comes back, when that fits with a turnaround at each end. A
 * complete option beats an incomplete one, the cheaper of two complete ones
 * is kept (WAIT on a tie, and when neither is complete), and the choice is
 * stated as an assumption.
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
      // A turnaround on the ground at each end: at the destination before
      // the flight to base, and at the base before the flight back.
      const turnaround =
        rules.TIME_ALLOWANCE?.config.turnaroundMinutes ??
        DEFAULT_TURNAROUND_MINUTES;
      ferryFits =
        (there.minutes ?? 0) + (back.minutes ?? 0) + 2 * turnaround <=
        groundMinutes;
      if (ferryFits) strategies.push('RETURN_TO_BASE');
    }
  }

  const priced = strategies.map((strategy) =>
    priceTrip(input, { strategy, groundMinutes, nights }),
  );
  // A complete option (every input on record) beats an incomplete one; two
  // complete options go to the cheaper, WAIT on a tie; two incomplete ones
  // cannot be compared, so WAIT is kept.
  let chosen = priced[0];
  let outcome: Outcome = 'ONLY';
  if (priced.length === 2) {
    const [wait, ferry] = priced;
    const waitComplete = wait.missing.length === 0;
    const ferryComplete = ferry.missing.length === 0;
    if (waitComplete && ferryComplete) {
      const ferryTotal = ferry.result.totalMinor;
      const waitTotal = wait.result.totalMinor;
      chosen = ferryTotal < waitTotal ? ferry : wait;
      outcome = ferryTotal === waitTotal ? 'TIE' : 'CHEAPER';
    } else if (waitComplete || ferryComplete) {
      chosen = waitComplete ? wait : ferry;
      outcome = 'OTHER_INCOMPLETE';
    } else {
      chosen = wait;
      outcome = 'BOTH_INCOMPLETE';
    }
  }
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
      strategyAssumption(strategy, outcome, ferryFits, {
        base: base?.name ?? null,
        destination: destination.name,
        nights,
      }),
    );
  }
  return result;
}

/** How the round trip's strategy was chosen. */
type Outcome =
  /** The only option. */
  | 'ONLY'
  /** Both complete, and the chosen one strictly cheaper. */
  | 'CHEAPER'
  /** Both complete and the same price: WAIT kept. */
  | 'TIE'
  /** The chosen one complete, the other not. */
  | 'OTHER_INCOMPLETE'
  /** Neither complete: WAIT kept. */
  | 'BOTH_INCOMPLETE';

function strategyAssumption(
  strategy: RoundTripStrategy,
  outcome: Outcome,
  ferryFits: boolean,
  names: { base: string | null; destination: string; nights: number },
): string {
  const { base, destination, nights } = names;
  if (strategy === 'RETURN_TO_BASE') {
    if (outcome === 'ONLY') {
      return `Round trip: the aircraft stays at its base, ${destination}, between the flights`;
    }
    const ferry = `Round trip: the aircraft returns to ${base} between the flights and comes back for the return`;
    return outcome === 'CHEAPER'
      ? `${ferry}, priced below waiting at ${destination}`
      : `${ferry}; waiting at ${destination} could not be fully priced`;
  }
  const stay =
    nights > 0
      ? `${nights} night${nights === 1 ? '' : 's'} at ${destination}`
      : `at ${destination}`;
  const wait = `Round trip: the aircraft waits ${stay} until the return flight`;
  switch (outcome) {
    case 'CHEAPER':
      return `${wait}, priced below returning to ${base} between the flights`;
    case 'TIE':
      return `${wait}; returning to ${base} between the flights costs the same, so waiting was kept`;
    case 'OTHER_INCOMPLETE':
      return `${wait}; returning to ${base} between the flights could not be fully priced`;
    case 'BOTH_INCOMPLETE':
      return `${wait}; neither waiting nor returning to ${base} between the flights could be fully priced, so waiting was kept`;
    default:
      return base && !ferryFits
        ? `${wait}; there is not time to return to ${base} between the flights`
        : wait;
  }
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

  // The flying is priced by the aircraft's model: hours at the hourly rate,
  // a price per flight (sector), or a fixed price for the route. The hourly
  // rate also prices positioning, so a sector or fixed-route aircraft uses
  // it there when one is set.
  const hourly = rules.HOURLY_RATE;
  let flight: { rule: RuleRow; rate: OperatorRate };
  if (aircraft.pricingModel === 'SECTOR') {
    const sector = rules.SECTOR_RATE;
    if (!sector) return unpriced('No sector rate is set for this aircraft.');
    flight = { rule: sector.rule, rate: sector.config };
  } else if (aircraft.pricingModel === 'FIXED_ROUTE') {
    const fixed = rules.FIXED_ROUTE;
    const route = fixed?.config.routes.find(
      (entry) =>
        (entry.originId === origin.id &&
          entry.destinationId === destination.id) ||
        (entry.originId === destination.id &&
          entry.destinationId === origin.id),
    );
    if (!fixed || !route) {
      return unpriced('No fixed price is set for this route.');
    }
    flight = {
      rule: fixed.rule,
      rate: { ...fixed.config, amountMinor: route.amountMinor },
    };
  } else {
    if (!hourly) return unpriced('No hourly rate is set for this aircraft.');
    flight = { rule: hourly.rule, rate: hourly.config };
  }
  if (flight.rate.currency !== 'INR') {
    return unpriced('The aircraft rate is not in INR.');
  }
  if (leg.minutes == null) {
    return unpriced('The aircraft has no cruise speed recorded.');
  }
  if (turn && turn.groundMinutes < 0) {
    return unpriced('The return departs before the outbound flight lands.');
  }
  used.push(flight.rule);

  const commission = use(rules.COMMISSION);
  const tax = use(rules.TAX);

  // Operator rates normalised to tax- and commission-exclusive amounts, so
  // commission and tax are each added exactly once (pricing-engine.md, step 6).
  const exclusive = (rate: OperatorRate) => {
    let amount = rate.amountMinor;
    if (rate.taxInclusive && tax) amount /= 1 + tax.percent / 100;
    if (rate.commissionInclusive && commission?.mode === 'ADD_ON') {
      amount /= 1 + commission.percent / 100;
    }
    return amount;
  };
  const hourlyMinor =
    hourly && hourly.config.currency === 'INR'
      ? exclusive(hourly.config)
      : null;
  const useHourly = () => {
    if (hourly) used.push(hourly.rule);
  };

  const breakdown: LineItem[] = [];
  const hours = leg.minutes / 60;
  let operating: { amountMinor: number; basis: string };
  let shortfall: LineItem | null = null;
  if (aircraft.pricingModel === 'HOURLY') {
    const minimumRule = use(rules.MIN_BILLABLE_HOURS);
    const minimum = minimumRule?.hours ?? 0;
    const perDay = minimumRule?.per === 'DAY';
    const rate = hourlyMinor!;
    // Per leg: each of the customer's flights bills at least the minimum.
    // Per day: the flights together bill at least the minimum for each
    // local date at the origin from departure to return.
    const billable = perDay ? hours : Math.max(hours, minimum);
    operating = {
      amountMinor: Math.round(billable * rate),
      basis:
        billable > hours
          ? `${minimum} h minimum billable × hourly rate`
          : `${hours.toFixed(2)} h × hourly rate`,
    };
    if (perDay) {
      const days = input.returnAt
        ? localNights(origin.timeZone, input.departureAt, input.returnAt) + 1
        : 1;
      const flown = hours * legs;
      const floor = minimum * days;
      // Rounded once: the flights plus the shortfall bill exactly the
      // minimum hours × rate, whatever the flights' own rounding.
      const shortfallMinor =
        Math.round(floor * rate) - operating.amountMinor * legs;
      // Only when hours are short: a fractional (inclusive) rate can leave a
      // paisa of rounding when the flights exactly meet the minimum.
      if (floor > flown && shortfallMinor > 0) {
        shortfall = {
          code: 'MIN_BILLABLE',
          label: 'Minimum billable hours',
          amountMinor: shortfallMinor,
          basis: `${minimum} h a day × ${days} day${days === 1 ? '' : 's'}, ${flown.toFixed(2)} h flown; the difference × hourly rate`,
        };
      }
    }
  } else {
    operating = {
      amountMinor: Math.round(exclusive(flight.rate)),
      basis:
        aircraft.pricingModel === 'SECTOR'
          ? 'Sector rate per flight'
          : `Fixed price, ${origin.name} and ${destination.name}`,
    };
  }
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
  if (shortfall) breakdown.push(shortfall);

  if (position.out || position.back) {
    if (!positioning) {
      warnings.push('No positioning rate is set; positioning is not included.');
      exclusions.push('Aircraft positioning');
    } else if (hourlyMinor == null) {
      warnings.push('No hourly rate is set; positioning is not included.');
      exclusions.push('Aircraft positioning');
    } else {
      used.push(rules.POSITIONING!.rule);
      useHourly();
      const rateFactor = positioning.rateFactor;
      if (position.out) {
        breakdown.push({
          code: 'POSITIONING',
          label: `Positioning from ${aircraft.base!.name}`,
          amountMinor: Math.round(
            (position.out / 60) * hourlyMinor * rateFactor,
          ),
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
    }
  }

  if (turn) {
    breakdown.push(
      ...turnaroundLines(input, turn, hourlyMinor, useHourly, use, {
        missing,
        warnings,
        exclusions,
      }),
    );
  }

  // The operator's trip charges: per customer flight, and one of its own.
  const perFlight = [
    ['FUEL_SURCHARGE', 'Fuel surcharge', use(rules.FUEL_SURCHARGE)],
    ['PERMIT', 'Permits', use(rules.PERMIT)],
    ['NAVIGATION', 'Navigation charges', use(rules.NAVIGATION)],
  ] as const;
  for (const [code, label, charge] of perFlight) {
    if (!charge || charge.amountMinor === 0) continue;
    breakdown.push({
      code,
      label,
      amountMinor: charge.amountMinor * legs,
      basis: `${legs} flight${legs === 1 ? '' : 's'} × ${label.toLowerCase()} per flight`,
    });
  }
  const other = use(rules.OTHER);
  if (other && other.amountMinor > 0) {
    breakdown.push({
      code: 'OTHER',
      label: other.label,
      amountMinor: other.amountMinor,
      basis: 'Per trip',
    });
  }

  // Landing at each arrival; handling at both ends of each leg. Returning
  // to base between the flights adds two legs: to the base and back to the
  // destination. A ferry leg's charge not on record makes that strategy
  // incomplete, so it never undercuts a complete WAIT. The base is named in
  // warnings, never in exclusions, which customers see.
  const ferryBase =
    turn?.strategy === 'RETURN_TO_BASE' &&
    aircraft.base &&
    aircraft.base.id !== destination.id
      ? aircraft.base
      : null;
  const arrivals = !turn
    ? [destination]
    : ferryBase
      ? [destination, ferryBase, destination, origin]
      : [destination, origin];
  const stops = !turn
    ? [origin, destination]
    : ferryBase
      ? // Out, to base, back to the destination, and the return.
        [
          origin,
          destination,
          destination,
          ferryBase,
          ferryBase,
          destination,
          destination,
          origin,
        ]
      : [origin, destination, destination, origin];
  const placeName = (point: PricePoint) =>
    point.id === ferryBase?.id && point.id !== origin.id
      ? "the aircraft's base"
      : point.name;
  // Indexes of the ferry legs' arrivals and ends in the lists above.
  const ferryArrival = (index: number) =>
    ferryBase && (index === 1 || index === 2);
  const ferryStop = (index: number) => ferryBase && index >= 2 && index <= 5;
  const lackFor = (ferry: unknown, exclusion: string) => {
    if (ferry && !missing.includes(exclusion)) missing.push(exclusion);
  };
  let landing = 0;
  for (const [index, point] of arrivals.entries()) {
    const landingAt = chargeAt(point, aircraft.category);
    const fallbackLanding = rules.LANDING?.config;
    const amount = landingAt?.landingMinor ?? fallbackLanding?.amountMinor;
    if (landingAt == null && fallbackLanding) used.push(rules.LANDING!.rule);
    if (amount == null) {
      const warning = `Landing charges at ${point.name} are not on record.`;
      const exclusion = `Landing charges at ${placeName(point)}`;
      if (!warnings.includes(warning)) warnings.push(warning);
      if (!exclusions.includes(exclusion)) exclusions.push(exclusion);
      lackFor(ferryArrival(index), exclusion);
    } else landing += amount;
  }
  let handling = 0;
  let handlingKnown = true;
  for (const [index, point] of stops.entries()) {
    const at = chargeAt(point, aircraft.category);
    const amount = at?.handlingMinor ?? rules.HANDLING?.config.amountMinor;
    if (at == null && rules.HANDLING) used.push(rules.HANDLING.rule);
    if (amount == null) {
      handlingKnown = false;
      const exclusion = `Handling at ${placeName(point)}`;
      if (!exclusions.includes(exclusion)) exclusions.push(exclusion);
      lackFor(ferryStop(index), exclusion);
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

  // Flyviman's charges on the operator subtotal: commission, markup and a
  // service fee, then any discount (funded by Flyviman, so the operator's
  // payable never moves), then tax on what the customer pays before tax.
  let feesMinor = 0;
  let commissionMinor = 0;
  if (commission) {
    commissionMinor = percentOf(baseMinor, commission.percent);
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

  const markup = use(rules.MARKUP);
  const markupMinor = markup ? percentOf(baseMinor, markup.percent) : 0;
  if (markupMinor > 0) {
    breakdown.push({
      code: 'MARKUP',
      label: 'Markup',
      amountMinor: markupMinor,
      basis: `${markup!.percent}% of the operator subtotal`,
    });
  }
  const serviceFeeMinor = use(rules.SERVICE_FEE)?.amountMinor ?? 0;
  if (serviceFeeMinor > 0) {
    breakdown.push({
      code: 'SERVICE_FEE',
      label: 'Service fee',
      amountMinor: serviceFeeMinor,
      basis: 'Per trip',
    });
  }
  feesMinor += markupMinor + serviceFeeMinor;

  // Never more than Flyviman earns on the trip, so platform revenue never
  // goes below zero and the operator's payable never moves.
  const discount = use(rules.DISCOUNT);
  const platformMinor = commissionMinor + markupMinor + serviceFeeMinor;
  const offeredMinor = discount
    ? percentOf(baseMinor + feesMinor, discount.percent)
    : 0;
  const discountMinor = Math.min(offeredMinor, platformMinor);
  // Capped only when some of it applied: nothing applied is no discount.
  const capped = discountMinor > 0 && discountMinor < offeredMinor;
  if (capped) {
    // Customers see only that a limit applied; the stored line's basis
    // keeps the detail.
    assumptions.push(`${discount!.name} applied up to its limit for this trip`);
  }
  if (discountMinor > 0) {
    breakdown.push({
      code: 'DISCOUNT',
      label: discount!.name,
      amountMinor: -discountMinor,
      basis: capped
        ? `${discount!.percent}% of the price before tax (${offeredMinor} offered), limited to Flyviman's charges on this trip`
        : `${discount!.percent}% of the price before tax`,
    });
  }

  // A promotion code on top, limited to what Flyviman still earns after the
  // discount, for the same reason.
  const promotion = applyPromotion(
    input.promotion ?? null,
    baseMinor + feesMinor - discountMinor,
    platformMinor - discountMinor,
  );
  if (promotion) {
    if (promotion.capped) {
      assumptions.push(
        `${promotion.name} applied up to its limit for this trip`,
      );
    }
    if (promotion.amountMinor > 0) {
      breakdown.push({
        code: 'PROMOTION',
        label: promotion.name,
        amountMinor: -promotion.amountMinor,
        basis: promotion.basis,
      });
    }
  }
  const promotionMinor = promotion?.amountMinor ?? 0;
  const discountsMinor = discountMinor + promotionMinor;

  let taxMinor = 0;
  if (tax) {
    taxMinor = percentOf(baseMinor + feesMinor - discountsMinor, tax.percent);
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
      discountMinor: discountsMinor,
      totalMinor: baseMinor + feesMinor - discountsMinor + taxMinor,
      operatorPayableMinor:
        commission?.mode === 'DEDUCTED'
          ? baseMinor - commissionMinor
          : baseMinor,
      platformRevenueMinor:
        commissionMinor + markupMinor + serviceFeeMinor - discountsMinor,
      currency: 'INR',
      validUntil,
      appliedRules: promotion
        ? [
            ...applied(used),
            // Not a pricing rule: the promotion's own row, never edited.
            {
              id: promotion.id,
              type: 'PROMOTION',
              scope: 'PROMOTION',
              version: 1,
            },
          ]
        : applied(used),
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
 * the positioning rate (within `freeWithinKm` they are free). Nights away
 * also pay the destination's parking. Amounts are the operator's, tax- and
 * commission-exclusive, like landing and handling.
 */
function turnaroundLines(
  input: EngineInput,
  turn: Turnaround,
  /** Null when the aircraft has no hourly rate (sector or fixed route). */
  hourlyMinor: number | null,
  useHourly: () => void,
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
        code: 'INTERIM_REPOSITIONING' as const,
        label: `Return to ${base.name} between the flights`,
        leg: legMetrics(
          rules,
          input.rawDistanceKm(destination, base),
          aircraft.cruiseSpeedKmh,
        ),
      },
      {
        code: 'INTERIM_POSITIONING' as const,
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
    if (hourlyMinor == null) {
      lack(
        'Return to base between the flights',
        'No hourly rate is set; returning to base between the flights is not included.',
      );
      return lines;
    }
    useHourly();
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
  // The location's parking charge per night parked. Like landing, a charge
  // not on record is a warning, not a missing input of the strategy.
  const parking = chargeAt(destination, aircraft.category)?.parkingMinor;
  if (parking == null) {
    out.warnings.push(
      `Parking charges at ${destination.name} are not on record.`,
    );
    out.exclusions.push(`Parking at ${destination.name}`);
  } else if (parking > 0) {
    lines.push({
      code: 'PARKING',
      label: `Parking at ${destination.name}, ${plural}`,
      amountMinor: nights * parking,
      basis: `${plural} × parking charge`,
    });
  }
  return lines;
}

/**
 * A promotion code's amount off `beforeTaxMinor`: a percentage (rounded as
 * every percentage is) or a fixed amount, never more than `limitMinor`
 * (what Flyviman earns on the trip after any discount), so the operator's
 * payable never moves. Null when there is no promotion.
 */
export function applyPromotion(
  promotion: PromotionInput | null,
  beforeTaxMinor: number,
  limitMinor: number,
): {
  id: string;
  name: string;
  amountMinor: number;
  capped: boolean;
  basis: string;
} | null {
  if (!promotion) return null;
  const offeredMinor =
    promotion.kind === 'PERCENT'
      ? percentOf(Math.max(0, beforeTaxMinor), promotion.percent ?? 0)
      : Math.max(0, promotion.amountMinor ?? 0);
  const amountMinor = Math.max(0, Math.min(offeredMinor, limitMinor));
  const capped = amountMinor > 0 && amountMinor < offeredMinor;
  const offer =
    promotion.kind === 'PERCENT'
      ? `${promotion.percent}% of the price before tax`
      : `${offeredMinor} off`;
  return {
    id: promotion.id,
    name: promotion.name,
    amountMinor,
    capped,
    basis: capped
      ? `Code ${promotion.code}: ${offer} (${offeredMinor} offered), limited to Flyviman's charges on this trip`
      : `Code ${promotion.code}: ${offer}`,
  };
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
