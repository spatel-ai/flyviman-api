import type { NotificationChannel } from '../../generated/prisma/enums.js';

export interface TemplateDefinition {
  key: string;
  channel: NotificationChannel;
  subject?: string;
  body: string;
}

/**
 * Built-in wording, used when the NotificationTemplate table has no active
 * row for a key and channel. `npm run db:seed` copies these into the table,
 * where administrators will be able to edit them (M9). Placeholders are
 * `{{name}}`. SMS and WhatsApp wording must be registered with the provider
 * before launch in India.
 */
export const DEFAULT_TEMPLATES: TemplateDefinition[] = [
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
    // To the operations inbox, not to the customer. The subject carries no
    // personal data; the body does, because staff need it to reply.
    key: 'enquiry.received',
    channel: 'EMAIL',
    subject: 'New enquiry {{reference}}: {{topic}}',
    body: 'A new enquiry arrived from the contact page.\nReference: {{reference}}\nTopic: {{topic}}\nReceived: {{receivedAt}}\nName: {{name}}\nEmail: {{email}}\nPhone: {{phone}}\n\n{{message}}',
  },
];

/**
 * Templates whose body carries someone's personal data (contact details,
 * free text). They are never printed by the development mock, and their
 * stored variables are cleared once the message is sent or has failed.
 */
export const PERSONAL_TEMPLATES: ReadonlySet<string> = new Set([
  'enquiry.received',
]);

/** Fills `{{name}}` placeholders. An unknown placeholder becomes empty. */
export function render(
  text: string,
  variables: Record<string, string | number>,
): string {
  return text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_match, name: string) =>
    name in variables ? String(variables[name]) : '',
  );
}
