import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  MessagingProvider,
  OutboundMessage,
  SentMessage,
} from './messaging.provider.js';

export interface MockMessage extends OutboundMessage {
  providerMessageId: string;
  sentAt: string;
}

const KEEP = 500;

/**
 * Keeps the most recent messages in memory instead of sending them. They are
 * readable through the development-only outbox route, which is how a
 * developer or a test gets a one-time password.
 *
 * Each message is also printed to the API log so a developer can read a code
 * without the outbox route. This is acceptable only because the mock never
 * runs in production (see messaging.module.ts); a real provider must never
 * log message bodies.
 */
@Injectable()
export class MockMessagingProvider extends MessagingProvider {
  private readonly outbox: MockMessage[] = [];
  private readonly logger = new Logger('MockMessaging');

  async send(message: OutboundMessage): Promise<SentMessage> {
    const providerMessageId = `mock-${randomUUID()}`;
    this.outbox.push({
      ...message,
      providerMessageId,
      sentAt: new Date().toISOString(),
    });
    if (this.outbox.length > KEEP) this.outbox.shift();
    this.logger.log(
      `[DEV ONLY, not sent] ${message.channel} to ${message.to}` +
        (message.subject ? ` | ${message.subject}` : '') +
        ` | ${message.body.replace(/\s+/g, ' ')}`,
    );
    return { providerMessageId };
  }

  /** Newest first. */
  messagesTo(recipient: string): MockMessage[] {
    return this.outbox.filter((message) => message.to === recipient).reverse();
  }
}
