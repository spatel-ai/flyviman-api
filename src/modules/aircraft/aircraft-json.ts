import {
  isIntIn as isInt,
  jsonRecord as record,
  RESTRICTION_LIMITS,
} from '../../common/restrictions/restrictions.js';
import { hasHiddenCharacter } from '../../common/validation/text.js';

export {
  parseRestrictions,
  type AircraftRestrictions,
} from '../../common/restrictions/restrictions.js';

/**
 * The shapes of the aircraft JSON columns `restrictions`, `specifications`
 * and `medicalEquipment` (D-104). Writes are validated by the DTOs in
 * `dto/aircraft-json.dto.ts`, which use these limits. Reads go through the
 * `parse…` functions, which keep only well-formed known fields, so a row
 * written before the shapes existed, or changed by hand, never reaches a
 * response or a matching rule malformed (as `parsePermissions` does).
 * `restrictions` is shared with operators, so its shape and parser live in
 * `common/restrictions` and are re-exported here.
 */

export const JSON_LIMITS = {
  ...RESTRICTION_LIMITS,
  maxTextLength: 500,
  maxAmenities: 20,
  maxAmenityLength: 40,
  minYear: 1950,
  maxOxygenLitres: 20_000,
  maxInfusionPumps: 10,
} as const;

/** The newest year of manufacture accepted: next year's models are sold now. */
export function maxYearOfManufacture(now = new Date()): number {
  return now.getUTCFullYear() + 1;
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

function isText(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= max &&
    !hasHiddenCharacter(value, { lineBreaks: true })
  );
}
