import type { NotificationChannel } from '../../generated/prisma/enums.js';

/**
 * The notification matrix (M10): which event tells whom, over which
 * channels, in one place. Pure data and pure functions; recipients are
 * looked up by `events/notification-events.service.ts`.
 *
 * Rules the rows keep (`docs/architecture/security-rbac.md`, rules 2, 7, 8):
 * a message carries the reference and system-worded text only (never a
 * passenger, medical or free-text value, never an amount), a payment notice
 * never says the booking is confirmed, and an air ambulance message points
 * to emergency services.
 */

export type Audience = 'CUSTOMER' | 'OPERATOR' | 'OPERATIONS';

/** Where the message's link leads. */
export type Subject = 'BOOKING' | 'AIR_AMBULANCE';

export interface NotificationRule {
  /** The event; also the template key of its messages. */
  key: string;
  /**
   * Customer: the booker. Operator: administrators and staff who manage
   * bookings on that aircraft. Operations: operations users, and the
   * operations inbox for email.
   */
  audience: Audience;
  subject: Subject;
  /** In-app and email are always present: they are the record. */
  channels: readonly NotificationChannel[];
  /**
   * Must be sent whatever the recipient's preferences say (a payment
   * result, a confirmation or cancellation, anything about a mission).
   */
  mandatory: boolean;
}

const BASIC = ['IN_APP', 'EMAIL'] as const;
const URGENT = ['IN_APP', 'EMAIL', 'SMS', 'WHATSAPP'] as const;

function rule(
  key: string,
  audience: Audience,
  subject: Subject,
  channels: readonly NotificationChannel[],
  mandatory: boolean,
): NotificationRule {
  return { key, audience, subject, channels, mandatory };
}

export const NOTIFICATION_MATRIX: readonly NotificationRule[] = [
  // Booking requests: to the operator.
  rule('booking.requested', 'OPERATOR', 'BOOKING', URGENT, false),
  rule('booking.quote_accepted', 'OPERATOR', 'BOOKING', BASIC, false),
  rule('booking.quote_declined', 'OPERATOR', 'BOOKING', BASIC, false),
  rule('booking.price_declined', 'OPERATOR', 'BOOKING', BASIC, false),
  rule('booking.clarification_answered', 'OPERATOR', 'BOOKING', BASIC, false),
  rule('booking.cancelled_by_customer', 'OPERATOR', 'BOOKING', BASIC, true),
  rule('booking.change_requested', 'OPERATOR', 'BOOKING', BASIC, false),
  // Who flies is the operator's manifest: always told (counts only).
  rule('booking.passengers_changed', 'OPERATOR', 'BOOKING', BASIC, true),
  rule('booking.confirmed_operator', 'OPERATOR', 'BOOKING', BASIC, true),
  // Booking lifecycle after confirmation: operator cancellation (M8-B).
  rule(
    'booking.cancelled_by_operator_ops',
    'OPERATIONS',
    'BOOKING',
    BASIC,
    true,
  ),
  // Booking requests: to the customer.
  rule('booking.price_confirmed', 'CUSTOMER', 'BOOKING', URGENT, false),
  rule('booking.operator_unavailable', 'CUSTOMER', 'BOOKING', BASIC, false),
  rule('booking.clarification_requested', 'CUSTOMER', 'BOOKING', BASIC, false),
  rule('booking.quote_sent', 'CUSTOMER', 'BOOKING', URGENT, false),
  rule('booking.price_overridden', 'CUSTOMER', 'BOOKING', URGENT, false),
  rule('booking.expired', 'CUSTOMER', 'BOOKING', BASIC, false),
  rule('booking.change_decided', 'CUSTOMER', 'BOOKING', BASIC, false),
  rule('booking.cancelled', 'CUSTOMER', 'BOOKING', URGENT, true),
  rule('booking.confirmed', 'CUSTOMER', 'BOOKING', URGENT, true),
  rule('booking.scheduled', 'CUSTOMER', 'BOOKING', BASIC, false),
  rule('booking.completed', 'CUSTOMER', 'BOOKING', BASIC, false),
  rule('booking.cancelled_by_operator', 'CUSTOMER', 'BOOKING', URGENT, true),
  // Payments (rule 2: a payment notice is not a confirmation).
  rule('payment.succeeded', 'CUSTOMER', 'BOOKING', URGENT, true),
  rule('payment.failed', 'CUSTOMER', 'BOOKING', URGENT, true),
  // Air ambulance: operations on a new request, the customer afterwards.
  rule('air_ambulance.received', 'OPERATIONS', 'AIR_AMBULANCE', URGENT, true),
  rule('air_ambulance.quoted', 'CUSTOMER', 'AIR_AMBULANCE', URGENT, true),
  rule('air_ambulance.confirmed', 'CUSTOMER', 'AIR_AMBULANCE', URGENT, true),
  rule('air_ambulance.cancelled', 'CUSTOMER', 'AIR_AMBULANCE', URGENT, true),
];

export function ruleFor(key: string): NotificationRule {
  const found = NOTIFICATION_MATRIX.find((candidate) => candidate.key === key);
  if (!found) throw new Error(`No notification rule for ${key}`);
  return found;
}

/**
 * The channels a rule uses now. WhatsApp is off until a provider and
 * registered templates exist (`WHATSAPP_ENABLED`). In-app is never dropped;
 * a mandatory rule ignores `optedOut` (preferences are not stored yet, the
 * parameter is where they plug in).
 */
export function channelsFor(
  rule: NotificationRule,
  options: {
    whatsappEnabled: boolean;
    optedOut?: readonly NotificationChannel[];
  },
): NotificationChannel[] {
  return rule.channels.filter((channel) => {
    if (channel === 'WHATSAPP' && !options.whatsappEnabled) return false;
    if (channel === 'IN_APP' || rule.mandatory) return true;
    return !(options.optedOut ?? []).includes(channel);
  });
}

/**
 * The web path a message links to, relative to the site's origin. An
 * operator's link to a booking that has been confirmed (`confirmed`) leads
 * to its bookings page, before that to the request inbox.
 */
export function hrefFor(
  rule: NotificationRule,
  reference: string,
  options: { confirmed?: boolean } = {},
): string {
  const ref = encodeURIComponent(reference);
  if (rule.subject === 'AIR_AMBULANCE') {
    return rule.audience === 'OPERATIONS'
      ? `/admin/air-ambulance/${ref}`
      : `/air-ambulance/requests/${ref}`;
  }
  if (rule.audience === 'OPERATIONS') return `/admin/bookings/${ref}`;
  if (rule.audience === 'OPERATOR') {
    return options.confirmed
      ? `/operator/bookings/${ref}`
      : `/operator/requests/${ref}`;
  }
  return `/account/trips/${ref}`;
}

/**
 * The events a booking status change raises on its own. Changes the request
 * flows already announce (price confirmed, unavailable, expired, quote
 * accepted and declined, answered) are not listed: they notify where they
 * happen. An operations override (`actor` OPERATIONS) to one of those
 * statuses has no flow of its own, so it is announced here.
 */
export function bookingStatusEvents(
  from: string,
  to: string,
  actor: string,
): string[] {
  if (from === 'REQUESTED' && to === 'OPERATOR_PENDING') {
    return ['booking.requested'];
  }
  if (to === 'CONFIRMED')
    return ['booking.confirmed', 'booking.confirmed_operator'];
  if (to === 'CANCELLED') {
    if (actor === 'CUSTOMER') {
      return ['booking.cancelled', 'booking.cancelled_by_customer'];
    }
    // The operator's cancellation waives the charge (M8-B): the customer is
    // told so, and operations are told to follow up.
    if (actor === 'OPERATOR') {
      return [
        'booking.cancelled_by_operator',
        'booking.cancelled_by_operator_ops',
      ];
    }
    return ['booking.cancelled'];
  }
  if (to === 'SCHEDULED') return ['booking.scheduled'];
  if (to === 'COMPLETED') return ['booking.completed'];
  // The customer declines a confirmed price before paying (W3-3).
  if (from === 'PRICE_CONFIRMED' && to === 'QUOTE_DECLINED') {
    return actor === 'CUSTOMER' ? ['booking.price_declined'] : [];
  }
  if (actor === 'OPERATIONS') {
    if (to === 'EXPIRED') return ['booking.expired'];
    if (to === 'OPERATOR_UNAVAILABLE') return ['booking.operator_unavailable'];
    if (to === 'PRICE_CONFIRMED') return ['booking.price_confirmed'];
  }
  return [];
}

/** The air ambulance statuses that tell the customer, and the event each raises. */
export const AIR_AMBULANCE_STATUS_EVENTS: Readonly<Record<string, string>> = {
  QUOTED: 'air_ambulance.quoted',
  CONFIRMED: 'air_ambulance.confirmed',
  CANCELLED: 'air_ambulance.cancelled',
};
