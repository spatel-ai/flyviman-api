import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { WebhookRateLimit } from '../../common/rate-limit/rate-limit.js';
import { Public, SkipCsrf } from '../auth/auth.decorators.js';
import { WebhookAckResponseDto } from './dto/webhook-ack-response.dto.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';

/**
 * Called by the payment gateway, not by a browser: authorised by the
 * signature over the raw body (app.setup.ts keeps it unparsed), so no
 * session and no CSRF check. Limited per address on its own, generous tier
 * (`RATE_LIMIT_WEBHOOK_PER_MINUTE`), so a flood of forged calls is cut off
 * before the signature is computed.
 */
@ApiTags('webhooks')
@Public()
@SkipCsrf()
@WebhookRateLimit()
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly webhooks: PaymentWebhooksService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gateway notification',
    description:
      'For the payment gateway only. The signature over the exact body is verified before anything else, and a refused call is stored nowhere; `:provider` is the configured gateway (`mock` in this build). A verified event is stored once (unique per provider event ID) and applied in the same transaction before the 200: a repeated delivery is acknowledged and changes nothing. Outcomes only move a payment forward (a failure after a success is ignored); a success never changes the booking’s status, only its `paymentStatus`; a success for a closed or already-paid booking is recorded and flagged for operations. An event for an unknown order is stored and acknowledged. Limited per address (120 a minute by default, `RATE_LIMIT_WEBHOOK_PER_MINUTE`; 429 `RATE_LIMITED`).',
  })
  @ApiHeader({ name: 'x-razorpay-signature', required: true })
  @ApiHeader({ name: 'x-razorpay-event-id', required: true })
  @ApiOkResponse({ type: WebhookAckResponseDto })
  @ApiBadRequestResponse({
    description:
      '`WEBHOOK_SIGNATURE_INVALID`, or `VALIDATION_ERROR` for a signed body that is not a well-formed event',
  })
  @ApiNotFoundResponse({ description: 'Not the configured gateway' })
  receive(
    @Param('provider') provider: string,
    @Req() request: Request,
  ): Promise<WebhookAckResponseDto> {
    return this.webhooks.receive(
      provider,
      request.body as unknown,
      request.headers,
    );
  }
}
