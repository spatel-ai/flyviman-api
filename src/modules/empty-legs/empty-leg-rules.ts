import {
  BookingStatus,
  EmptyLegPricingBasis,
  EmptyLegStatus,
  PriceType,
  Role,
} from '../../generated/prisma/enums.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest departure window an offer may give. */
export const MAX_WINDOW_DAYS = 14;
/** How far ahead an offer may depart. */
export const MAX_DAYS_AHEAD = 365;
/** Highest price, ₹10 crore in paise, as for operator pricing inputs. */
export const MAX_PRICE_MINOR = 1_000_000_000;

export type EmptyLegAction =
  'publish' | 'approve' | 'reject' | 'withdraw' | 'expire' | 'book';

/** `null` is the system: the expiry job. */
type Actor = Role | null;

interface Transition {
  from: EmptyLegStatus[];
  actors: Actor[];
  reasonRequired: boolean;
}

const OPERATOR = [Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF];
const REVIEWERS = [Role.OPS, Role.SUPER_ADMIN];
const OPEN = [
  EmptyLegStatus.DRAFT,
  EmptyLegStatus.PENDING_REVIEW,
  EmptyLegStatus.PUBLISHED,
];

/** The empty-leg state machine from docs/architecture/state-machines.md. */
const TRANSITIONS: Record<EmptyLegAction, Transition> = {
  publish: {
    from: [EmptyLegStatus.DRAFT],
    actors: OPERATOR,
    reasonRequired: false,
  },
  approve: {
    from: [EmptyLegStatus.PENDING_REVIEW],
    actors: REVIEWERS,
    reasonRequired: false,
  },
  /** Back to the operator's draft, with the reason as the review note. */
  reject: {
    from: [EmptyLegStatus.PENDING_REVIEW],
    actors: REVIEWERS,
    reasonRequired: true,
  },
  withdraw: { from: OPEN, actors: OPERATOR, reasonRequired: false },
  expire: { from: OPEN, actors: [null], reasonRequired: false },
  /**
   * A booking of the offer was confirmed (M8-C). From `EXPIRED` too: the
   * expiry job may close an offer while its booking request is answered.
   */
  book: {
    from: [EmptyLegStatus.PUBLISHED, EmptyLegStatus.EXPIRED],
    actors: [null],
    reasonRequired: false,
  },
};

export type TransitionRefusal = 'role' | 'state' | 'reason';

/**
 * The status an action leads to, or why it is not allowed. Publishing goes
 * to review first when `reviewRequired` (EMPTY_LEG_REVIEW_REQUIRED).
 */
export function nextEmptyLegStatus(
  action: EmptyLegAction,
  current: EmptyLegStatus,
  actor: Actor,
  options: { reviewRequired?: boolean; reason?: string } = {},
): { to: EmptyLegStatus } | { refused: TransitionRefusal } {
  const transition = TRANSITIONS[action];
  if (!transition.actors.includes(actor)) return { refused: 'role' };
  if (!transition.from.includes(current)) return { refused: 'state' };
  if (transition.reasonRequired && !options.reason?.trim()) {
    return { refused: 'reason' };
  }
  switch (action) {
    case 'publish':
      return {
        to: options.reviewRequired
          ? EmptyLegStatus.PENDING_REVIEW
          : EmptyLegStatus.PUBLISHED,
      };
    case 'approve':
      return { to: EmptyLegStatus.PUBLISHED };
    case 'reject':
      return { to: EmptyLegStatus.DRAFT };
    case 'withdraw':
      return { to: EmptyLegStatus.WITHDRAWN };
    case 'expire':
      return { to: EmptyLegStatus.EXPIRED };
    case 'book':
      return { to: EmptyLegStatus.BOOKED };
  }
}

/**
 * Booking statuses that end a booking and free its offer again. Every other
 * status is a live booking, of which an offer has at most one (the partial
 * unique index `Booking_one_live_per_empty_leg` lists the same four).
 */
export const BOOKING_ENDED: BookingStatus[] = [
  BookingStatus.OPERATOR_UNAVAILABLE,
  BookingStatus.QUOTE_DECLINED,
  BookingStatus.EXPIRED,
  BookingStatus.CANCELLED,
];

/** Statuses an operator may edit in. */
export const EDITABLE: EmptyLegStatus[] = [
  EmptyLegStatus.DRAFT,
  EmptyLegStatus.PUBLISHED,
];

/** Statuses an operator may withdraw from. */
export const WITHDRAWABLE: EmptyLegStatus[] = OPEN;

/**
 * The status after an edit: a published offer goes back to review when
 * review is required, as an approved aircraft does after a material edit.
 */
export function statusAfterEdit(
  current: EmptyLegStatus,
  reviewRequired: boolean,
): EmptyLegStatus {
  return current === EmptyLegStatus.PUBLISHED && reviewRequired
    ? EmptyLegStatus.PENDING_REVIEW
    : current;
}

/**
 * An operator's own price is a quote; a platform calculation would be an
 * estimate (pricing-engine.md). Never `CONFIRMED`: that is a booking's price.
 */
export function priceTypeOf(basis: EmptyLegPricingBasis): PriceType {
  return basis === EmptyLegPricingBasis.OPERATOR_PRICE
    ? PriceType.QUOTE
    : PriceType.ESTIMATE;
}

/** The offer as the rules see it. */
export interface OfferTerms {
  aircraftId: string;
  originId: string;
  destinationId: string;
  departureWindowStart: Date;
  departureWindowEnd: Date;
  passengerCapacity: number;
  priceMinor: bigint;
  expiresAt: Date;
  bookingConditions: string;
}

/** Fixed once an offer has been published: withdraw it and offer another. */
export const LOCKED_WHEN_PUBLISHED = [
  'aircraftId',
  'originId',
  'destinationId',
] as const;

/** What a customer would want to hear about when it changes. */
export const MATERIAL_FIELDS = [
  'departureWindowStart',
  'departureWindowEnd',
  'passengerCapacity',
  'priceMinor',
  'expiresAt',
  'bookingConditions',
] as const;

function same(a: unknown, b: unknown): boolean {
  return a instanceof Date && b instanceof Date
    ? a.getTime() === b.getTime()
    : a === b;
}

/** The fields whose value differs between two versions of an offer. */
export function changedFields(
  before: OfferTerms,
  after: OfferTerms,
  fields: readonly (keyof OfferTerms)[],
): (keyof OfferTerms)[] {
  return fields.filter((field) => !same(before[field], after[field]));
}

export interface TermsIssue {
  field: string;
  issue: string;
}

/**
 * What is wrong with an offer's terms, in API field names. Empty means
 * valid. `aircraftSeats` is the aircraft's passenger capacity.
 */
export function termsIssues(
  terms: OfferTerms,
  aircraftSeats: number,
  now: Date,
): TermsIssue[] {
  const issues: TermsIssue[] = [];
  const start = terms.departureWindowStart.getTime();
  const end = terms.departureWindowEnd.getTime();
  if (terms.originId === terms.destinationId) {
    issues.push({ field: 'destinationId', issue: 'must differ from originId' });
  }
  if (end <= start) {
    issues.push({ field: 'departureTo', issue: 'must be after departureFrom' });
  } else if (end - start > MAX_WINDOW_DAYS * DAY_MS) {
    issues.push({
      field: 'departureTo',
      issue: `must be within ${MAX_WINDOW_DAYS} days of departureFrom`,
    });
  }
  if (end <= now.getTime()) {
    issues.push({ field: 'departureTo', issue: 'must be in the future' });
  }
  if (start > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) {
    issues.push({
      field: 'departureFrom',
      issue: `must be within ${MAX_DAYS_AHEAD} days`,
    });
  }
  if (terms.expiresAt.getTime() <= now.getTime()) {
    issues.push({ field: 'validUntil', issue: 'must be in the future' });
  }
  if (terms.expiresAt.getTime() > end) {
    issues.push({
      field: 'validUntil',
      issue: 'must not be after departureTo',
    });
  }
  if (terms.passengerCapacity > aircraftSeats) {
    issues.push({
      field: 'seatsAvailable',
      issue: `must not exceed the aircraft's ${aircraftSeats} seats`,
    });
  }
  return issues;
}

// --- Alternatives in charter search results (M7) ---------------------------

/** How far either side of the requested departure an alternative may leave. */
export const ALTERNATIVE_WINDOW_DAYS = 2;
/** How far an alternative's origin or destination may be from the request. */
export const ALTERNATIVE_NEARBY_KM = 100;
/** Most alternatives a search response carries. */
export const ALTERNATIVE_LIMIT = 5;

interface Point {
  id: string;
  latitude: number;
  longitude: number;
}

/** Great-circle distance in kilometres. */
export function greatCircleKm(a: Point, b: Point): number {
  const rad = (deg: number) => (deg * Math.PI) / 180;
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 12_742 * Math.asin(Math.sqrt(h));
}

/** The same place, or within `ALTERNATIVE_NEARBY_KM` of it. */
export function isNearby(a: Point, b: Point): boolean {
  return a.id === b.id || greatCircleKm(a, b) <= ALTERNATIVE_NEARBY_KM;
}

export interface AlternativeCandidate {
  origin: Point;
  destination: Point;
  departureWindowStart: Date;
  departureWindowEnd: Date;
  passengerCapacity: number;
}

/**
 * Candidates that fit the request: origin and destination each the same or
 * nearby, a departure window that comes within `ALTERNATIVE_WINDOW_DAYS` of
 * the requested time, and enough seats. Exact routes first, then the
 * closest departure; at most `ALTERNATIVE_LIMIT`.
 */
export function pickAlternatives<T extends AlternativeCandidate>(
  candidates: T[],
  request: {
    origin: Point;
    destination: Point;
    departureAt: Date;
    passengers: number;
  },
): T[] {
  const span = ALTERNATIVE_WINDOW_DAYS * DAY_MS;
  const at = request.departureAt.getTime();
  const gap = (c: T) =>
    Math.max(
      c.departureWindowStart.getTime() - at,
      at - c.departureWindowEnd.getTime(),
      0,
    );
  const exact = (c: T) =>
    c.origin.id === request.origin.id &&
    c.destination.id === request.destination.id;
  return candidates
    .filter(
      (c) =>
        c.passengerCapacity >= request.passengers &&
        gap(c) <= span &&
        isNearby(c.origin, request.origin) &&
        isNearby(c.destination, request.destination),
    )
    .sort(
      (a, b) =>
        Number(exact(b)) - Number(exact(a)) ||
        gap(a) - gap(b) ||
        a.departureWindowStart.getTime() - b.departureWindowStart.getTime(),
    )
    .slice(0, ALTERNATIVE_LIMIT);
}
