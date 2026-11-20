import {
  BookingMode,
  BookingStatus,
  PriceType,
  Role,
  ServiceCategory,
} from '../../generated/prisma/enums.js';

/**
 * The booking status machine, exactly as docs/architecture/state-machines.md
 * (Booking) draws it. Pure: no database, so the whole table is unit tested.
 * `BookingsService.transition` applies it, writes the `BookingEvent` and the
 * audit record, and updates the row only if its status is still `from`.
 */

/** Who moves a booking. Operations are `OPS` and `SUPER_ADMIN`. */
export type BookingActor = 'CUSTOMER' | 'OPERATOR' | 'OPERATIONS' | 'SYSTEM';

/** The actor a signed-in role acts as; `null` for roles that never do. */
export function actorFor(role: Role): BookingActor | null {
  switch (role) {
    case Role.CUSTOMER:
      return 'CUSTOMER';
    case Role.OPERATOR_ADMIN:
    case Role.OPERATOR_STAFF:
      return 'OPERATOR';
    case Role.OPS:
    case Role.SUPER_ADMIN:
      return 'OPERATIONS';
    default:
      return null;
  }
}

/** What the conditions in the table are decided on. */
export interface TransitionContext {
  category: ServiceCategory;
  bookingMode: BookingMode;
  priceType: PriceType;
  /** Operator acceptance recorded (`operatorAcceptedAt`). */
  operatorAccepted: boolean;
  /**
   * The payment condition of the booking's payment model is met (M9): Model
   * A full payment, Model B payment after operator confirmation, Model C the
   * deposit. Never enough by itself (rule 2).
   */
  paymentConditionMet: boolean;
  /** A `LIVE_FARE` successfully revalidated just now. */
  liveFareRevalidated: boolean;
  /** For air ambulance: the feasibility checklist is complete. */
  feasibilityComplete: boolean;
  /** For SCHEDULED to COMPLETED: the departure time has passed. */
  departed: boolean;
  /**
   * The operator's quote on the booking (M8): none sent, one `LIVE` (sent,
   * within its validity) or the last one `LAPSED` (past `validUntil`).
   * Unknown is `NONE`.
   */
  quote?: 'NONE' | 'LIVE' | 'LAPSED';
  /** Requested without a price (priced on request): only a quote prices it. */
  priceOnRequest?: boolean;
}

export type TransitionCheck =
  { allowed: true } | { allowed: false; reason: string };

interface Edge {
  from: BookingStatus;
  to: BookingStatus;
  by: readonly BookingActor[];
  /** A reason the move is refused, or `null` when its condition holds. */
  unless?: (context: TransitionContext, actor: BookingActor) => string | null;
}

const S = BookingStatus;

/** Statuses a booking can still be cancelled from ("any before COMPLETED"). */
export const CANCELLABLE: readonly BookingStatus[] = [
  S.REQUESTED,
  S.OPERATOR_PENDING,
  S.CLARIFICATION_REQUESTED,
  S.PRICE_CONFIRMED,
  S.AWAITING_PAYMENT,
  S.CONFIRMED,
  S.SCHEDULED,
];

/** A price the customer can pay without an operator setting it first. */
function priceIsConfirmed(context: TransitionContext): boolean {
  return (
    context.priceType === PriceType.CONFIRMED ||
    (context.priceType === PriceType.LIVE_FARE && context.liveFareRevalidated)
  );
}

/** Air ambulance is never instantly bookable (rule 7). */
function instant(context: TransitionContext): boolean {
  return (
    context.bookingMode === BookingMode.INSTANT &&
    context.category !== ServiceCategory.AIR_AMBULANCE
  );
}

/**
 * The confirmation rule (state-machines.md, Confirmation rule). Conditions 4
 * and 5 (supplier reservation, helicopter landing permission) are recorded
 * with operator acceptance or the supplier's answer, which M8 and M6 add.
 */
function confirmationBlocker(context: TransitionContext): string | null {
  const airAmbulance = context.category === ServiceCategory.AIR_AMBULANCE;
  if (airAmbulance) {
    if (!context.operatorAccepted) return 'the operator has not accepted';
    if (!context.feasibilityComplete) {
      return 'the feasibility checklist is not complete';
    }
  } else if (!context.operatorAccepted && !instant(context)) {
    return 'the operator has not accepted';
  }
  if (!priceIsConfirmed(context)) return 'the price is not confirmed';
  if (!context.paymentConditionMet) return 'the payment condition is not met';
  return null;
}

/** Every allowed move except cancellation and the manual override. */
export const EDGES: readonly Edge[] = [
  {
    from: S.REQUESTED,
    to: S.OPERATOR_PENDING,
    by: ['SYSTEM'],
    // An estimate always needs the operator's price, whatever the mode.
    unless: (c) =>
      instant(c) && priceIsConfirmed(c)
        ? 'the booking is instant with a confirmed price'
        : null,
  },
  {
    from: S.REQUESTED,
    to: S.AWAITING_PAYMENT,
    by: ['SYSTEM'],
    unless: (c) => {
      if (c.category === ServiceCategory.AIR_AMBULANCE) {
        return 'air ambulance is never instant';
      }
      if (c.bookingMode !== BookingMode.INSTANT) {
        return 'the booking mode is not instant';
      }
      return priceIsConfirmed(c) ? null : 'the price is not confirmed';
    },
  },
  {
    from: S.OPERATOR_PENDING,
    to: S.CLARIFICATION_REQUESTED,
    by: ['OPERATOR'],
  },
  {
    from: S.CLARIFICATION_REQUESTED,
    to: S.OPERATOR_PENDING,
    by: ['CUSTOMER', 'OPERATIONS'],
  },
  {
    from: S.OPERATOR_PENDING,
    to: S.PRICE_CONFIRMED,
    // The operator accepts the proposed price, or the customer accepts the
    // operator's quote. While a quote waits for the customer, only the
    // customer's answer moves the booking; a request without a price is
    // priced only by a quote.
    by: ['OPERATOR', 'CUSTOMER'],
    unless: (c, actor) => {
      const quote = c.quote ?? 'NONE';
      if (actor === 'CUSTOMER') {
        return quote === 'LIVE' ? null : 'there is no open quote to accept';
      }
      if (quote === 'LIVE') return 'a quote is waiting for the customer';
      return c.priceOnRequest
        ? 'the request has no price to accept: send a quote'
        : null;
    },
  },
  {
    from: S.OPERATOR_PENDING,
    to: S.QUOTE_DECLINED,
    // The customer declines the operator's quote.
    by: ['CUSTOMER'],
    unless: (c) =>
      c.quote === 'LIVE' ? null : 'there is no open quote to decline',
  },
  {
    from: S.OPERATOR_PENDING,
    to: S.EXPIRED,
    // The operator's quote lapsed without an answer from the customer.
    by: ['SYSTEM'],
    unless: (c) => (c.quote === 'LAPSED' ? null : 'no quote has lapsed'),
  },
  {
    from: S.CLARIFICATION_REQUESTED,
    to: S.EXPIRED,
    // The customer did not answer the operator's question while the
    // aircraft was held.
    by: ['SYSTEM'],
  },
  {
    from: S.OPERATOR_PENDING,
    to: S.OPERATOR_UNAVAILABLE,
    by: ['OPERATOR', 'SYSTEM'],
  },
  {
    from: S.PRICE_CONFIRMED,
    to: S.AWAITING_PAYMENT,
    // Every payment model (A, B, C) asks for payment once the price is set.
    by: ['SYSTEM'],
  },
  {
    from: S.PRICE_CONFIRMED,
    to: S.QUOTE_DECLINED,
    by: ['CUSTOMER'],
  },
  {
    from: S.AWAITING_PAYMENT,
    to: S.CONFIRMED,
    by: ['SYSTEM'],
    unless: confirmationBlocker,
  },
  {
    from: S.AWAITING_PAYMENT,
    to: S.EXPIRED,
    by: ['SYSTEM'],
  },
  {
    from: S.CONFIRMED,
    to: S.SCHEDULED,
    by: ['OPERATOR', 'OPERATIONS'],
  },
  {
    from: S.SCHEDULED,
    to: S.COMPLETED,
    by: ['OPERATOR', 'OPERATIONS'],
    unless: (c) => (c.departed ? null : 'the trip has not departed yet'),
  },
];

const CANCELLERS: readonly BookingActor[] = [
  'CUSTOMER',
  'OPERATOR',
  'OPERATIONS',
];

/**
 * Whether `actor` may move a booking from `from` to `to`. An override is
 * operations' manual move between any two statuses, with a recorded reason;
 * it is only for `OPS` and `SUPER_ADMIN` (`actorFor` gives `OPERATIONS`).
 */
export function checkTransition(
  from: BookingStatus,
  to: BookingStatus,
  actor: BookingActor,
  context: TransitionContext,
  override?: { reason: string },
): TransitionCheck {
  if (from === to) return { allowed: false, reason: 'the status is unchanged' };
  if (override) {
    if (actor !== 'OPERATIONS') {
      return { allowed: false, reason: 'only operations may override' };
    }
    return override.reason.trim()
      ? { allowed: true }
      : { allowed: false, reason: 'an override needs a reason' };
  }
  if (to === S.CANCELLED) {
    if (!CANCELLABLE.includes(from)) {
      return {
        allowed: false,
        reason: `a ${from} booking cannot be cancelled`,
      };
    }
    return CANCELLERS.includes(actor)
      ? { allowed: true }
      : { allowed: false, reason: `${actor} cannot cancel` };
  }
  const edge = EDGES.find((entry) => entry.from === from && entry.to === to);
  if (!edge) return { allowed: false, reason: `${from} cannot become ${to}` };
  if (!edge.by.includes(actor)) {
    return { allowed: false, reason: `${actor} cannot move ${from} to ${to}` };
  }
  const blocker = edge.unless?.(context, actor) ?? null;
  return blocker ? { allowed: false, reason: blocker } : { allowed: true };
}

/**
 * Where a new booking goes straight after `REQUESTED`: to payment only when
 * it is instant (never air ambulance) and its price is confirmed; otherwise
 * to the operator. A charter estimate always goes to the operator.
 */
export function afterRequested(context: TransitionContext): BookingStatus {
  return checkTransition(S.REQUESTED, S.AWAITING_PAYMENT, 'SYSTEM', context)
    .allowed
    ? S.AWAITING_PAYMENT
    : S.OPERATOR_PENDING;
}

/**
 * The timestamps entering `to` sets: `confirmedAt` on CONFIRMED and
 * `cancelledAt` on CANCELLED, whoever made the move.
 */
export function statusTimestamps(
  to: BookingStatus,
  now: Date,
): { confirmedAt?: Date; cancelledAt?: Date } {
  if (to === S.CONFIRMED) return { confirmedAt: now };
  if (to === S.CANCELLED) return { cancelledAt: now };
  return {};
}
