import type {
  AircraftCategory,
  LocationType,
  WingType,
} from '../../generated/prisma/enums.js';
import type { AircraftRestrictions } from '../aircraft/aircraft-json.js';
import type { RuleRow } from '../pricing/rules.js';

/**
 * The matching checks that need no database (pricing-engine.md, step 3).
 * Each failed check is returned as a reason code, so operations can see why
 * an aircraft was left out.
 */

/** Range must cover the leg with this margin to spare. */
export const RANGE_RESERVE = 1.1;

/**
 * `listingNotApproved`, `operatorNotApproved`, `notAvailable`, the
 * `missing()` codes (`rangeKm`, `document:<TYPE>`), `location`, `capacity`,
 * `range`, `positioning`, `availability`, `distance`, `excludedLocation`,
 * `runway`, `helicopterApproval`, `landingSite`, `notice`, `operatingHours`,
 * `nightOperations`.
 */
export type ExclusionReason = string;

export function staticChecks(input: {
  passengerCapacity: number;
  passengerCount: number;
  rangeKm: number | null;
  distanceKm: number;
  /** Minutes to fly from where the aircraft is to the origin. */
  positioningMinutes: number;
  departureAt: Date;
  now: Date;
}): ExclusionReason[] {
  const reasons: ExclusionReason[] = [];
  if (input.passengerCapacity < input.passengerCount) reasons.push('capacity');
  if (
    input.rangeKm == null ||
    input.rangeKm < input.distanceKm * RANGE_RESERVE
  ) {
    reasons.push('range');
  }
  const ready = input.now.getTime() + input.positioningMinutes * 60_000;
  if (ready > input.departureAt.getTime()) reasons.push('positioning');
  return reasons;
}

export interface AircraftWindows {
  slots: {
    startsAt: Date;
    endsAt: Date;
    kind: 'OPEN' | 'DEPARTURE_SLOT';
    originId: string | null;
  }[];
  blocks: { startsAt: Date; endsAt: Date }[];
}

/**
 * Whether the operator offers the whole window (an open slot, or a
 * departure slot from this origin) and no block overlaps it.
 */
export function windowFree(
  windows: AircraftWindows | undefined,
  from: Date,
  to: Date,
  originId: string,
): boolean {
  if (!windows) return false;
  const covered = windows.slots.some(
    (slot) =>
      slot.startsAt <= from &&
      slot.endsAt >= to &&
      (slot.kind === 'OPEN' || slot.originId === originId),
  );
  if (!covered) return false;
  return !windows.blocks.some(
    (block) => block.startsAt < to && block.endsAt > from,
  );
}

// --- Location, limits and restrictions (M5 slice 4a) ----------------------

/** A trip end as matching sees it: an active location. */
export interface MatchPoint {
  id: string;
  name: string;
  type: LocationType;
  /** IANA time zone. */
  timeZone: string;
  /** `Location.capabilities`, read with `parseCapabilities`. */
  capabilities: unknown;
}

export interface LocationFacts {
  /** Null where there is no runway or it is unknown. */
  runwayLengthM: number | null;
  /** Null where it is unknown (D-053). */
  nightOperations: boolean | null;
  helicopterApproved: boolean;
}

/** Malformed or missing capabilities read as "unknown" or "not approved". */
export function parseCapabilities(raw: unknown): LocationFacts {
  const source =
    raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const runway = source.runwayLengthM;
  return {
    runwayLengthM:
      Number.isInteger(runway) && (runway as number) > 0
        ? (runway as number)
        : null,
    nightOperations:
      typeof source.nightOperations === 'boolean'
        ? source.nightOperations
        : null,
    helicopterApproved: source.helicopterApproved === true,
  };
}

/**
 * `MATCHING_LIMITS` rule config: Flyviman's limits for all aircraft
 * (platform constraints, criterion 10) or one category (criteria 3 and 6).
 * Every field is optional; a missing one sets no limit.
 */
export interface MatchingLimits {
  minLegKm?: number;
  maxLegKm?: number;
  minRunwayM?: number;
  minimumNoticeMinutes?: number;
  landingSites?: 'ALLOWED' | 'NOT_ALLOWED';
}

const LIMIT_NUMBERS = [
  'minLegKm',
  'maxLegKm',
  'minRunwayM',
  'minimumNoticeMinutes',
] as const;

export function parseMatchingLimits(raw: unknown): MatchingLimits {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const source = raw as Record<string, unknown>;
  const result: MatchingLimits = {};
  for (const key of LIMIT_NUMBERS) {
    const value = source[key];
    if (Number.isInteger(value) && (value as number) >= 0) {
      result[key] = value as number;
    }
  }
  if (
    source.landingSites === 'ALLOWED' ||
    source.landingSites === 'NOT_ALLOWED'
  ) {
    result.landingSites = source.landingSites;
  }
  return result;
}

/**
 * The platform and category `MATCHING_LIMITS` rules for this category,
 * combined so the stricter value of each wins. Operator and aircraft rules
 * of this type are ignored: these are Flyviman's limits.
 */
export function limitsFor(
  rules: RuleRow[],
  category: AircraftCategory,
): MatchingLimits {
  const result: MatchingLimits = {};
  for (const rule of rules) {
    if (rule.type !== 'MATCHING_LIMITS') continue;
    if (
      rule.scope !== 'PLATFORM' &&
      !(rule.scope === 'CATEGORY' && rule.scopeRef === category)
    ) {
      continue;
    }
    const limits = parseMatchingLimits(rule.config);
    for (const key of [
      'minLegKm',
      'minRunwayM',
      'minimumNoticeMinutes',
    ] as const) {
      if (limits[key] !== undefined) {
        result[key] = Math.max(result[key] ?? 0, limits[key]);
      }
    }
    if (limits.maxLegKm !== undefined) {
      result.maxLegKm = Math.min(
        result.maxLegKm ?? Number.MAX_SAFE_INTEGER,
        limits.maxLegKm,
      );
    }
    if (limits.landingSites === 'NOT_ALLOWED')
      result.landingSites = 'NOT_ALLOWED';
    else if (limits.landingSites && !result.landingSites) {
      result.landingSites = limits.landingSites;
    }
  }
  return result;
}

/** Operator and aircraft restrictions together: the stricter wins. */
export interface CombinedRestrictions {
  /** Every window must allow the time. */
  operatingHours: { start: string; end: string }[];
  excludedLocationIds: Set<string>;
  minimumNoticeMinutes: number;
}

export function combineRestrictions(
  ...sources: (AircraftRestrictions | null)[]
): CombinedRestrictions {
  const result: CombinedRestrictions = {
    operatingHours: [],
    excludedLocationIds: new Set(),
    minimumNoticeMinutes: 0,
  };
  for (const source of sources) {
    if (!source) continue;
    if (source.operatingHours)
      result.operatingHours.push(source.operatingHours);
    for (const id of source.excludedLocationIds ?? []) {
      result.excludedLocationIds.add(id);
    }
    result.minimumNoticeMinutes = Math.max(
      result.minimumNoticeMinutes,
      source.minimumNoticeMinutes ?? 0,
    );
  }
  return result;
}

/** Shown to the customer; the operator confirms before accepting. */
export const landingSiteWarning = (name: string) =>
  `Landing at ${name} needs the site's permission. The operator confirms it before accepting.`;
export const nightWarning = (name: string) =>
  `Night operations at ${name} are not confirmed. The operator confirms them before accepting.`;

/**
 * Checks that do not depend on the departure time: excluded locations (7),
 * leg distance (3), runway and helicopter approval at both ends (5),
 * landing sites (6).
 */
export function routeChecks(input: {
  wingType: WingType;
  distanceKm: number;
  origin: MatchPoint;
  destination: MatchPoint;
  limits: MatchingLimits;
  restrictions: CombinedRestrictions;
}): { reasons: ExclusionReason[]; warnings: string[] } {
  const reasons = new Set<ExclusionReason>();
  const warnings: string[] = [];
  const { limits } = input;
  if (
    (limits.minLegKm !== undefined && input.distanceKm < limits.minLegKm) ||
    (limits.maxLegKm !== undefined && input.distanceKm > limits.maxLegKm)
  ) {
    reasons.add('distance');
  }
  for (const end of [input.origin, input.destination]) {
    if (input.restrictions.excludedLocationIds.has(end.id)) {
      reasons.add('excludedLocation');
    }
    const facts = parseCapabilities(end.capabilities);
    if (input.wingType === 'FIXED_WING') {
      // A fixed-wing aircraft needs a runway; a heliport or landing site has none.
      if (end.type === 'HELIPORT' || end.type === 'LANDING_SITE') {
        reasons.add('runway');
      } else if (
        limits.minRunwayM !== undefined &&
        (facts.runwayLengthM == null || facts.runwayLengthM < limits.minRunwayM)
      ) {
        reasons.add('runway');
      }
    } else if (!facts.helicopterApproved) {
      reasons.add('helicopterApproval');
    }
    if (end.type === 'LANDING_SITE') {
      if (limits.landingSites === 'NOT_ALLOWED') reasons.add('landingSite');
      else warnings.push(landingSiteWarning(end.name));
    }
  }
  return { reasons: [...reasons], warnings };
}

/**
 * Local night, when a location's night operations matter. An assumption:
 * there is no sunrise and sunset data, so a fixed window is used.
 */
export const NIGHT = { start: '19:00', end: '06:00' } as const;

/**
 * Checks at a departure time: minimum notice (7, and per category), the
 * operator's and aircraft's operating hours at departure from the origin
 * and arrival at the destination (9), and night operations at both ends (5).
 */
export function timeChecks(input: {
  departureAt: Date;
  arrivalAt: Date;
  now: Date;
  origin: MatchPoint;
  destination: MatchPoint;
  limits: MatchingLimits;
  restrictions: CombinedRestrictions;
}): { reasons: ExclusionReason[]; warnings: string[] } {
  const reasons: ExclusionReason[] = [];
  const warnings: string[] = [];
  const notice = Math.max(
    input.restrictions.minimumNoticeMinutes,
    input.limits.minimumNoticeMinutes ?? 0,
  );
  if (input.departureAt.getTime() < input.now.getTime() + notice * 60_000) {
    reasons.push('notice');
  }
  const ends = [
    { point: input.origin, at: input.departureAt },
    { point: input.destination, at: input.arrivalAt },
  ];
  const local = ends.map((end) => localMinutes(end.at, end.point.timeZone));
  // An unknown time zone cannot be shown to be within hours.
  if (
    input.restrictions.operatingHours.length > 0 &&
    local.some(
      (minutes) =>
        minutes == null ||
        input.restrictions.operatingHours.some(
          (window) => !withinWindow(minutes, window),
        ),
    )
  ) {
    reasons.push('operatingHours');
  }
  let night = false;
  ends.forEach((end, index) => {
    const facts = parseCapabilities(end.point.capabilities);
    if (facts.nightOperations === true) return;
    const minutes = local[index];
    const dark = minutes == null || withinWindow(minutes, NIGHT);
    if (!dark) return;
    if (facts.nightOperations === false) night = true;
    else warnings.push(nightWarning(end.point.name));
  });
  if (night) reasons.push('nightOperations');
  return { reasons, warnings };
}

/** Minutes since local midnight, or null for an unknown time zone. */
export function localMinutes(at: Date, timeZone: string): number | null {
  try {
    const parts = new Intl.DateTimeFormat('en-GB', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
    }).formatToParts(at);
    const hour = Number(parts.find((part) => part.type === 'hour')?.value);
    const minute = Number(parts.find((part) => part.type === 'minute')?.value);
    return Number.isInteger(hour) && Number.isInteger(minute)
      ? hour * 60 + minute
      : null;
  } catch {
    return null;
  }
}

/** `[start, end]` inclusive; an `end` before `start` spans midnight. */
export function withinWindow(
  minutes: number,
  window: { start: string; end: string },
): boolean {
  const start = toMinutes(window.start);
  const end = toMinutes(window.end);
  return start <= end
    ? minutes >= start && minutes <= end
    : minutes >= start || minutes <= end;
}

function toMinutes(time: string): number {
  const [hour, minute] = time.split(':').map(Number);
  return hour * 60 + minute;
}
