import {
  HttpStatus,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import type { IncomingHttpHeaders } from 'node:http';
import { AppException } from '../../common/errors/app.exception.js';
import { PaymentGatewayProvider } from '../../integrations/payment/payment-gateway.provider.js';
import type { WebhookAckResponseDto } from './dto/webhook-ack-response.dto.js';

/** Refusals are logged at most once per this window. */
export const REFUSAL_LOG_WINDOW_MS = 60_000;

/**
 * Receives gateway notifications. For now a stub: it verifies the signature
 * and acknowledges, and records nothing. M9 adds storing the event in
 * `PaymentEvent` (unique per provider event ID) and acting on it.
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger(PaymentWebhooksService.name);
  /** When the last refusal warning was written, and refusals since then. */
  private lastWarnedAt = -Infinity;
  private unlogged = 0;

  constructor(private readonly gateway: PaymentGatewayProvider) {}

  receive(
    provider: string,
    rawBody: unknown,
    headers: IncomingHttpHeaders,
  ): WebhookAckResponseDto {
    if (provider !== this.gateway.name) throw new NotFoundException();

    // Without the raw bytes the signature cannot be checked; never verify a
    // re-serialised body.
    const result = Buffer.isBuffer(rawBody)
      ? this.gateway.parseWebhook(rawBody, headers)
      : ({ ok: false, reason: 'signature' } as const);

    if (!result.ok) {
      this.warnRefused(provider, result.reason);
      if (result.reason === 'signature') {
        throw new AppException(
          'WEBHOOK_SIGNATURE_INVALID',
          'The webhook signature is not valid.',
          HttpStatus.BAD_REQUEST,
        );
      }
      throw new AppException(
        'VALIDATION_ERROR',
        'The webhook is not a well-formed event.',
        HttpStatus.BAD_REQUEST,
      );
    }
    return { received: true };
  }

  /**
   * One warning a minute at most, with the count of refusals since the last
   * one, so a flood of forged calls cannot flood the log. Never the payload
   * or the signature itself.
   */
  private warnRefused(provider: string, reason: string): void {
    this.unlogged += 1;
    const now = Date.now();
    if (now - this.lastWarnedAt < REFUSAL_LOG_WINDOW_MS) return;
    this.logger.warn(
      `Payment webhook refused (provider=${provider}, reason=${reason}, refusals=${this.unlogged})`,
    );
    this.lastWarnedAt = now;
    this.unlogged = 0;
  }
}
