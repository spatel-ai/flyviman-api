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
import { SkipThrottle } from '@nestjs/throttler';
import type { Request } from 'express';
import { Public, SkipCsrf } from '../auth/auth.decorators.js';
import { WebhookAckResponseDto } from './dto/webhook-ack-response.dto.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';

/**
 * Called by the payment gateway, not by a browser: authorised by the
 * signature over the raw body (app.setup.ts keeps it unparsed), so no
 * session, no CSRF check and no per-address limit.
 */
@ApiTags('webhooks')
@Public()
@SkipCsrf()
@SkipThrottle()
@Controller('webhooks/payments')
export class PaymentWebhooksController {
  constructor(private readonly webhooks: PaymentWebhooksService) {}

  @Post(':provider')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Gateway notification',
    description:
      'For the payment gateway only. The signature over the exact body is verified before anything else; `:provider` is the configured gateway (`mock` in this build). Records nothing yet.',
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
  ): WebhookAckResponseDto {
    return this.webhooks.receive(
      provider,
      request.body as unknown,
      request.headers,
    );
  }
}
