import { AircraftCategory } from '../../generated/prisma/enums.js';

/**
 * The written shapes of `Booking.itinerary` and `Booking.cancellationTerms`
 * (jsonb). Both are snapshots taken when the customer commits and never
 * edited afterwards; `version` lets a later shape sit beside this one.
 * `parseItinerary` and `parseCancellationTerms` check a value strictly
 * (unknown keys refused) before it is written and when it is read.
 */

export interface ItineraryLeg {
  originId: string;
  originName: string;
  destinationId: string;
  destinationName: string;
  /** ISO 8601 UTC. */
  departureAt: string;
}

/** The empty-leg offer an `EMPTY_LEG` booking was made from (M8-C). */
export interface ItineraryEmptyLeg {
  id: string;
  reference: string;
  /**
   * The end of the offer's departure window, ISO 8601 UTC. The leg's
   * `departureAt` is the window's start; the operator confirms the time.
   */
  departureTo: string;
  /** The offer's conditions as the customer was shown them (rule 9). */
  conditions: string;
}

export interface Itinerary {
  version: 1;
  /** Where the booking came from: a search result or an empty-leg offer. */
  source: 'SEARCH' | 'EMPTY_LEG';
  /** Null for an empty-leg booking. */
  searchId: string | null;
  /** Null for an empty-leg booking. */
  resultId: string | null;
  tripType: 'ONE_WAY' | 'ROUND_TRIP';
  passengerCount: number;
  /** One leg, or the outbound and the return for a round trip. */
  legs: ItineraryLeg[];
  roundTripStrategy: 'WAIT' | 'RETURN_TO_BASE' | null;
  aircraft: {
    id: string;
    manufacturer: string;
    model: string;
    category: AircraftCategory;
    passengerCapacity: number;
  };
  operatorName: string;
  /** Kilometres flown for the customer, out and back for a round trip. */
  distanceKm: number;
  /** Whole minutes; null when unknown. */
  flightMinutes: number | null;
  /**
   * The offer, for an `EMPTY_LEG` booking; null (or left out, in rows
   * written before M8-C) for a search booking.
   */
  emptyLeg: ItineraryEmptyLeg | null;
}

export interface CancellationCharge {
  /** Applies when cancelling at least this many hours before departure. */
  minHoursBeforeDeparture: number;
  /** Of the total price, 0 to 100. */
  chargePercent: number;
}

export interface CancellationTerms {
  version: 1;
  /** `PLATFORM`: the note shown with a search result, before any quote. */
  source: 'PLATFORM' | 'OPERATOR_QUOTE';
  /** The text the customer was shown, word for word (rule 9). */
  summary: string;
  /**
   * Charges by notice, the longest notice first. Empty when nothing can be
   * charged yet: before the operator's quote is accepted, nothing is paid.
   */
  charges: CancellationCharge[];
  /** When the customer committed to these terms, ISO 8601 UTC. */
  acceptedAt: string;
}

/** A stored value that does not have the written shape. */
export class BookingJsonError extends Error {
  constructor(what: string, issue: string) {
    super(`${what}: ${issue}`);
    this.name = 'BookingJsonError';
  }
}

type Json = Record<string, unknown>;

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `optional` keys may be left out; every other key in `keys` must be there. */
function object(
  value: unknown,
  what: string,
  keys: readonly string[],
  optional: readonly string[] = [],
): Json {
  if (!isObject(value)) {
    throw new BookingJsonError(what, 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key) && !optional.includes(key)) {
      throw new BookingJsonError(what, `unknown key ${key}`);
    }
  }
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) {
      throw new BookingJsonError(what, `${key} is missing`);
    }
  }
  return value as Json;
}

function text(value: unknown, what: string, max = 200): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) {
    throw new BookingJsonError(what, `must be text of 1 to ${max} characters`);
  }
  return value;
}

function whole(value: unknown, what: string, min: number, max: number) {
  if (!Number.isInteger(value) || (value as number) < min) {
    throw new BookingJsonError(what, `must be a whole number from ${min}`);
  }
  if ((value as number) > max) {
    throw new BookingJsonError(what, `must be at most ${max}`);
  }
  return value as number;
}

function instant(value: unknown, what: string): string {
  if (
    typeof value !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/.test(value) ||
    Number.isNaN(Date.parse(value))
  ) {
    throw new BookingJsonError(what, 'must be an ISO 8601 UTC time');
  }
  return value;
}

function oneOf<T extends string>(
  value: unknown,
  what: string,
  allowed: readonly T[],
): T {
  if (!allowed.includes(value as T)) {
    throw new BookingJsonError(what, `must be one of ${allowed.join(', ')}`);
  }
  return value as T;
}

const LEG_KEYS = [
  'originId',
  'originName',
  'destinationId',
  'destinationName',
  'departureAt',
] as const;

const ITINERARY_KEYS = [
  'version',
  'source',
  'searchId',
  'resultId',
  'tripType',
  'passengerCount',
  'legs',
  'roundTripStrategy',
  'aircraft',
  'operatorName',
  'distanceKm',
  'flightMinutes',
] as const;

const EMPTY_LEG_KEYS = [
  'id',
  'reference',
  'departureTo',
  'conditions',
] as const;

const AIRCRAFT_KEYS = [
  'id',
  'manufacturer',
  'model',
  'category',
  'passengerCapacity',
] as const;

function nothing(value: unknown, what: string): null {
  if (value !== null) throw new BookingJsonError(what, 'must be null');
  return null;
}

function emptyLegOf(value: unknown): ItineraryEmptyLeg {
  const raw = object(value, 'emptyLeg', EMPTY_LEG_KEYS);
  return {
    id: text(raw.id, 'emptyLeg.id', 36),
    reference: text(raw.reference, 'emptyLeg.reference', 32),
    departureTo: instant(raw.departureTo, 'emptyLeg.departureTo'),
    conditions: text(raw.conditions, 'emptyLeg.conditions', 2000),
  };
}

export function parseItinerary(value: unknown): Itinerary {
  // A search itinerary may leave `emptyLeg` out (rows from before M8-C);
  // an empty-leg itinerary must carry it, and no search or result.
  const fromEmptyLeg = isObject(value) && value.source === 'EMPTY_LEG';
  const raw = fromEmptyLeg
    ? object(value, 'itinerary', [...ITINERARY_KEYS, 'emptyLeg'])
    : object(value, 'itinerary', ITINERARY_KEYS, ['emptyLeg']);
  if (raw.version !== 1) throw new BookingJsonError('itinerary', 'version 1');
  const tripType = oneOf(raw.tripType, 'tripType', [
    'ONE_WAY',
    'ROUND_TRIP',
  ] as const);
  if (!Array.isArray(raw.legs)) {
    throw new BookingJsonError('legs', 'must be a list');
  }
  if (raw.legs.length !== (tripType === 'ROUND_TRIP' ? 2 : 1)) {
    throw new BookingJsonError('legs', `wrong number for ${tripType}`);
  }
  const legs = raw.legs.map((entry: unknown) => {
    const leg = object(entry, 'leg', LEG_KEYS);
    return {
      originId: text(leg.originId, 'originId', 36),
      originName: text(leg.originName, 'originName'),
      destinationId: text(leg.destinationId, 'destinationId', 36),
      destinationName: text(leg.destinationName, 'destinationName'),
      departureAt: instant(leg.departureAt, 'departureAt'),
    };
  });
  const aircraft = object(raw.aircraft, 'aircraft', AIRCRAFT_KEYS);
  return {
    version: 1,
    source: fromEmptyLeg
      ? 'EMPTY_LEG'
      : oneOf(raw.source, 'source', ['SEARCH'] as const),
    searchId: fromEmptyLeg
      ? nothing(raw.searchId, 'searchId')
      : text(raw.searchId, 'searchId', 36),
    resultId: fromEmptyLeg
      ? nothing(raw.resultId, 'resultId')
      : text(raw.resultId, 'resultId', 36),
    tripType,
    passengerCount: whole(raw.passengerCount, 'passengerCount', 1, 1000),
    legs,
    roundTripStrategy:
      raw.roundTripStrategy === null
        ? null
        : oneOf(raw.roundTripStrategy, 'roundTripStrategy', [
            'WAIT',
            'RETURN_TO_BASE',
          ] as const),
    aircraft: {
      id: text(aircraft.id, 'aircraft.id', 36),
      manufacturer: text(aircraft.manufacturer, 'aircraft.manufacturer'),
      model: text(aircraft.model, 'aircraft.model'),
      category: oneOf(
        aircraft.category,
        'aircraft.category',
        Object.values(AircraftCategory),
      ),
      passengerCapacity: whole(
        aircraft.passengerCapacity,
        'aircraft.passengerCapacity',
        1,
        1000,
      ),
    },
    operatorName: text(raw.operatorName, 'operatorName'),
    distanceKm: whole(raw.distanceKm, 'distanceKm', 0, 100_000),
    flightMinutes:
      raw.flightMinutes === null
        ? null
        : whole(raw.flightMinutes, 'flightMinutes', 0, 100_000),
    emptyLeg: fromEmptyLeg
      ? emptyLegOf(raw.emptyLeg)
      : raw.emptyLeg === undefined
        ? null
        : nothing(raw.emptyLeg, 'emptyLeg'),
  };
}

const TERMS_KEYS = [
  'version',
  'source',
  'summary',
  'charges',
  'acceptedAt',
] as const;
const CHARGE_KEYS = ['minHoursBeforeDeparture', 'chargePercent'] as const;

export function parseCancellationTerms(value: unknown): CancellationTerms {
  const raw = object(value, 'cancellationTerms', TERMS_KEYS);
  if (raw.version !== 1) {
    throw new BookingJsonError('cancellationTerms', 'version 1');
  }
  if (!Array.isArray(raw.charges) || raw.charges.length > 10) {
    throw new BookingJsonError('charges', 'must be a list of at most 10');
  }
  const charges = raw.charges.map((entry: unknown) => {
    const charge = object(entry, 'charge', CHARGE_KEYS);
    return {
      minHoursBeforeDeparture: whole(
        charge.minHoursBeforeDeparture,
        'minHoursBeforeDeparture',
        0,
        24 * 365,
      ),
      chargePercent: whole(charge.chargePercent, 'chargePercent', 0, 100),
    };
  });
  for (let i = 1; i < charges.length; i += 1) {
    if (
      charges[i].minHoursBeforeDeparture >=
      charges[i - 1].minHoursBeforeDeparture
    ) {
      throw new BookingJsonError('charges', 'longest notice first, no repeats');
    }
  }
  return {
    version: 1,
    source: oneOf(raw.source, 'source', [
      'PLATFORM',
      'OPERATOR_QUOTE',
    ] as const),
    summary: text(raw.summary, 'summary', 2000),
    charges,
    acceptedAt: instant(raw.acceptedAt, 'acceptedAt'),
  };
}
