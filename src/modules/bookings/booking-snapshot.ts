import type { PassengerRecord } from '../customers/customers.service.js';
import type { Revalidation } from '../search/search.service.js';
import {
  type CancellationTerms,
  type Itinerary,
  parseCancellationTerms,
  parseItinerary,
} from './booking-json.js';

/**
 * What a booking copies when the customer commits: the trip, the terms they
 * were shown and their passengers. Pure, so each is unit tested.
 */

/** How long a new booking holds the aircraft while the operator answers. */
export const BOOKING_HOLD_HOURS = 24;

/** The hold's lapse: a day from now, or when the trip ends if sooner. */
export function holdExpiry(now: Date, endsAt: Date): Date {
  const lapse = now.getTime() + BOOKING_HOLD_HOURS * 3_600_000;
  return new Date(Math.min(lapse, endsAt.getTime()));
}

export type RevalidationOutcome =
  | { kind: 'unavailable' }
  | { kind: 'priceOnRequest' }
  | {
      kind: 'priceChanged';
      totalMinor: number;
      currency: string;
      validUntil: Date;
    }
  | { kind: 'ok' };

/**
 * Whether a booking may be made from a result checked again (rule 3): the
 * aircraft can still fly the trip, it is priced, and the price is the one
 * the customer agreed to.
 */
export function revalidationOutcome(
  current: Revalidation['current'],
  expected: { totalMinor: number; currency: string },
): RevalidationOutcome {
  if (!current) return { kind: 'unavailable' };
  if (!current.priced) return { kind: 'priceOnRequest' };
  if (
    current.totalMinor !== expected.totalMinor ||
    current.currency !== expected.currency
  ) {
    return {
      kind: 'priceChanged',
      totalMinor: current.totalMinor,
      currency: current.currency,
      validUntil: current.validUntil,
    };
  }
  return { kind: 'ok' };
}

/** The trip as the search offered it, checked against the written shape. */
export function itineraryFrom(revalidation: Revalidation): Itinerary {
  const { result } = revalidation;
  return parseItinerary({
    version: 1,
    source: 'SEARCH',
    searchId: revalidation.searchId,
    resultId: revalidation.resultId,
    tripType: result.tripType,
    passengerCount: revalidation.passengerCount,
    legs: revalidation.legs.map((leg) => ({
      originId: leg.originId,
      originName: leg.originName,
      destinationId: leg.destinationId,
      destinationName: leg.destinationName,
      departureAt: leg.departureAt,
    })),
    roundTripStrategy: result.roundTripStrategy,
    aircraft: {
      id: result.aircraft.id,
      manufacturer: result.aircraft.manufacturer,
      model: result.aircraft.model,
      category: result.aircraft.category,
      passengerCapacity: result.aircraft.passengerCapacity,
    },
    operatorName: result.operatorName,
    distanceKm: result.distanceKm,
    flightMinutes: result.flightMinutes,
  });
}

/**
 * The terms a request from a search result is made on: the note the result
 * showed (`CANCELLATION_NOTE`), word for word, and no charges, since nothing
 * is paid before the operator's quote, which brings its own conditions.
 */
export function requestTerms(
  note: string,
  acceptedAt: Date,
): CancellationTerms {
  return parseCancellationTerms({
    version: 1,
    source: 'PLATFORM',
    summary: note,
    charges: [],
    acceptedAt: acceptedAt.toISOString(),
  });
}

/** A saved passenger as the booking keeps it; sensitive fields encrypted. */
export function passengerSnapshot(
  passenger: PassengerRecord,
  encrypt: (plain: string) => string,
) {
  return {
    passengerId: passenger.id,
    firstName: passenger.firstName,
    lastName: passenger.lastName,
    dateOfBirth: passenger.dateOfBirth,
    gender: passenger.gender,
    nationality: passenger.nationality,
    documentType: passenger.documentType,
    documentNumber:
      passenger.documentNumber === null
        ? null
        : encrypt(passenger.documentNumber),
    documentExpiry: passenger.documentExpiry,
    specialAssistance:
      passenger.specialAssistance === null
        ? null
        : encrypt(passenger.specialAssistance),
  };
}

/** The last four characters of a document number, for display. */
export function lastFour(documentNumber: string | null): string | null {
  return documentNumber === null ? null : documentNumber.slice(-4);
}
