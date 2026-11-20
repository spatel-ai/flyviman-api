import { PriceType } from '../../generated/prisma/enums.js';
import type { PassengerRecord } from '../customers/customers.service.js';
import type { Revalidation } from '../search/search.service.js';
import {
  type CancellationCharge,
  type CancellationTerms,
  type Itinerary,
  parseCancellationTerms,
  parseItinerary,
} from './booking-json.js';

/**
 * What a booking copies when the customer commits: the trip, the terms they
 * were shown and their passengers. Pure, so each is unit tested.
 */

/**
 * When a hold lapses: `hours` from now (`BOOKING_HOLD_HOURS`, 48 by
 * default), or when the trip ends if sooner.
 */
export function holdExpiry(now: Date, endsAt: Date, hours: number): Date {
  const lapse = now.getTime() + hours * 3_600_000;
  return new Date(Math.min(lapse, endsAt.getTime()));
}

/**
 * A request made from a result priced on request: it has no price (and no
 * calculation) until the customer accepts the operator's quote. Its stored
 * amount of 0 is never shown: every reader returns `price: null`.
 */
export function isQuoteRequest(booking: {
  priceType: PriceType;
  calculationId: string | null;
}): boolean {
  return (
    booking.priceType === PriceType.ESTIMATE && booking.calculationId === null
  );
}

export type RevalidationOutcome =
  | { kind: 'unavailable' }
  /** Priced on request, and the customer asked for a quote. */
  | { kind: 'quoteRequest' }
  /** Priced on request now, but the customer agreed to an amount. */
  | { kind: 'nowOnRequest' }
  | {
      kind: 'priceChanged';
      totalMinor: number;
      currency: string;
      validUntil: Date;
    }
  | { kind: 'ok' };

/**
 * Whether a booking may be made from a result checked again (rule 3): the
 * aircraft can still fly the trip, and the price is the one the customer
 * agreed to. A result priced on request is requested without an amount
 * (`totalMinor` left out): the operator quotes it. An amount sent for a
 * result now on request, or none for a result now priced, is a change the
 * customer must see first.
 */
export function revalidationOutcome(
  current: Revalidation['current'],
  expected: { totalMinor?: number; currency: string },
): RevalidationOutcome {
  if (!current) return { kind: 'unavailable' };
  if (!current.priced) {
    return expected.totalMinor === undefined
      ? { kind: 'quoteRequest' }
      : { kind: 'nowOnRequest' };
  }
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
 * The terms a request from a search result is made on: Flyviman's tier
 * table in force (D-172), its summary word for word as the result showed it
 * and its tiers as the charges, so a later change to the table never
 * reaches this booking (rule 9). `source` stays `PLATFORM`.
 */
export function requestTerms(
  terms: { summary: string; tiers: CancellationCharge[] },
  acceptedAt: Date,
): CancellationTerms {
  return parseCancellationTerms({
    version: 1,
    source: 'PLATFORM',
    summary: terms.summary,
    charges: terms.tiers.map((tier) => ({
      minHoursBeforeDeparture: tier.minHoursBeforeDeparture,
      chargePercent: tier.chargePercent,
    })),
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

/**
 * The last four characters of a document number, for display. A number of
 * four characters or fewer is fully masked: its last four would be all of it.
 */
export function lastFour(documentNumber: string | null): string | null {
  if (documentNumber === null) return null;
  return documentNumber.length <= 4 ? '••••' : documentNumber.slice(-4);
}
