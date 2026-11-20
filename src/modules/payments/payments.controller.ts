import {
  Body,
  Controller,
  Get,
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
import {
  BookingPaymentDto,
  PaymentDetailDto,
  PaymentReceiptDto,
} from './dto/payment-view.dto.js';
import { PaymentReferencePipe } from './payment-reference.pipe.js';
import { PaymentsService } from './payments.service.js';
import { ReceiptsService } from './receipts.service.js';

/**
 * Customer payments (M9). Someone else's booking or payment is 404. Reading
 * a payment and its receipt is also open to finance and the super
 * administrator (security-rbac.md: view receipts).
 */
@ApiTags('payments')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller()
export class PaymentsController {
  constructor(
    private readonly payments: PaymentsService,
    private readonly receipts: ReceiptsService,
  ) {}

  @Get('bookings/:reference/payments')
  @ApiOperation({
    summary: 'The payments of one of the caller’s bookings, with receipts',
    description:
      'Newest first: every attempt with its status, method type, refunds, and `receipt` (null until it has succeeded; the same as `GET /payments/:reference/receipt`). What is due now is the booking’s `amountDue`. Another customer’s booking is 404.',
  })
  @ApiOkResponse({ type: [BookingPaymentDto] })
  forBooking(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<BookingPaymentDto[]> {
    return this.receipts.forBooking(user, reference);
  }

  @Get('payments/:reference')
  @Roles(Role.CUSTOMER, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'One payment, with its refunds',
    description:
      'For the customer who owes it (poll it after checkout), or finance and the super administrator. `status` is the payment’s own; the booking’s `paymentStatus` summarises all its payments. `method` is the method type only (never card details). Refunds carry no reason. Someone else’s payment is 404.',
  })
  @ApiOkResponse({ type: PaymentDetailDto })
  detail(
    @CurrentUser() user: AuthUser,
    @Param('reference', PaymentReferencePipe) reference: string,
  ): Promise<PaymentDetailDto> {
    return this.receipts.detail(user, reference);
  }

  @Get('payments/:reference/receipt')
  @Roles(Role.CUSTOMER, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'The receipt of a payment (not a GST tax invoice)',
    description:
      'For a payment whose money arrived; 409 `PAYMENT_NOT_SUCCEEDED` before that. The issuer (`RECEIPT_ISSUER_*`), the booking reference, the amount labelled `CONFIRMED`, the method type (never card details, rule 10), when it was paid, and its refunds with what was kept. It says, in `notice`, that it is a payment receipt and not a GST tax invoice: the invoice format is not decided (open decision 13). JSON; the web renders it. Someone else’s payment is 404.',
  })
  @ApiOkResponse({ type: PaymentReceiptDto })
  receipt(
    @CurrentUser() user: AuthUser,
    @Param('reference', PaymentReferencePipe) reference: string,
  ): Promise<PaymentReceiptDto> {
    return this.receipts.receipt(user, reference);
  }

  @Post('bookings/:reference/payments')
  @Idempotent()
  @ApiOperation({
    summary: 'Create a gateway order for what the booking owes now',
    description:
      'For a booking `AWAITING_PAYMENT` with a `CONFIRMED` price and nothing paid: model A and B take the full total (B once the operator has accepted), model C the deposit (the category’s percent, rounded up to the next paisa). After a model C deposit (`paymentStatus` `PARTIALLY_PAID`), the balance: the total less what was paid (purpose `BALANCE`), while the booking is `AWAITING_PAYMENT`, `CONFIRMED` or `SCHEDULED` and before the first departure; once it succeeds the booking is `PAID`. 409 `PAYMENT_NOT_DUE` otherwise (`details` says why), 409 `PAYMENT_ALREADY_PAID`, 409 `PAYMENT_AMOUNT_MISMATCH` when `expectedAmountMinor` is not the amount due (the amount due, currency and purpose are in `details`), 502 `PAYMENT_PROVIDER_ERROR`. While a payment for the same amount is `INITIATED` or `PENDING` it is returned again instead of a second order. Open the gateway’s checkout with `checkout`. Never changes the booking’s status. A repeat with the same `Idempotency-Key` and body returns the first answer.',
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
