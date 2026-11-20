import { Body, Controller, Get, HttpCode, Param, Post } from '@nestjs/common';
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
import { BookingRateLimit } from '../../common/rate-limit/rate-limit.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import { BookingsService } from './bookings.service.js';
import {
  BookingCreatedDto,
  BookingResponseDto,
  CreateBookingDto,
  ChangeRequestResponseDto,
} from './dto/booking.dto.js';
import {
  BookingCancelledDto,
  CancelBookingDto,
  CancellationQuoteDto,
  CreateChangeRequestDto,
} from './dto/trips.dto.js';
import { TripsService } from './trips.service.js';

/** Customer bookings (M8). Ownership is the session's; anyone else's is 404. */
@ApiTags('bookings')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('bookings')
export class BookingsController {
  constructor(
    private readonly bookings: BookingsService,
    private readonly trips: TripsService,
  ) {}

  @Post()
  @Idempotent()
  @BookingRateLimit()
  @ApiOperation({
    summary: 'Request a booking from a charter or helicopter search result',
    description:
      'Checks the aircraft and the price again first (business rule 3): 409 `BOOKING_UNAVAILABLE` when the aircraft can no longer fly the trip; 409 `BOOKING_PRICE_CHANGED` when the estimate is not `expectedTotalMinor`, with the new estimate in `details` under the fields `totalMinor`, `currency`, `priceType` and `validUntil` (send it back as `expectedTotalMinor`, with a new key, to agree to it); 422 `BOOKING_PRICE_ON_REQUEST` for a result without a price; 422 `BOOKING_CATEGORY_DISABLED`; 404 for a search or result that is not found (searches are public: any customer may book from one), or a passenger that is not found or not the caller’s; 409 `BOOKING_DUPLICATE` when the caller already has an open request (`REQUESTED` or `OPERATOR_PENDING`) for this aircraft at an overlapping time; 409 `BOOKING_LIMIT_REACHED` when the caller already has the most open requests allowed (5 by default, `BOOKING_MAX_OPEN_PER_CUSTOMER`). Limited per caller (10 per 10 minutes by default; 429 `RATE_LIMITED`). Holds the aircraft for 24 hours (or until the trip ends) while the operator answers. `specialRequests` is stored encrypted. Never confirmed here: charter goes to the operator (`OPERATOR_PENDING`). The answer holds references and statuses only. A repeat with the same `Idempotency-Key` and body returns the first answer.',
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
    @Body() body: CreateBookingDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<BookingCreatedDto> {
    return this.bookings.create(user, body, claim);
  }

  @Get(':reference')
  @ApiOperation({
    summary: 'One of the caller’s bookings: itinerary, price, statuses, terms',
    description:
      'Passengers show only the last four characters of a document number.',
  })
  @ApiOkResponse({ type: BookingResponseDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<BookingResponseDto> {
    return this.bookings.getOwn(user, reference);
  }

  @Get(':reference/cancellation-quote')
  @ApiOperation({
    summary: 'What cancelling now would cost, before the customer commits',
    description:
      'Worked out from the cancellation terms the booking was made on (rule 9) and the notice left before the first departure. A charge is money only when the price is `CONFIRMED` (`amountKnown`); before that the rule that applies is shown and `chargeMinor` is 0. `refundMinor` is what is due back (refunds are made later; nothing moves here), null while the amount paid cannot be read. 409 `BOOKING_NOT_CANCELLABLE` once completed, cancelled or otherwise closed; another customer’s booking is 404.',
  })
  @ApiOkResponse({ type: CancellationQuoteDto })
  cancellationQuote(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<CancellationQuoteDto> {
    return this.trips.cancellationQuote(user, reference);
  }

  @Post(':reference/cancel')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({
    summary: 'Cancel a booking at the charge shown',
    description:
      'Send the `chargeMinor` from the cancellation quote as `expectedChargeMinor`; if the charge differs now, 409 `BOOKING_CANCELLATION_CHANGED` with the current `chargeMinor`, `currency` and `refundMinor` in `details`. Moves the booking to `CANCELLED` at once, records the terms applied and the refund due on its timeline and as a completed cancellation request, closes any open change request, and is audited. 409 `BOOKING_NOT_CANCELLABLE` once completed, cancelled or otherwise closed; another customer’s booking is 404. A repeat with the same `Idempotency-Key` and body returns the first answer.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each cancellation and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: BookingCancelledDto })
  cancel(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: CancelBookingDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<BookingCancelledDto> {
    return this.trips.cancel(user, reference, body, claim);
  }

  @Post(':reference/change-requests')
  @ApiOperation({
    summary: 'Ask for a change to a booking',
    description:
      'Free text, answered by the operator or operations with a note. One open request per booking: 409 `CHANGE_REQUEST_OPEN`. Only while the booking is in progress (requested up to scheduled): 409 `CHANGE_REQUEST_NOT_ALLOWED`. A price change comes as a revised quote. Another customer’s booking is 404.',
  })
  @ApiCreatedResponse({ type: ChangeRequestResponseDto })
  requestChange(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: CreateChangeRequestDto,
  ): Promise<ChangeRequestResponseDto> {
    return this.trips.requestChange(user, reference, body);
  }
}
