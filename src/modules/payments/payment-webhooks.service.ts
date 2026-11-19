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

/**
 * Receives gateway notifications. For now a stub: it verifies the signature
 * and acknowledges, and records nothing. M9 adds storing the event in
 * `PaymentEvent` (unique per provider event ID) and acting on it.
 */
@Injectable()
export class PaymentWebhooksService {
  private readonly logger = new Logger(PaymentWebhooksService.name);

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
      // Never the payload or the signature itself.
      this.logger.warn(
        `Payment webhook refused (provider=${provider}, reason=${result.reason})`,
      );
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
}
