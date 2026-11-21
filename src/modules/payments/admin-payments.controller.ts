import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PageQueryDto } from '../../common/dto/page-query.dto.js';
import { Paginated } from '../../common/dto/paginated.js';
import {
  Idempotent,
  IdempotencyClaimParam,
} from '../../common/idempotency/idempotency.interceptor.js';
import type { IdempotencyClaim } from '../../common/idempotency/idempotency.store.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import {
  AdminPaymentDto,
  AdminPaymentsQueryDto,
  ResolvePaymentFlagDto,
} from './dto/payment-view.dto.js';
import {
  AdminRefundsQueryDto,
  CreateRefundDto,
  RefundDueItemDto,
  RefundResponseDto,
} from './dto/refund.dto.js';
import { PaymentFlagsService } from './payment-flags.service.js';
import { PaymentReferencePipe } from './payment-reference.pipe.js';
import { ReceiptsService } from './receipts.service.js';
import { RefundsService } from './refunds.service.js';

/**
 * Payments and refunds for finance (M9, W4-1): finance and the super
 * administrator only.
 */
@ApiTags('admin-payments')
@ApiCookieAuth()
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin')
export class AdminPaymentsController {
  constructor(
    private readonly refunds: RefundsService,
    private readonly receipts: ReceiptsService,
    private readonly flags: PaymentFlagsService,
  ) {}

  @Get('payments')
  @ApiOperation({
    summary: 'Payments, newest first',
    description:
      'Filter by `status`, `reviewReason` (payments flagged for a person) or `bookingReference`. Each with its method type, refunds and `reviewReason`.',
  })
  @ApiOkResponse({ type: [AdminPaymentDto] })
  async payments(
    @Query() query: AdminPaymentsQueryDto,
  ): Promise<Paginated<AdminPaymentDto>> {
    const { items, total } = await this.receipts.adminList(query);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  @Post('payments/:reference/resolve-flag')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve a payment flagged AMOUNT_MISMATCH or DUPLICATE_CAPTURE',
    description:
      'Records that finance settled the flag: the amount was checked at the gateway, and any money owed back was refunded through `POST /admin/payments/:reference/refunds`. Moves no money and changes no status; `reviewReason` stays and `reviewResolvedAt` is set. A resolved flag no longer blocks the customer’s erasure (`PAYMENT_UNDER_REVIEW`); a new flag recorded on the payment later clears `reviewResolvedAt` and reopens it. Needs a reason; audited as `payment.flag_resolve`. 409 `PAYMENT_FLAG_NOT_OPEN` when the payment has no such flag or it is already resolved. An unknown reference is 404.',
  })
  @ApiOkResponse({ type: AdminPaymentDto })
  resolveFlag(
    @Param('reference', PaymentReferencePipe) reference: string,
    @Body() body: ResolvePaymentFlagDto,
  ): Promise<AdminPaymentDto> {
    return this.flags.resolve(reference, body.reason);
  }

  @Get('refunds')
  @ApiOperation({
    summary: 'Refunds, newest first',
    description:
      'Filter by `status`. Each with its payment, booking, reason and what is still refundable from the payment.',
  })
  @ApiOkResponse({ type: [RefundResponseDto] })
  async list(
    @Query() query: AdminRefundsQueryDto,
  ): Promise<Paginated<RefundResponseDto>> {
    const { items, total } = await this.refunds.list(query);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  @Post('payments/:reference/refunds')
  @Idempotent()
  @ApiOperation({
    summary: 'Start a refund of a payment, in full or in part',
    description:
      'For a payment whose money arrived (`SUCCEEDED`, `REFUND_PENDING` or `PARTIALLY_REFUNDED`; otherwise 409 `PAYMENT_NOT_REFUNDABLE`), up to what is still refundable: its amount less refunds completed or under way (409 `REFUND_EXCEEDS_REMAINDER`, the remainder in `details`). The refund is recorded `REQUESTED` and the payment and booking `paymentStatus` become `REFUND_PENDING` before the gateway is asked; the answer is the refund as recorded: `PENDING` while the gateway returns the money, `FAILED` if it refused (the amount is refundable again), or still `REQUESTED` if the gateway could not be reached (its notice settles it later; start no second refund for it). The gateway’s notice completes it: the payment becomes `PARTIALLY_REFUNDED` or `REFUNDED`. Audited with the reason. Never changes the booking’s status. A repeat with the same `Idempotency-Key` and body returns the first answer. Another payment’s or an unknown reference is 404.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each refund and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiCreatedResponse({ type: RefundResponseDto })
  create(
    @CurrentUser() user: AuthUser,
    @Param('reference', PaymentReferencePipe) reference: string,
    @Body() body: CreateRefundDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
    @Headers('idempotency-key') key: string,
  ): Promise<RefundResponseDto> {
    return this.refunds.start(user, reference, body, claim, key);
  }

  @Get('refunds/due')
  @ApiOperation({
    summary: 'Payments to refund (the finance queue)',
    description:
      'Oldest first. `CANCELLATION`: a cancelled booking’s refund due (paid less the charge, recorded at cancellation) less refunds made since, spread over its payments; `BOOKING_CLOSED`: a payment that succeeded after the booking expired or was cancelled, or for a booking that could not be confirmed because the trip can no longer be flown as booked; `ALREADY_PAID`: a second payment for a paid booking. Each row is one payment with `dueMinor` to refund; a row leaves the queue once refunds completed or under way cover it. Nothing is refunded automatically. Payments flagged `AMOUNT_MISMATCH` or `DUPLICATE_CAPTURE` are not listed: their extra money is not on a payment this API can refund.',
  })
  @ApiOkResponse({ type: [RefundDueItemDto] })
  async due(
    @Query() query: PageQueryDto,
  ): Promise<Paginated<RefundDueItemDto>> {
    const { items, total } = await this.refunds.due(query.page, query.pageSize);
    return new Paginated(items, query.page, query.pageSize, total);
  }
}
