/**
 * The shape of the `restrictions` JSON column, shared by an aircraft and its
 * operator (D-104): `aircraft` and `operators` store it, `matching` applies
 * both. Kept here, free of any module, so none of them imports another's
 * internals. Writes are validated by `restrictions.dto.ts`; reads go through
 * `parseRestrictions`, which keeps only well-formed known fields.
 */

export const RESTRICTION_LIMITS = {
  /** A week: longer notice is a booking policy, not an aircraft limit. */
  maxNoticeMinutes: 10_080,
  maxExcludedLocations: 100,
} as const;

/** 24-hour local time, `HH:MM`. */
export const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AircraftRestrictions {
  /**
   * When the aircraft may depart and arrive, in the local time of each
   * location (every location has an IANA time zone). An `end` before
   * `start` spans midnight.
   */
  operatingHours?: { start: string; end: string };
  /** Locations the aircraft does not fly to or from. */
  excludedLocationIds?: string[];
  /** Notice the operator needs before departure, beyond the platform's. */
  minimumNoticeMinutes?: number;
}

export function parseRestrictions(raw: unknown): AircraftRestrictions | null {
  const source = jsonRecord(raw);
  if (!source) return null;
  const result: AircraftRestrictions = {};
  const hours = jsonRecord(source.operatingHours);
  if (
    hours &&
    isLocalTime(hours.start) &&
    isLocalTime(hours.end) &&
    hours.start !== hours.end
  ) {
    result.operatingHours = { start: hours.start, end: hours.end };
  }
  if (Array.isArray(source.excludedLocationIds)) {
    result.excludedLocationIds = [
      ...new Set(
        source.excludedLocationIds.filter(
          (id): id is string => typeof id === 'string' && UUID.test(id),
        ),
      ),
    ].slice(0, RESTRICTION_LIMITS.maxExcludedLocations);
  }
  if (
    isIntIn(source.minimumNoticeMinutes, 0, RESTRICTION_LIMITS.maxNoticeMinutes)
  ) {
    result.minimumNoticeMinutes = source.minimumNoticeMinutes;
  }
  return result;
}

/** A JSON object, or `null` for anything else (arrays included). */
export function jsonRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** An integer from `min` to `max`, inclusive. */
export function isIntIn(
  value: unknown,
  min: number,
  max: number,
): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

function isLocalTime(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_TIME.test(value);
}
