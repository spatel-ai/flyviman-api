import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * `a***@example.com`, `+91******3210`: enough to recognise, not to collect.
 * Short values keep at most their last two characters.
 */
export function maskRecipient(to: string): string {
  const at = to.indexOf('@');
  if (at >= 0) return `${to.slice(0, Math.min(at, 1))}***${to.slice(at)}`;
  if (to.length >= 11) {
    return `${to.slice(0, 3)}${'*'.repeat(to.length - 7)}${to.slice(-4)}`;
  }
  return `${'*'.repeat(Math.max(to.length - 2, 4))}${to.slice(-2)}`;
}

/**
 * Keeps the most recent messages in memory instead of sending them. They are
 * readable through the development-only outbox route, which is how a
 * developer or a test gets a one-time password.
 *
 * With NODE_ENV=development, and only then, each message is also printed to
 * the API log so a developer can read a code in the terminal. The recipient
 * is masked. Any other environment that runs the mock (tests, or a shared
 * server with ENABLE_DEV_TOOLS on) never logs a message: bodies hold reset
 * and invitation links that would let anyone reading the logs take over an
 * account. A real provider must never log message bodies.
 */
@Injectable()
export class MockMessagingProvider extends MessagingProvider {
  private readonly outbox: MockMessage[] = [];
  private readonly logger = new Logger('MockMessaging');
  private readonly printToLog: boolean;

  constructor(config: ConfigService) {
    super();
    this.printToLog = config.get<string>('NODE_ENV') === 'development';
  }

  async send(message: OutboundMessage): Promise<SentMessage> {
    const providerMessageId = `mock-${randomUUID()}`;
    this.outbox.push({
      ...message,
      providerMessageId,
      sentAt: new Date().toISOString(),
    });
    if (this.outbox.length > KEEP) this.outbox.shift();
    if (!this.printToLog) return { providerMessageId };
    this.logger.log(
      `[DEV ONLY, not sent] ${message.channel} to ${maskRecipient(message.to)}` +
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
