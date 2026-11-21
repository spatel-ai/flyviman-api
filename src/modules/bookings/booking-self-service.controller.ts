import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
} from '@nestjs/common';
import {
  ApiCookieAuth,
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
import {
  BookingPassengersService,
  PASSENGER_CUTOFF_HOURS,
} from './booking-passengers.service.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import { BookingRevalidationService } from './booking-revalidation.service.js';
import { BookingTimelineService } from './booking-timeline.service.js';
import {
  BookingRevalidationDto,
  CustomerBookingEventDto,
  PassengersReplacedDto,
  ReplacePassengersDto,
} from './dto/customer-booking.dto.js';

/**
 * The customer's own booking (M8): its timeline, its passengers and a
 * recheck before paying. Ownership is the session's; anyone else's is 404.
 */
@ApiTags('bookings')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('bookings')
export class BookingSelfServiceController {
  constructor(
    private readonly timeline: BookingTimelineService,
    private readonly passengers: BookingPassengersService,
    private readonly revalidation: BookingRevalidationService,
  ) {}

  @Get(':reference/events')
  @ApiOperation({
    summary: 'The booking’s timeline as the customer sees it, oldest first',
    description:
      'Status changes, quotes sent (with the quoted total as a `QUOTE`), payment status changes, the operator’s questions and the customer’s answers (the words are in `GET /bookings/:reference/messages`), change requests with their details and the answers with their notes. Never internal notes, the operator’s reasons, override reasons or who did it beyond `YOU`, `OPERATOR`, `FLYVIMAN` or `SYSTEM`. Another customer’s booking is 404.',
  })
  @ApiOkResponse({ type: [CustomerBookingEventDto] })
  events(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<CustomerBookingEventDto[]> {
    return this.timeline.events(user, reference);
  }

  @Put(':reference/passengers')
  @Idempotent()
  @ApiOperation({
    summary: 'Replace the booking’s passengers with saved passengers',
    description: `Copies the saved passengers (\`passengerIds\`, the caller’s own, 404 otherwise) onto the booking as they are now, replacing those it had: at least one, at most the trip’s passenger count (400 \`VALIDATION_ERROR\`). Only from \`REQUESTED\` up to \`CONFIRMED\` and until ${PASSENGER_CUTOFF_HOURS} hours before the first departure: 409 \`BOOKING_PASSENGERS_LOCKED\` otherwise. Document numbers and assistance notes are stored encrypted; audited with passenger counts only. Answers the reference and the passenger count only (\`GET /bookings/:reference\` has the details). A repeat with the same \`Idempotency-Key\` and body returns the first answer. Another customer’s booking is 404.`,
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each change and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: PassengersReplacedDto })
  replacePassengers(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: ReplacePassengersDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<PassengersReplacedDto> {
    return this.passengers.replace(user, reference, body, claim);
  }

  @Post(':reference/revalidate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Check the booking again before paying (rule 3)',
    description:
      'Whether the trip can still be flown as booked (the trip ahead, the operator and aircraft approved and in service, the held time free), with the same check the confirmation rule makes; `reason` when not (`CLOSED` for a booking completed, cancelled or otherwise ended). Answers the labelled price, `priceExpired` for an estimate past its validity, and `amountDue` (null when the trip is not available). A `CONFIRMED` price is never repriced. Nothing is written. Another customer’s booking is 404.',
  })
  @ApiOkResponse({ type: BookingRevalidationDto })
  revalidate(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<BookingRevalidationDto> {
    return this.revalidation.revalidate(user, reference);
  }
}
