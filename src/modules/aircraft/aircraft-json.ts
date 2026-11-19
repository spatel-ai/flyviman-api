import { hasHiddenCharacter } from '../../common/validation/text.js';

/**
 * The shapes of the aircraft JSON columns `restrictions`, `specifications`
 * and `medicalEquipment` (D-104). Writes are validated by the DTOs in
 * `dto/aircraft-json.dto.ts`, which use these limits. Reads go through the
 * `parse…` functions, which keep only well-formed known fields, so a row
 * written before the shapes existed, or changed by hand, never reaches a
 * response or a matching rule malformed (as `parsePermissions` does).
 */

export const JSON_LIMITS = {
  /** A week: longer notice is a booking policy, not an aircraft limit. */
  maxNoticeMinutes: 10_080,
  maxExcludedLocations: 100,
  maxTextLength: 500,
  maxAmenities: 20,
  maxAmenityLength: 40,
  minYear: 1950,
  maxOxygenLitres: 20_000,
  maxInfusionPumps: 10,
} as const;

/** 24-hour local time, `HH:MM`. */
export const LOCAL_TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The newest year of manufacture accepted: next year's models are sold now. */
export function maxYearOfManufacture(now = new Date()): number {
  return now.getUTCFullYear() + 1;
}

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

export interface AircraftSpecifications {
  /** A description of the cabin shown to customers. */
  cabin?: string;
  yearOfManufacture?: number;
  amenities?: string[];
}

export interface AircraftMedicalEquipment {
  stretcher?: boolean;
  oxygen?: { litres: number };
  ventilator?: boolean;
  defibrillator?: boolean;
  patientMonitor?: boolean;
  incubator?: boolean;
  infusionPumps?: number;
  notes?: string;
}

export function parseRestrictions(raw: unknown): AircraftRestrictions | null {
  const source = record(raw);
  if (!source) return null;
  const result: AircraftRestrictions = {};
  const hours = record(source.operatingHours);
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
    ].slice(0, JSON_LIMITS.maxExcludedLocations);
  }
  if (isInt(source.minimumNoticeMinutes, 0, JSON_LIMITS.maxNoticeMinutes)) {
    result.minimumNoticeMinutes = source.minimumNoticeMinutes;
  }
  return result;
}

export function parseSpecifications(
  raw: unknown,
): AircraftSpecifications | null {
  const source = record(raw);
  if (!source) return null;
  const result: AircraftSpecifications = {};
  if (isText(source.cabin, JSON_LIMITS.maxTextLength)) {
    result.cabin = source.cabin;
  }
  if (
    isInt(source.yearOfManufacture, JSON_LIMITS.minYear, maxYearOfManufacture())
  ) {
    result.yearOfManufacture = source.yearOfManufacture;
  }
  if (Array.isArray(source.amenities)) {
    result.amenities = [
      ...new Set(
        source.amenities.filter((item): item is string =>
          isText(item, JSON_LIMITS.maxAmenityLength),
        ),
      ),
    ].slice(0, JSON_LIMITS.maxAmenities);
  }
  return result;
}

export function parseMedicalEquipment(
  raw: unknown,
): AircraftMedicalEquipment | null {
  const source = record(raw);
  if (!source) return null;
  const result: AircraftMedicalEquipment = {};
  for (const key of [
    'stretcher',
    'ventilator',
    'defibrillator',
    'patientMonitor',
    'incubator',
  ] as const) {
    if (typeof source[key] === 'boolean') result[key] = source[key];
  }
  const oxygen = record(source.oxygen);
  if (oxygen && isInt(oxygen.litres, 1, JSON_LIMITS.maxOxygenLitres)) {
    result.oxygen = { litres: oxygen.litres };
  }
  if (isInt(source.infusionPumps, 0, JSON_LIMITS.maxInfusionPumps)) {
    result.infusionPumps = source.infusionPumps;
  }
  if (isText(source.notes, JSON_LIMITS.maxTextLength)) {
    result.notes = source.notes;
  }
  return result;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isLocalTime(value: unknown): value is string {
  return typeof value === 'string' && LOCAL_TIME.test(value);
}

function isInt(value: unknown, min: number, max: number): value is number {
  return (
    Number.isInteger(value) &&
    (value as number) >= min &&
    (value as number) <= max
  );
}

function isText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !hasHiddenCharacter(value, { lineBreaks: true })
  );
}
