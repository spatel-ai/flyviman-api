import {
  Body,
  Controller,
  Get,
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
  OperatorQuoteResponseDto,
  ReviseQuoteDto,
} from '../quotes/dto/quote.dto.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import { BookingRequestsService } from './booking-requests.service.js';
import {
  BookingMessageInputDto,
  BookingNoteDto,
  BookingNoteInputDto,
  OperatorBookingRequestDetailDto,
  OperatorBookingRequestDto,
  OperatorBookingRequestQueryDto,
  RejectBookingRequestDto,
} from './dto/booking-request.dto.js';

const IDEMPOTENCY_HEADER = {
  name: 'Idempotency-Key',
  required: true,
  description: 'A UUID, new for each acceptance and reused on retry.',
  schema: { type: 'string', format: 'uuid' },
} as const;

/**
 * The operator's booking request inbox (M8). Operator administrators, and
 * staff with "manage bookings" (`MANAGE_BOOKINGS`) on the aircraft in their
 * reach (D-049): a missing capability is 403, another operator's request or
 * one on an aircraft out of reach 404. No passenger identity is shown.
 */
@ApiTags('operator-booking-requests')
@ApiCookieAuth()
@Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
@Controller('operator')
export class OperatorBookingRequestsController {
  constructor(private readonly requests: BookingRequestsService) {}

  @Get('booking-requests')
  @ApiOperation({
    summary: 'Booking requests for your aircraft, newest first',
    description:
      'By default the requests waiting for you (`OPERATOR_PENDING`, `CLARIFICATION_REQUESTED`); filter by `status` and `aircraftId`. Each carries the proposed price (null when priced on request), when the hold lapses, and the newest quote.',
  })
  @ApiOkResponse({ type: [OperatorBookingRequestDto] })
  list(
    @CurrentUser() user: AuthUser,
    @Query() query: OperatorBookingRequestQueryDto,
  ): Promise<Paginated<OperatorBookingRequestDto>> {
    return this.requests.operatorList(user, query);
  }

  @Get('booking-requests/:reference')
  @ApiOperation({
    summary:
      'A booking request: trip, proposed price, quotes, questions, notes',
  })
  @ApiOkResponse({ type: OperatorBookingRequestDetailDto })
  detail(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<OperatorBookingRequestDetailDto> {
    return this.requests.operatorDetail(user, reference);
  }

  @Post('booking-requests/:reference/accept')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({
    summary: 'Accept the request at its proposed price',
    description:
      'Moves `OPERATOR_PENDING` to `PRICE_CONFIRMED` and at once on to `AWAITING_PAYMENT` (every payment model asks for payment then): the price becomes `CONFIRMED` on the terms the customer was shown, and your acceptance is recorded. Checks first that your company and the aircraft are still approved (409 `OPERATOR_NOT_APPROVED`, `AIRCRAFT_NOT_APPROVED`) and the held time still free and ahead (409 `BOOKING_UNAVAILABLE`); the hold is kept another 48 hours (`BOOKING_HOLD_HOURS`). 409 `BOOKING_INVALID_TRANSITION` from another status, for a request priced on request (send a quote) or while a quote waits for the customer. A repeat with the same `Idempotency-Key` returns the first answer. Audited; the customer is notified.',
  })
  @ApiHeader(IDEMPOTENCY_HEADER)
  @ApiOkResponse({ type: OperatorBookingRequestDetailDto })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<OperatorBookingRequestDetailDto> {
    return this.requests.accept(user, reference, claim);
  }

  @Post('booking-requests/:reference/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject the request with a reason',
    description:
      'Moves `OPERATOR_PENDING` to `OPERATOR_UNAVAILABLE`; an open quote closes as `EXPIRED` and the aircraft’s hold is released. The reason is kept for you and Flyviman, not shown to the customer, who is told the request was not accepted. 409 `BOOKING_INVALID_TRANSITION` from another status.',
  })
  @ApiOkResponse({ type: OperatorBookingRequestDetailDto })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: RejectBookingRequestDto,
  ): Promise<OperatorBookingRequestDetailDto> {
    return this.requests.reject(user, reference, body.reason);
  }

  @Post('booking-requests/:reference/clarify')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Ask the customer a question',
    description:
      'Moves `OPERATOR_PENDING` to `CLARIFICATION_REQUESTED`; the customer’s answer returns it to `OPERATOR_PENDING`. The hold is kept another 48 hours for the answer; unanswered by then, the request expires. 409 `BOOKING_INVALID_TRANSITION` from another status.',
  })
  @ApiOkResponse({ type: OperatorBookingRequestDetailDto })
  clarify(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: BookingMessageInputDto,
  ): Promise<OperatorBookingRequestDetailDto> {
    return this.requests.clarify(user, reference, body.message);
  }

  @Post('booking-requests/:reference/revise-quote')
  @ApiOperation({
    summary: 'Send a quote, or a revision that replaces the open one',
    description:
      'Only while the request is `OPERATOR_PENDING` (409 `BOOKING_INVALID_TRANSITION`). The quote is `SENT` with `priceType` `QUOTE`; an open quote is `SUPERSEDED` (a sent quote is never edited). Valid for 48 hours (`BOOKING_HOLD_HOURS`) unless `validUntil` is given (at least an hour ahead, never after departure; 400 otherwise); the hold is kept as long. The body carries the operator’s price (`operatorPriceMinor`, before Flyviman’s charges and tax); Flyviman’s pricing rules add commission, fees and tax and store the calculation, and the customer sees the total only. The quote carries the cancellation terms the request was made on (D-172). Checks approval and the held time like accept (409 `OPERATOR_NOT_APPROVED`, `AIRCRAFT_NOT_APPROVED`, `BOOKING_UNAVAILABLE`). Audited; the customer is notified.',
  })
  @ApiCreatedResponse({ type: OperatorQuoteResponseDto })
  reviseQuote(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: ReviseQuoteDto,
  ): Promise<OperatorQuoteResponseDto> {
    return this.requests.reviseQuote(user, reference, body);
  }

  @Post('bookings/:reference/notes')
  @ApiOperation({
    summary: 'Add an internal note to a booking',
    description:
      'Kept with the booking for your team; never shown to the customer. Stored encrypted.',
  })
  @ApiCreatedResponse({ type: BookingNoteDto })
  addNote(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: BookingNoteInputDto,
  ): Promise<BookingNoteDto> {
    return this.requests.addNote(user, reference, body.note);
  }
}
