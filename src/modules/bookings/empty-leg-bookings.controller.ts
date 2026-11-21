import { Body, Controller, Post } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import {
  Idempotent,
  IdempotencyClaimParam,
} from '../../common/idempotency/idempotency.interceptor.js';
import type { IdempotencyClaim } from '../../common/idempotency/idempotency.store.js';
import { BookingRateLimit } from '../../common/rate-limit/rate-limit.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { BookingCreatedDto } from './dto/booking.dto.js';
import { CreateEmptyLegBookingDto } from './dto/empty-leg-booking.dto.js';
import { EmptyLegBookingsService } from './empty-leg-bookings.service.js';

/** Customer booking requests for empty-leg offers (M8-C). */
@ApiTags('bookings')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('bookings')
export class EmptyLegBookingsController {
  constructor(private readonly emptyLegBookings: EmptyLegBookingsService) {}

  @Post('empty-leg')
  @Idempotent()
  @BookingRateLimit()
  @ApiOperation({
    summary: 'Request a booking of a listed empty-leg offer',
    description:
      'The offer must be listed (published, still valid, approved operator and aircraft, not requested by anyone else) and its departure window not yet begun; otherwise 409 `BOOKING_UNAVAILABLE`, also when the aircraft is no longer free over the window. 409 `BOOKING_DUPLICATE` when the caller has already requested it. The price is the offer’s, a `QUOTE` (the operator’s own price) until the operator accepts: 409 `BOOKING_PRICE_CHANGED` when it is not `expectedTotalMinor`, with the current price in `details` (`totalMinor`, `currency`, `priceType`, `validUntil`). 409 `BOOKING_TERMS_CHANGED` when Flyviman’s cancellation tiers changed since the offer was shown (rule 9). 400 `VALIDATION_ERROR` when `passengerCount` exceeds the offer’s seats. 422 `BOOKING_CATEGORY_DISABLED`; 409 `BOOKING_LIMIT_REACHED`; 404 for a passenger that is not the caller’s. Limited per caller as `POST /bookings` (429 `RATE_LIMITED`). Holds the aircraft over the departure window (48 hours by default, `BOOKING_HOLD_HOURS`, never past the window’s end) and goes to the operator (`OPERATOR_PENDING`): never confirmed here. The leg’s `departureAt` is the window’s start; the operator confirms the time. The offer becomes `BOOKED` when the booking is confirmed, and is listed again if the request ends first. A repeat with the same `Idempotency-Key` and body returns the first answer.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each booking request and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiCreatedResponse({ type: BookingCreatedDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateEmptyLegBookingDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<BookingCreatedDto> {
    return this.emptyLegBookings.create(user, body, claim);
  }
}
