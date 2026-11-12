import { randomUUID } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import {
  MessagingProvider,
  OutboundMessage,
  SentMessage,
} from './messaging.provider.js';

/**
 * Accepts every message and delivers none, for a shared server that has no
 * provider yet (MESSAGING_PROVIDER=sink, D-064). Nothing is kept or logged
 * but the channel: no recipient, subject or body, so one-time codes and
 * reset links can never leak through it. Sign-up and password-reset codes
 * therefore never arrive; people sign in with seeded accounts.
 */
@Injectable()
export class SinkMessagingProvider extends MessagingProvider {
  private readonly logger = new Logger('SinkMessaging');

  send(message: OutboundMessage): Promise<SentMessage> {
    this.logger.log(`Discarded one ${message.channel} message (sink provider)`);
    return Promise.resolve({ providerMessageId: `sink-${randomUUID()}` });
  }
}
