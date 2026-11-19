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
  @ApiOperation({
    summary: 'Request a booking from a charter or helicopter search result',
    description:
      'Checks the aircraft and the price again first (business rule 3): 409 `BOOKING_UNAVAILABLE` when the aircraft can no longer fly the trip; 409 `BOOKING_PRICE_CHANGED` when the estimate is not `expectedTotalMinor`, with the new estimate in `details` under the fields `totalMinor`, `currency`, `priceType` and `validUntil` (send it back as `expectedTotalMinor`, with a new key, to agree to it); 422 `BOOKING_PRICE_ON_REQUEST` for a result without a price; 422 `BOOKING_CATEGORY_DISABLED`; 404 for a search, result or passenger that is not found or not the caller’s. Holds the aircraft for 24 hours (or until the trip ends) while the operator answers. Never confirmed here: charter goes to the operator (`OPERATOR_PENDING`). The answer holds references and statuses only. A repeat with the same `Idempotency-Key` and body returns the first answer.',
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
