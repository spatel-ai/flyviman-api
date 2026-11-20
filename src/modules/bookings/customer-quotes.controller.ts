import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Injectable,
  Param,
  Post,
  type PipeTransform,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AppException } from '../../common/errors/app.exception.js';
import {
  Idempotent,
  IdempotencyClaimParam,
} from '../../common/idempotency/idempotency.interceptor.js';
import type { IdempotencyClaim } from '../../common/idempotency/idempotency.store.js';
import { QUOTE_REFERENCE } from '../../common/reference.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { QuoteResponseDto } from '../quotes/dto/quote.dto.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import { BookingRequestsService } from './booking-requests.service.js';
import {
  BookingMessageDto,
  BookingMessageInputDto,
} from './dto/booking-request.dto.js';

/** A path's quote reference; anything else is a quote that is not found. */
@Injectable()
export class QuoteReferencePipe implements PipeTransform<string, string> {
  transform(value: string): string {
    const reference = value.toUpperCase();
    if (!QUOTE_REFERENCE.test(reference)) {
      throw new AppException(
        'NOT_FOUND',
        'Quote not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return reference;
  }
}

/**
 * The customer's side of a quote (M8). Ownership is the session's, through
 * the quote's booking: anyone else's quote is 404.
 */
@ApiTags('quotes')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('quotes')
export class CustomerQuotesController {
  constructor(private readonly requests: BookingRequestsService) {}

  @Get(':reference')
  @ApiOperation({
    summary: 'A quote: price (`QUOTE`), conditions, validity',
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param('reference', QuoteReferencePipe) reference: string,
  ): Promise<QuoteResponseDto> {
    return this.requests.customerQuote(user, reference);
  }

  @Post(':reference/accept')
  @HttpCode(200)
  @Idempotent()
  @ApiOperation({
    summary: 'Accept a quote',
    description:
      'The quote becomes `ACCEPTED` with its price `CONFIRMED`, and the booking `PRICE_CONFIRMED` at the quoted price, on the quote’s cancellation conditions (shown before you commit). The aircraft is checked again first (409 `BOOKING_UNAVAILABLE`). 409 `QUOTE_EXPIRED` past `validUntil`; 409 `QUOTE_INVALID_TRANSITION` for a quote already answered or replaced by a revision; 409 `BOOKING_INVALID_TRANSITION` when the booking is not waiting for this answer. A repeat with the same `Idempotency-Key` returns the first answer.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each acceptance and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  accept(
    @CurrentUser() user: AuthUser,
    @Param('reference', QuoteReferencePipe) reference: string,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<QuoteResponseDto> {
    return this.requests.acceptQuote(user, reference, claim);
  }

  @Post(':reference/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Decline a quote',
    description:
      'The quote becomes `REJECTED` and the booking `QUOTE_DECLINED`; the aircraft’s hold is released. Same 409 answers as accept.',
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  reject(
    @CurrentUser() user: AuthUser,
    @Param('reference', QuoteReferencePipe) reference: string,
  ): Promise<QuoteResponseDto> {
    return this.requests.rejectQuote(user, reference);
  }
}

/** Quotes and the operator's questions on one of the customer's bookings. */
@ApiTags('bookings')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('bookings')
export class BookingConversationController {
  constructor(private readonly requests: BookingRequestsService) {}

  @Get(':reference/quotes')
  @ApiOperation({
    summary: 'The quotes sent on one of your bookings, newest first',
  })
  @ApiOkResponse({ type: [QuoteResponseDto] })
  quotes(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<QuoteResponseDto[]> {
    return this.requests.customerQuotes(user, reference);
  }

  @Get(':reference/messages')
  @ApiOperation({
    summary: 'The operator’s questions and your answers, oldest first',
  })
  @ApiOkResponse({ type: [BookingMessageDto] })
  messages(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<BookingMessageDto[]> {
    return this.requests.customerMessages(user, reference);
  }

  @Post(':reference/messages')
  @ApiOperation({
    summary: 'Answer the operator’s question',
    description:
      'Moves `CLARIFICATION_REQUESTED` back to `OPERATOR_PENDING` (409 `BOOKING_INVALID_TRANSITION` from another status) and keeps the aircraft held another 48 hours if the time is still free. Stored encrypted. Answers with the whole conversation.',
  })
  @ApiCreatedResponse({ type: [BookingMessageDto] })
  answer(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: BookingMessageInputDto,
  ): Promise<BookingMessageDto[]> {
    return this.requests.answer(user, reference, body.message);
  }
}
