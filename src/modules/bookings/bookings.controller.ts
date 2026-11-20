import { Body, Controller, Get, Param, Post } from '@nestjs/common';
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
} from './dto/booking.dto.js';

/** Customer bookings (M8). Ownership is the session's; anyone else's is 404. */
@ApiTags('bookings')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('bookings')
export class BookingsController {
  constructor(private readonly bookings: BookingsService) {}

  @Post()
  @Idempotent()
  @BookingRateLimit()
  @ApiOperation({
    summary:
      'Request a booking, or a quote for a result priced on request, from a charter or helicopter search result',
    description:
      'Checks the aircraft and the price again first (business rule 3): 409 `BOOKING_UNAVAILABLE` when the aircraft can no longer fly the trip; 409 `BOOKING_PRICE_CHANGED` when the estimate is not `expectedTotalMinor`, with the new estimate in `details` under the fields `totalMinor`, `currency`, `priceType` and `validUntil` (send it back as `expectedTotalMinor`, with a new key, to agree to it); a result priced on request (`price: null`) is requested without `expectedTotalMinor` and asks the operator for a quote (409 `BOOKING_PRICE_CHANGED` with `details` (field `price`, issue `ON_REQUEST`) when an amount is sent for a result now on request, and with the new estimate when none is sent for a result now priced); 422 `BOOKING_CATEGORY_DISABLED`; 404 for a search or result that is not found (searches are public: any customer may book from one), or a passenger that is not found or not the caller’s; 409 `BOOKING_DUPLICATE` when the caller already has an open request (`REQUESTED` or `OPERATOR_PENDING`) for this aircraft at an overlapping time; 409 `BOOKING_LIMIT_REACHED` when the caller already has the most open requests allowed (5 by default, `BOOKING_MAX_OPEN_PER_CUSTOMER`). Limited per caller (10 per 10 minutes by default; 429 `RATE_LIMITED`). Holds the aircraft for 48 hours by default (`BOOKING_HOLD_HOURS`, never past the trip’s end) while the operator answers. `specialRequests` is stored encrypted. Never confirmed here: charter goes to the operator (`OPERATOR_PENDING`). The answer holds references and statuses only. A repeat with the same `Idempotency-Key` and body returns the first answer.',
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
}
