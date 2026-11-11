export type MessageChannel = 'EMAIL' | 'SMS' | 'WHATSAPP';

export interface OutboundMessage {
  channel: MessageChannel;
  /** Email address, or phone number in E.164. */
  to: string;
  subject?: string;
  body: string;
}

export interface SentMessage {
  providerMessageId: string;
}

/**
 * Delivers email, SMS and WhatsApp. The provider is not chosen yet
 * (docs/open-decisions.md), so the mock is the only implementation.
 */
export abstract class MessagingProvider {
  abstract send(message: OutboundMessage): Promise<SentMessage>;
}
