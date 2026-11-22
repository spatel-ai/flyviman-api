import { indiaDateTime } from '../../common/india-date.js';
import type { NotificationChannel } from '../../generated/prisma/enums.js';
import { eventTemplates } from './event-templates.js';

export interface TemplateDefinition {
  key: string;
  channel: NotificationChannel;
  subject?: string;
  body: string;
}

/**
 * Built-in wording, used when the NotificationTemplate table has no active
 * row for a key and channel. `npm run db:seed` copies these into the table,
 * where administrators will be able to edit them (M10). Placeholders are
 * `{{name}}`. SMS and WhatsApp wording must be registered with the provider
 * before launch in India.
 */
const WRITTEN_TEMPLATES: TemplateDefinition[] = [
  {
    key: 'auth.verification_code',
    channel: 'EMAIL',
    subject: 'Your Flyviman verification code',
    body: 'Your verification code is {{code}}. It expires in {{minutes}} minutes. If you did not ask for it, you can ignore this email.',
  },
  {
    key: 'auth.verification_code',
    channel: 'SMS',
    body: '{{code}} is your Flyviman verification code. It expires in {{minutes}} minutes.',
  },
  {
    key: 'auth.password_reset',
    channel: 'EMAIL',
    subject: 'Reset your Flyviman password',
    body: 'Use this link to choose a new password: {{link}}\nIt works once and expires in {{minutes}} minutes. If you did not ask for it, you can ignore this email.',
  },
  {
    key: 'staff.invitation',
    channel: 'EMAIL',
    subject: 'Your Flyviman staff account',
    body: 'A Flyviman staff account has been created for you. Choose your password here: {{link}}\nThe link works once and expires in {{hours}} hours.',
  },
  {
    key: 'operator.staff_invitation',
    channel: 'EMAIL',
    subject: '{{operatorName}} invited you to Flyviman',
    body: '{{operatorName}} has invited you to help manage its aircraft on Flyviman. Choose your password here: {{link}}\nThe link works once and expires in {{hours}} hours. If you were not expecting this, you can ignore this email.',
  },
  {
    key: 'document.expiring',
    channel: 'EMAIL',
    subject: '{{document}} for {{subject}} expires {{when}}',
    body: '{{document}} for {{subject}} expires on {{date}}. Upload the renewed copy in the Flyviman operator portal before then. An aircraft whose required documents have expired is not offered to customers.',
  },
  {
    key: 'document.expiring',
    channel: 'IN_APP',
    subject: '{{document}} expires {{when}}',
    body: '{{document}} for {{subject}} expires on {{date}}. Upload the renewed copy before then.',
  },
  {
    key: 'document.expired',
    channel: 'EMAIL',
    subject: '{{document}} for {{subject}} is due today or has expired',
    body: '{{document}} for {{subject}} expires on {{date}}. Until a renewed copy is uploaded and verified, an aircraft that needs it is not offered to customers.',
  },
  {
    key: 'document.expired',
    channel: 'IN_APP',
    subject: '{{document}} is due today or has expired',
    body: '{{document}} for {{subject}} expires on {{date}}. Upload the renewed copy now.',
  },
  {
    key: 'customer.welcome',
    channel: 'EMAIL',
    subject: 'Welcome to Flyviman',
    body: 'Hello {{firstName}}, your Flyviman account is ready.',
  },
  {
    key: 'customer.welcome',
    channel: 'IN_APP',
    subject: 'Welcome to Flyviman',
    body: 'Your account is ready. Add the people you travel with under Saved passengers.',
  },
  {
    key: 'operator.submitted',
    channel: 'IN_APP',
    subject: 'Application received',
    body: 'We have received the application for {{operatorName}}. Our operations team will review it.',
  },
  {
    key: 'operator.approved',
    channel: 'EMAIL',
    subject: 'Your Flyviman operator account is approved',
    body: '{{operatorName}} has been approved on Flyviman.',
  },
  {
    key: 'operator.approved',
    channel: 'IN_APP',
    subject: 'Application approved',
    body: '{{operatorName}} has been approved on Flyviman.',
  },
  {
    key: 'operator.rejected',
    channel: 'EMAIL',
    subject: 'Your Flyviman operator application needs changes',
    body: 'The application for {{operatorName}} was not approved. Reason: {{reason}}\nYou can update the application and submit it again.',
  },
  {
    key: 'operator.rejected',
    channel: 'IN_APP',
    subject: 'Application not approved',
    body: 'Reason: {{reason}} You can update the application and submit it again.',
  },
  {
    key: 'operator.suspended',
    channel: 'EMAIL',
    subject: 'Your Flyviman operator account is suspended',
    body: '{{operatorName}} has been suspended on Flyviman. Reason: {{reason}}',
  },
  {
    key: 'operator.suspended',
    channel: 'IN_APP',
    subject: 'Account suspended',
    body: 'Reason: {{reason}}',
  },
  {
    key: 'operator.reinstated',
    channel: 'EMAIL',
    subject: 'Your Flyviman operator account is active again',
    body: '{{operatorName}} has been reinstated on Flyviman.',
  },
  {
    key: 'operator.reinstated',
    channel: 'IN_APP',
    subject: 'Account reinstated',
    body: '{{operatorName}} is active again.',
  },
  {
    key: 'aircraft.approved',
    channel: 'EMAIL',
    subject: 'Your aircraft is approved on Flyviman',
    body: '{{registration}} has been approved and can be offered.',
  },
  {
    key: 'aircraft.approved',
    channel: 'IN_APP',
    subject: 'Aircraft approved',
    body: '{{registration}} has been approved.',
  },
  {
    key: 'aircraft.rejected',
    channel: 'EMAIL',
    subject: 'Your aircraft listing needs changes',
    body: '{{registration}} was not approved. Reason: {{reason}}\nYou can update it and submit it again.',
  },
  {
    key: 'aircraft.rejected',
    channel: 'IN_APP',
    subject: 'Aircraft not approved',
    body: '{{registration}} was not approved. Reason: {{reason}}',
  },
  {
    key: 'aircraft.suspended',
    channel: 'EMAIL',
    subject: 'Your aircraft is suspended on Flyviman',
    body: '{{registration}} has been suspended. Reason: {{reason}}',
  },
  {
    key: 'aircraft.suspended',
    channel: 'IN_APP',
    subject: 'Aircraft suspended',
    body: '{{registration}} has been suspended. Reason: {{reason}}',
  },
  {
    key: 'aircraft.reinstated',
    channel: 'EMAIL',
    subject: 'Your aircraft is active again',
    body: '{{registration}} has been reinstated on Flyviman.',
  },
  {
    key: 'aircraft.reinstated',
    channel: 'IN_APP',
    subject: 'Aircraft reinstated',
    body: '{{registration}} is active again.',
  },
  {
    key: 'empty_leg.changed',
    channel: 'EMAIL',
    subject: 'An empty leg you follow has changed: {{route}}',
    body: 'The empty-leg offer {{reference}} ({{route}}) has been updated by the operator. Open it on Flyviman to see the new price, dates and conditions before you request it.',
  },
  {
    key: 'empty_leg.changed',
    channel: 'IN_APP',
    subject: 'Empty leg updated',
    body: '{{route}} ({{reference}}) has been updated. Check the new details before you request it.',
  },
  {
    key: 'empty_leg.withdrawn',
    channel: 'EMAIL',
    subject: 'An empty leg you follow is no longer offered: {{route}}',
    body: 'The operator has withdrawn the empty-leg offer {{reference}} ({{route}}). It can no longer be requested.',
  },
  {
    key: 'empty_leg.withdrawn',
    channel: 'IN_APP',
    subject: 'Empty leg withdrawn',
    body: '{{route}} ({{reference}}) is no longer offered.',
  },
  {
    key: 'empty_leg.expired',
    channel: 'EMAIL',
    subject: 'An empty leg you follow has expired: {{route}}',
    body: 'The empty-leg offer {{reference}} ({{route}}) has passed its validity and can no longer be requested.',
  },
  {
    key: 'empty_leg.expired',
    channel: 'IN_APP',
    subject: 'Empty leg expired',
    body: '{{route}} ({{reference}}) has expired.',
  },
  {
    key: 'empty_leg.approved',
    channel: 'IN_APP',
    subject: 'Empty leg published',
    body: '{{route}} ({{reference}}) was approved and is now listed.',
  },
  {
    key: 'empty_leg.rejected',
    channel: 'EMAIL',
    subject: 'Your empty-leg offer needs changes',
    body: '{{route}} ({{reference}}) was not approved. Reason: {{reason}}\nYou can update it and publish it again.',
  },
  {
    key: 'empty_leg.rejected',
    channel: 'IN_APP',
    subject: 'Empty leg not approved',
    body: '{{route}} ({{reference}}) was not approved. Reason: {{reason}}',
  },
  {
    key: 'booking.quote_sent',
    channel: 'EMAIL',
    subject: 'The operator has quoted your request {{reference}}',
    body: 'The operator has sent a quote for your booking request {{reference}}. It is valid until {{validUntil}}. Open it on Flyviman to see the price and its conditions before you accept or decline.',
  },
  {
    key: 'booking.quote_sent',
    channel: 'IN_APP',
    subject: 'New quote',
    body: 'The operator quoted {{reference}}. Review it before {{validUntil}}.',
  },
  {
    key: 'booking.clarification_requested',
    channel: 'EMAIL',
    subject: 'A question about your request {{reference}}',
    body: 'The operator has a question about your booking request {{reference}}. Open it on Flyviman to answer, so the operator can respond.',
  },
  {
    key: 'booking.clarification_requested',
    channel: 'IN_APP',
    subject: 'Question from the operator',
    body: 'The operator asked a question about {{reference}}.',
  },
  {
    key: 'booking.price_confirmed',
    channel: 'EMAIL',
    subject: 'Your price is confirmed for {{reference}}',
    body: 'The price for your booking {{reference}} is confirmed. Open it on Flyviman for the next step. Your booking is not confirmed until Flyviman tells you so.',
  },
  {
    key: 'booking.price_confirmed',
    channel: 'IN_APP',
    subject: 'Price confirmed',
    body: 'The price for {{reference}} is confirmed.',
  },
  {
    key: 'booking.operator_unavailable',
    channel: 'EMAIL',
    subject: 'Your request {{reference}} could not be accepted',
    body: 'The operator cannot take your booking request {{reference}}. Nothing has been charged. Search again on Flyviman to find another aircraft.',
  },
  {
    key: 'booking.operator_unavailable',
    channel: 'IN_APP',
    subject: 'Request not accepted',
    body: 'The operator cannot take {{reference}}. Nothing has been charged.',
  },
  {
    key: 'booking.expired',
    channel: 'EMAIL',
    subject: 'Your request {{reference}} has expired',
    body: 'Your booking request {{reference}} has expired without an answer in time. Nothing has been charged. Search again on Flyviman to request another trip.',
  },
  {
    key: 'booking.expired',
    channel: 'IN_APP',
    subject: 'Request expired',
    body: '{{reference}} has expired. Nothing has been charged.',
  },
  {
    key: 'booking.quote_accepted',
    channel: 'IN_APP',
    subject: 'Quote accepted',
    body: 'The customer accepted your quote for {{reference}}.',
  },
  {
    key: 'booking.quote_declined',
    channel: 'IN_APP',
    subject: 'Quote declined',
    body: 'The customer declined your quote for {{reference}}.',
  },
  {
    key: 'booking.clarification_answered',
    channel: 'IN_APP',
    subject: 'Customer answered',
    body: 'The customer answered your question about {{reference}}.',
  },
  {
    // To the operations inbox, not to the customer. The subject carries no
    // personal data; the body does, because staff need it to reply.
    key: 'enquiry.received',
    channel: 'EMAIL',
    subject: 'New enquiry {{reference}}: {{topic}}',
    body: 'A new enquiry arrived from the contact page.\nReference: {{reference}}\nTopic: {{topic}}\nReceived: {{receivedAt}}\nName: {{name}}\nEmail: {{email}}\nPhone: {{phone}}\n\n{{message}}',
  },
];

/** The written templates and the ones the notification matrix adds (`matrix.ts`). */
export const DEFAULT_TEMPLATES: TemplateDefinition[] = [
  ...WRITTEN_TEMPLATES,
  ...eventTemplates(WRITTEN_TEMPLATES),
];

/**
 * Templates whose body carries someone's personal data (contact details,
 * free text). They are never printed by the development mock, and their
 * stored variables are cleared once the message is sent or has failed.
 */
export const PERSONAL_TEMPLATES: ReadonlySet<string> = new Set([
  'enquiry.received',
]);

const ISO_MOMENT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

/** A stored ISO timestamp reads as India time; any other value is as given. */
function readable(value: string | number): string {
  const text = String(value);
  return ISO_MOMENT.test(text) ? indiaDateTime(new Date(text)) : text;
}

/** Fills `{{name}}` placeholders. An unknown placeholder becomes empty. */
export function render(
  text: string,
  variables: Record<string, string | number>,
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) =>
    name in variables ? readable(variables[name]) : '',
  );
}

/** The distinct `{{name}}` placeholders in a text. */
export function placeholdersOf(text: string | null | undefined): Set<string> {
  return new Set(
    [...(text ?? '').matchAll(/\{\{\s*(\w+)\s*\}\}/g)].map((m) => m[1]),
  );
}

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * The HTML part of an email, from its rendered plain-text body. Templates
 * are plain text, so the whole rendered text is escaped: neither a value a
 * customer or operator supplied nor a staff-edited template can add markup
 * or script. Line breaks become `<br>`.
 */
export function toEmailHtml(text: string): string {
  return text
    .replace(/[&<>"']/g, (c) => HTML_ESCAPES[c])
    .replace(/\r?\n/g, '<br>\n');
}

/** A subject is one header line: control characters and line separators in values become one space. */
export function oneLine(text: string): string {
  return text.replace(/[\p{Cc}\u2028\u2029]+/gu, ' ');
}
