import type { AircraftCategory } from '../../generated/prisma/enums.js';
import type { ResolvedRules, RuleRow } from './rules.js';

/**
 * The charter and helicopter price engine (docs/architecture/pricing-engine.md),
 * one-way trips. Pure: everything it needs is passed in, so the same inputs
 * and rule versions always give the same price.
 */

export interface PricePoint {
  id: string;
  name: string;
  latitude: number;
  longitude: number;
  /** `Location.charges`: per-category landing, parking and handling. */
  charges: unknown;
}

export interface EngineInput {
  now: Date;
  origin: PricePoint;
  destination: PricePoint;
  departureAt: Date;
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

export interface EngineResult {
  /** False when an input is missing: shown as "price on request". */
  priced: boolean;
  distanceKm: number;
  /** Null when the cruise speed is unknown. */
  flightMinutes: number | null;
  positioningMinutes: number;
  repositioningMinutes: number;
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

export function calculatePrice(input: EngineInput): EngineResult {
  const { rules, aircraft, origin, destination } = input;
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
    if (aircraft.base.id !== destination.id) {
      const back = legMetrics(
        rules,
        input.rawDistanceKm(destination, aircraft.base),
        aircraft.cruiseSpeedKmh,
      );
      if (back.distanceKm > free) {
        position.back = back.minutes ?? 0;
        position.backKm = back.distanceKm;
      }
      assumptions.push(
        `Aircraft returns to ${aircraft.base.name} after drop-off`,
      );
    }
  }

  const validityMinutes =
    use(rules.VALIDITY)?.minutes ?? DEFAULT_VALIDITY_MINUTES;
  const validUntil = new Date(input.now.getTime() + validityMinutes * 60_000);

  const unpriced = (reason: string): EngineResult => ({
    priced: false,
    distanceKm: leg.distanceKm,
    flightMinutes: leg.minutes,
    positioningMinutes: position.out,
    repositioningMinutes: position.back,
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
  });

  const rate = use(rules.HOURLY_RATE);
  if (!rate) return unpriced('No hourly rate is set for this aircraft.');
  if (rate.currency !== 'INR') {
    return unpriced('The hourly rate is not in INR.');
  }
  if (leg.minutes == null) {
    return unpriced('The aircraft has no cruise speed recorded.');
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
  breakdown.push({
    code: 'OPERATING',
    label: 'Flight operating cost',
    amountMinor: Math.round(billable * hourlyMinor),
    basis:
      billable > hours
        ? `${minimum} h minimum billable × hourly rate`
        : `${hours.toFixed(2)} h × hourly rate`,
  });

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

  // Landing at the destination; handling at both ends.
  const landingAt = chargeAt(destination, aircraft.category);
  const fallbackLanding = rules.LANDING?.config;
  const landing = landingAt?.landingMinor ?? fallbackLanding?.amountMinor;
  if (landingAt == null && fallbackLanding) used.push(rules.LANDING!.rule);
  if (landing == null) {
    warnings.push(`Landing charges at ${destination.name} are not on record.`);
    exclusions.push(`Landing charges at ${destination.name}`);
  }
  let handling = 0;
  let handlingKnown = true;
  for (const point of [origin, destination]) {
    const at = chargeAt(point, aircraft.category);
    const amount = at?.handlingMinor ?? rules.HANDLING?.config.amountMinor;
    if (at == null && rules.HANDLING) used.push(rules.HANDLING.rule);
    if (amount == null) {
      handlingKnown = false;
      exclusions.push(`Handling at ${point.name}`);
    } else handling += amount;
  }
  if (!handlingKnown) warnings.push('Some handling charges are not on record.');
  const landingHandling = (landing ?? 0) + handling;
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
    priced: true,
    distanceKm: leg.distanceKm,
    flightMinutes: leg.minutes,
    positioningMinutes: position.out,
    repositioningMinutes: position.back,
    breakdown,
    baseMinor,
    feesMinor,
    taxMinor,
    discountMinor: 0,
    totalMinor: baseMinor + feesMinor + taxMinor,
    operatorPayableMinor:
      commission?.mode === 'DEDUCTED' ? baseMinor - commissionMinor : baseMinor,
    platformRevenueMinor: commissionMinor,
    currency: 'INR',
    validUntil,
    appliedRules: applied(used),
    assumptions,
    exclusions,
    warnings,
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
