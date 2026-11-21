import type { TemplateDefinition } from './templates.js';
import { NOTIFICATION_MATRIX } from './matrix.js';

/**
 * The wording of the matrix events (M10), kept as one short copy per event
 * and turned into a template for each channel the event uses. Variables are
 * system-derived only: `reference`, `link`, `validUntil`, `decision`,
 * `passengerCount`, `refundReference`. No
 * amount, passenger, medical or free-text value ever appears, so a message
 * is safe on a lock screen (rule 8) and an estimate is never read as a
 * final price (rule 1).
 */
interface Copy {
  /** In-app title and email subject. */
  title?: string;
  /** In-app body and email body. */
  text?: string;
  /** SMS and WhatsApp, after "Flyviman {{reference}}:". */
  short?: string;
}

const EMERGENCY =
  'In an immediate emergency, call your local emergency number (112 in India) now.';

const COPY: Record<string, Copy> = {
  'booking.requested': {
    title: 'New booking request {{reference}}',
    text: 'A customer has requested one of your aircraft: {{reference}}. Open it in the operator portal to accept, reject, ask a question or send a quote before the hold ends.',
    short: 'new booking request. Respond in the operator portal.',
  },
  'booking.quote_accepted': {
    title: 'Quote accepted for {{reference}}',
    text: 'The customer accepted your quote for {{reference}}.',
  },
  'booking.quote_declined': {
    title: 'Quote declined for {{reference}}',
    text: 'The customer declined your quote for {{reference}}.',
  },
  'booking.price_declined': {
    title: 'Price declined for {{reference}}',
    text: 'The customer declined the confirmed price for {{reference}} before paying. The aircraft time is free again.',
  },
  'booking.clarification_answered': {
    title: 'Customer answered about {{reference}}',
    text: 'The customer answered your question about {{reference}}.',
  },
  'booking.cancelled_by_customer': {
    title: 'Booking {{reference}} cancelled by the customer',
    text: 'The customer cancelled {{reference}}. The aircraft time is free again.',
  },
  'booking.change_requested': {
    title: 'Change requested for {{reference}}',
    text: 'The customer asked for a change to {{reference}}. Open it in the operator portal to approve or decline.',
  },
  'booking.passengers_changed': {
    title: 'Passengers changed for {{reference}}',
    text: 'The customer changed who is flying on {{reference}}: {{passengerCount}} passengers now. Open it in the operator portal for the passenger details.',
  },
  'booking.confirmed_operator': {
    title: 'Booking {{reference}} is confirmed',
    text: 'Booking {{reference}} is confirmed. Open it in the operator portal for the trip details.',
  },
  'booking.price_confirmed': {
    short:
      'the operator confirmed your price. Open it for the next step. Your booking is not confirmed until Flyviman tells you so.',
  },
  'booking.quote_sent': {
    short: 'the operator sent a quote. Review it before {{validUntil}}.',
  },
  'booking.price_overridden': {
    title: 'A new price for your request {{reference}}',
    text: 'Flyviman has set a new price for your booking request {{reference}}, as a quote valid until {{validUntil}}. Open it on Flyviman to see the price and its conditions before you accept or decline.',
    short:
      'Flyviman set a new price as a quote. Review it before {{validUntil}}.',
  },
  'booking.change_decided': {
    title: 'Your change request for {{reference}} was {{decision}}',
    text: 'Your change request for {{reference}} was {{decision}}. Open it on Flyviman for details. A change that affects the price needs a revised quote.',
  },
  'booking.cancelled': {
    title: 'Your booking {{reference}} is cancelled',
    text: 'Your booking {{reference}} has been cancelled. Open it on Flyviman to see the cancellation terms that applied.',
    short: 'your booking is cancelled. Details are on Flyviman.',
  },
  'booking.confirmed': {
    title: 'Your booking {{reference}} is confirmed',
    text: 'Your booking {{reference}} is confirmed. Open it on Flyviman for the details and the cancellation terms.',
    short: 'your booking is confirmed. Details are on Flyviman.',
  },
  'booking.scheduled': {
    title: 'Your trip {{reference}} is scheduled',
    text: 'The operator has finalised the arrangements for your trip {{reference}}. Open it on Flyviman for the details.',
  },
  'booking.completed': {
    title: 'Your trip {{reference}} is completed',
    text: 'Your trip {{reference}} has been marked as flown. Thank you for flying with Flyviman.',
  },
  'booking.cancelled_by_operator': {
    title: 'Your booking {{reference}} has been cancelled by the operator',
    text: 'The operator can no longer fly your booking {{reference}}, so it has been cancelled. No cancellation charge applies: anything you paid will be refunded by Flyviman. Open it on Flyviman for the details.',
    short:
      'the operator cancelled your booking. No charge applies; anything you paid will be refunded by Flyviman.',
  },
  'booking.cancelled_by_operator_ops': {
    title: 'Operator cancelled booking {{reference}}',
    text: 'The operator cancelled booking {{reference}}. No charge applies to the customer; any refund due is listed for finance in refunds due. Follow up with the customer and the operator as needed.',
  },
  'payment.succeeded': {
    title: 'Payment received for {{reference}}',
    text: 'We received your payment for {{reference}}. Open it on Flyviman to see where your booking stands. A booking is confirmed only when Flyviman tells you so.',
    short:
      'payment received. A booking is confirmed only when Flyviman tells you so.',
  },
  'payment.failed': {
    title: 'Payment failed for {{reference}}',
    text: 'Your payment for {{reference}} did not go through. Open the booking on Flyviman to try again.',
    short: 'your payment did not go through. Open the booking to try again.',
  },
  'refund.initiated': {
    title: 'Refund {{refundReference}} started for {{reference}}',
    text: 'Flyviman has started a refund for your booking {{reference}}. Your refund reference is {{refundReference}}. It can take a few working days to reach your account. Open the booking on Flyviman to follow it.',
  },
  'refund.completed': {
    title: 'Refund {{refundReference}} processed for {{reference}}',
    text: 'Your refund {{refundReference}} for booking {{reference}} has been processed. It can take a few working days to show in your account, depending on your bank.',
  },
  'refund.failed': {
    title: 'Refund {{refundReference}} failed for {{reference}}',
    text: 'The payment gateway could not process refund {{refundReference}} for booking {{reference}}. The amount is refundable again: finance should start a new refund from refunds due, and the customer may need to be told.',
  },
  'settlement.updated': {
    title: 'Settlement updated for booking {{reference}}',
    text: 'The settlement for booking {{reference}} has changed after a refund or payment update. Open settlements in the operator portal to see the amount payable now.',
  },
  'air_ambulance.received': {
    title: 'New air ambulance request {{reference}}',
    text: 'A new air ambulance request {{reference}} needs an owner. Open the operations queue to assign and verify it. It is not confirmed until operations and the operator verify the mission.',
    short: 'new air ambulance request. Open the operations queue.',
  },
  'air_ambulance.quoted': {
    title: 'Quotation for your request {{reference}}',
    text: `Operations have prepared a quotation for your air ambulance request {{reference}}. Open it on Flyviman to review it. The request is not confirmed until operations and the operator verify the mission. ${EMERGENCY}`,
    short: `a quotation is ready. Not confirmed until the mission is verified. ${EMERGENCY}`,
  },
  'air_ambulance.confirmed': {
    title: 'Your air ambulance request {{reference}} is confirmed',
    text: `Operations and the operator have verified the mission for {{reference}}. Open it on Flyviman for the details. ${EMERGENCY}`,
    short: `the mission is confirmed. Details are on Flyviman. ${EMERGENCY}`,
  },
  'air_ambulance.cancelled': {
    title: 'Your air ambulance request {{reference}} is cancelled',
    text: `Your air ambulance request {{reference}} has been cancelled. If you still need help, request it again or contact us. ${EMERGENCY}`,
    short: `your request is cancelled. ${EMERGENCY}`,
  },
};

/** The variables a matrix message may use; the test holds templates to it. */
export const EVENT_VARIABLES: ReadonlySet<string> = new Set([
  'reference',
  'link',
  'validUntil',
  'decision',
  'passengerCount',
  'refundReference',
]);

/**
 * The templates the matrix needs that are not written out by hand: one per
 * event and channel. SMS and WhatsApp wording must be registered with the
 * provider before launch in India.
 */
export function eventTemplates(
  written: readonly TemplateDefinition[],
): TemplateDefinition[] {
  const have = new Set(written.map((t) => `${t.key}:${t.channel}`));
  const made: TemplateDefinition[] = [];
  for (const rule of NOTIFICATION_MATRIX) {
    const copy = COPY[rule.key] ?? {};
    for (const channel of rule.channels) {
      if (have.has(`${rule.key}:${channel}`)) continue;
      if (channel === 'IN_APP' && copy.title && copy.text) {
        made.push({
          key: rule.key,
          channel,
          subject: copy.title,
          body: copy.text,
        });
      } else if (channel === 'EMAIL' && copy.title && copy.text) {
        made.push({
          key: rule.key,
          channel,
          subject: copy.title,
          body: `${copy.text}\nOpen it: {{link}}`,
        });
      } else if ((channel === 'SMS' || channel === 'WHATSAPP') && copy.short) {
        made.push({
          key: rule.key,
          channel,
          body: `Flyviman {{reference}}: ${copy.short} {{link}}`,
        });
      }
    }
  }
  return made;
}
