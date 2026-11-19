/**
 * Scheduled airline inventory (high-level-design.md, integrations;
 * open-decisions.md decision 2). The supplier is not chosen, so the rest of
 * the API depends on this interface only. A real supplier is one adapter
 * class plus one `AIRLINE_PROVIDER` value (see airline.module.ts).
 *
 * Money is an integer in paise with an ISO 4217 code. Every fare returned
 * here is a `LIVE_FARE`: it is the supplier's price now, and must be
 * revalidated before the customer pays (rule 3).
 */
export type CabinClass = 'ECONOMY' | 'PREMIUM_ECONOMY' | 'BUSINESS';
export type FareFamily = 'SAVER' | 'FLEXI';

export interface FareSearchQuery {
  /** IATA codes. */
  origin: string;
  destination: string;
  /** Local departure date, `YYYY-MM-DD`. */
  departDate: string;
  /** Set for a return trip. */
  returnDate?: string;
  /** 1 to 9. */
  adults: number;
  /** Seated, priced like adults by most carriers. Adults plus children at most 9. */
  children?: number;
  /** On an adult's lap; at most one per adult. */
  infants?: number;
  /** Economy when left out. */
  cabin?: CabinClass;
}

/** Who travels, for revalidation. */
export type PartySize = Pick<
  FareSearchQuery,
  'adults' | 'children' | 'infants'
>;

export interface BaggageAllowance {
  cabinKg: number;
  checkedKg: number;
}

export interface FareOffer {
  /** Opaque. Pass it back to `revalidate` and `getFareRules` unchanged. */
  offerId: string;
  carrierCode: string;
  carrierName: string;
  flightNumber: string;
  origin: string;
  destination: string;
  /** UTC instants, ISO 8601. */
  departureAt: string;
  arrivalAt: string;
  /** IANA zones, for showing airport-local times. */
  originTimeZone: string;
  destinationTimeZone: string;
  durationMinutes: number;
  stops: number;
  cabin: CabinClass;
  fareFamily: FareFamily;
  baggage: BaggageAllowance;
  refundable: boolean;
  seatsLeft: number;
  /** Per adult (and per child). */
  fareMinor: number;
  /** For the whole party in the query: adults, children and infants. */
  totalMinor: number;
  currency: 'INR';
  priceType: 'LIVE_FARE';
}

export interface FareSearchResult {
  outbound: FareOffer[];
  /** Null for a one-way search. */
  inbound: FareOffer[] | null;
}

export type RevalidationStatus = 'AVAILABLE' | 'PRICE_CHANGED' | 'SOLD_OUT';

export interface RevalidationResult {
  status: RevalidationStatus;
  /** The current offer. Null when sold out. */
  offer: FareOffer | null;
  /** The total the customer was shown, and the total now. */
  previousTotalMinor: number;
  currentTotalMinor: number | null;
  currency: 'INR';
}

export interface FareRules {
  offerId: string;
  refundable: boolean;
  /** Fees in paise per adult; null where the fare does not allow it. */
  cancellationFeeMinor: number | null;
  changeFeeMinor: number | null;
  /** Hours before departure after which the fare cannot be cancelled. */
  cancellationCutoffHours: number;
  baggage: BaggageAllowance;
  /** Plain-language conditions to show before the customer commits (rule 9). */
  conditions: { title: string; text: string }[];
}

export type AirlineErrorCode = 'INVALID_QUERY' | 'INVALID_OFFER';

/** Mapped to our error codes by callers; never passed to a client as is. */
export class AirlineProviderError extends Error {
  constructor(
    readonly code: AirlineErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'AirlineProviderError';
  }
}

export abstract class AirlineInventoryProvider {
  abstract searchFares(query: FareSearchQuery): Promise<FareSearchResult>;
  /**
   * Rechecks availability and price of an offer for the party.
   * `previousTotalMinor` is the total the customer saw.
   */
  abstract revalidate(
    offerId: string,
    party: PartySize,
    previousTotalMinor: number,
  ): Promise<RevalidationResult>;
  abstract getFareRules(offerId: string): Promise<FareRules>;
}

/** One configured supplier, by the name shown in search results. */
export interface NamedAirlineProvider {
  name: string;
  provider: AirlineInventoryProvider;
}

/**
 * Every configured supplier. Scheduled search calls them all in parallel,
 * each with its own timeout (AIRLINE_TIMEOUT_MS). Today: one.
 */
export const AIRLINE_PROVIDERS = Symbol('AIRLINE_PROVIDERS');
