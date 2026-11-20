import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  Idempotent,
  IdempotencyClaimParam,
} from '../../common/idempotency/idempotency.interceptor.js';
import type { IdempotencyClaim } from '../../common/idempotency/idempotency.store.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { BookingReferencePipe } from '../bookings/booking-reference.pipe.js';
import {
  CreatePaymentDto,
  PaymentResponseDto,
  VerifyPaymentDto,
} from './dto/payment.dto.js';
import { PaymentReferencePipe } from './payment-reference.pipe.js';
import { PaymentsService } from './payments.service.js';

/** Customer payments (M9). Someone else's booking or payment is 404. */
@ApiTags('payments')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller()
export class PaymentsController {
  constructor(private readonly payments: PaymentsService) {}

  @Post('bookings/:reference/payments')
  @Idempotent()
  @ApiOperation({
    summary: 'Create a gateway order for what the booking owes now',
    description:
      'Only for a booking `AWAITING_PAYMENT` with a `CONFIRMED` price and nothing paid: model A and B take the full total (B once the operator has accepted), model C the deposit (the category’s percent, rounded up to the next paisa). 409 `PAYMENT_NOT_DUE` otherwise (`details` says why), 409 `PAYMENT_ALREADY_PAID`, 409 `PAYMENT_AMOUNT_MISMATCH` when `expectedAmountMinor` is not the amount due (the amount due, currency and purpose are in `details`), 502 `PAYMENT_PROVIDER_ERROR`. While a payment for the same amount is `INITIATED` or `PENDING` it is returned again instead of a second order. Open the gateway’s checkout with `checkout`. Never changes the booking’s status. A repeat with the same `Idempotency-Key` and body returns the first answer.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each payment attempt and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiCreatedResponse({ type: PaymentResponseDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: CreatePaymentDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
    @Headers('idempotency-key') key: string,
  ): Promise<PaymentResponseDto> {
    return this.payments.createOrder(user, reference, body, claim, key);
  }

  @Post('payments/:reference/verify')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Report the checkout result',
    description:
      'The signature is checked through the gateway (400 `PAYMENT_SIGNATURE_INVALID`, also for another order’s result). Not final: a valid result makes the payment `PENDING` at most; only the gateway’s verified notice makes it `SUCCEEDED` or `FAILED`, so poll the booking’s `paymentStatus`. Repeating it changes nothing.',
  })
  @ApiOkResponse({ type: PaymentResponseDto })
  verify(
    @CurrentUser() user: AuthUser,
    @Param('reference', PaymentReferencePipe) reference: string,
    @Body() body: VerifyPaymentDto,
  ): Promise<PaymentResponseDto> {
    return this.payments.verify(user, reference, body);
  }
}
