import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import {
  Idempotent,
  IdempotencyClaimParam,
} from '../../common/idempotency/idempotency.interceptor.js';
import type { IdempotencyClaim } from '../../common/idempotency/idempotency.store.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import {
  CancelOperatorBookingDto,
  OperatorBookingCancelledDto,
  OperatorBookingDetailDto,
  OperatorBookingQueryDto,
  OperatorBookingSummaryDto,
  UpdateOperatorBookingStatusDto,
} from './dto/operator-booking.dto.js';
import { OperatorBookingsService } from './operator-bookings.service.js';

/**
 * The operator's bookings (M8-B). Operator administrators, and staff with
 * "manage bookings" (`MANAGE_BOOKINGS`) on the aircraft in their reach, of an
 * approved operator (409 `OPERATOR_NOT_APPROVED`): a missing capability is
 * 403, another operator's booking or one on an aircraft out of reach 404.
 */
@ApiTags('operator-bookings')
@ApiCookieAuth()
@Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
@Controller('operator/bookings')
export class OperatorBookingsController {
  constructor(private readonly bookings: OperatorBookingsService) {}

  @Get()
  @ApiOperation({
    summary: 'Bookings on your aircraft, newest first',
    description:
      'By default the upcoming trips (`CONFIRMED`, `SCHEDULED`); filter by `status`, `aircraftId` and the first departure (`departureFrom`, `departureTo`). Each carries `status` and `paymentStatus` separately, and the customer’s total with its `priceType`. No passenger data.',
  })
  @ApiOkResponse({ type: [OperatorBookingSummaryDto] })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: OperatorBookingQueryDto,
  ): Promise<Paginated<OperatorBookingSummaryDto>> {
    return this.bookings.list(user, query);
  }

  @Get(':reference')
  @ApiOperation({
    summary: 'A booking: trip, statuses, terms, manifest and what you can do',
    description:
      'The manifest (`passengers`, names only) is shown once the booking is `CONFIRMED`, `SCHEDULED` or `COMPLETED`. `actions` says which moves are open now.',
  })
  @ApiOkResponse({ type: OperatorBookingDetailDto })
  detail(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<OperatorBookingDetailDto> {
    return this.bookings.detail(user, reference);
  }

  @Patch(':reference/status')
  @ApiOperation({
    summary: 'Mark a booking scheduled or completed',
    description:
      '`CONFIRMED` → `SCHEDULED`; `SCHEDULED` → `COMPLETED` once the last leg has departed. 409 `BOOKING_INVALID_TRANSITION` from any other status, before departure, or when the booking changed meanwhile. Audited, on the booking’s timeline.',
  })
  @ApiOkResponse({ type: OperatorBookingDetailDto })
  changeStatus(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: UpdateOperatorBookingStatusDto,
  ): Promise<OperatorBookingDetailDto> {
    return this.bookings.changeStatus(user, reference, body.status);
  }

  @Post(':reference/cancel')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({
    summary: 'Cancel a booking you cannot fly, with a reason',
    description:
      'From any status before `COMPLETED`. Moves the booking to `CANCELLED` at once, releases the aircraft’s hold, closes any open quote and change request, and records a completed cancellation with no charge: everything the customer paid is recorded as due back, for Flyviman finance to refund (nothing is refunded here). The reason is kept for you and Flyviman, stored encrypted; the customer is told the booking was cancelled. 409 `BOOKING_NOT_CANCELLABLE` once completed or closed; 409 `BOOKING_PAYMENT_IN_PROGRESS` while a payment waits for the gateway’s final answer. Audited. Answers references, statuses and times only (`GET /operator/bookings/:reference` has the details). A repeat with the same `Idempotency-Key` and body returns the first answer.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each cancellation and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: OperatorBookingCancelledDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: CancelOperatorBookingDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<OperatorBookingCancelledDto> {
    return this.bookings.cancel(user, reference, body.reason, claim);
  }
}
