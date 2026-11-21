export type MessageChannel = 'EMAIL' | 'SMS' | 'WHATSAPP';

export interface OutboundMessage {
  channel: MessageChannel;
  /** Email address, or phone number in E.164. */
  to: string;
  subject?: string;
  body: string;
  /**
   * Email only: the HTML part, built from the plain-text body with every
   * character escaped (`toEmailHtml`). A provider sends this, never HTML of
   * its own built from `body` or from template text.
   */
  html?: string;
  /** The body holds someone's personal data: never print or log it. */
  personal?: boolean;
}

export interface SentMessage {
  providerMessageId: string;
}

/**
 * Delivers email, SMS and WhatsApp. Email can go out by SMTP
 * (`SmtpMessagingProvider`); SMS and WhatsApp providers are not chosen yet
 * (docs/open-decisions.md).
 */
export abstract class MessagingProvider {
  abstract send(message: OutboundMessage): Promise<SentMessage>;
}
