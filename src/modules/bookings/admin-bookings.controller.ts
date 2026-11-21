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
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AdminBookingsService } from './admin-bookings.service.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import {
  AdminBookingDetailDto,
  AdminBookingQueryDto,
  AdminBookingSummaryDto,
  AssignBookingDto,
  OverrideBookingStatusDto,
} from './dto/admin-booking.dto.js';
import {
  BookingNoteDto,
  BookingNoteInputDto,
} from './dto/booking-request.dto.js';

/**
 * Bookings for Flyviman staff (M8). Operations and super administrators
 * read and act; finance reads without passenger details, special requests,
 * internal notes or other free text (rule 8).
 */
@ApiTags('admin-bookings')
@ApiCookieAuth()
@Controller('admin/bookings')
export class AdminBookingsController {
  constructor(private readonly bookings: AdminBookingsService) {}

  @Get()
  @Roles(Role.OPS, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Search all bookings, newest first',
    description:
      'Filters: `q` (the start of a booking reference, or the customer’s exact email address or phone number), `status`, `paymentStatus`, `category`, `operatorId`, `from` and `to` (when the booking was requested). Paged (`pageSize` at most 100).',
  })
  @ApiOkResponse({ type: [AdminBookingSummaryDto] })
  list(
    @Query() query: AdminBookingQueryDto,
  ): Promise<Paginated<AdminBookingSummaryDto>> {
    return this.bookings.list(query);
  }

  @Get(':reference')
  @Roles(Role.OPS, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary:
      'One booking: trip, statuses, timeline, quotes, change requests, payments',
    description:
      'Finance gets `passengers`, `specialRequests` and `notes` as null and change requests without their text.',
  })
  @ApiOkResponse({ type: AdminBookingDetailDto })
  detail(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
  ): Promise<AdminBookingDetailDto> {
    return this.bookings.detail(user, reference);
  }

  @Post(':reference/assign')
  @HttpCode(200)
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Set or remove the operations owner',
    description:
      '`assigneeId`: an active operations user or super administrator (400 `VALIDATION_ERROR` otherwise), or `null` to remove the owner. Audited (`booking.assign`).',
  })
  @ApiOkResponse({ type: AdminBookingDetailDto })
  assign(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: AssignBookingDto,
  ): Promise<AdminBookingDetailDto> {
    return this.bookings.assign(user, reference, body.assigneeId);
  }

  @Post(':reference/notes')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Add an internal note',
    description:
      'For Flyviman operations only: never shown to the customer, the operator or finance. Stored encrypted.',
  })
  @ApiCreatedResponse({ type: BookingNoteDto })
  addNote(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: BookingNoteInputDto,
  ): Promise<BookingNoteDto> {
    return this.bookings.addNote(user, reference, body.note);
  }

  @Patch(':reference/status')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Override the status, with a reason',
    description:
      'Any status to any other, with a `reason` (3–500 characters) kept on the timeline and in the audit trail (before and after). To `CANCELLED` the cancellation terms apply and the refund due is recorded, as for a customer’s cancellation (409 `BOOKING_PAYMENT_IN_PROGRESS` while a payment waits for the gateway’s answer); to `EXPIRED`, `QUOTE_DECLINED` or `OPERATOR_UNAVAILABLE` the aircraft’s hold is released and an open quote closes `EXPIRED`; to `CONFIRMED` the held time is checked again first (409 `BOOKING_UNAVAILABLE`); reopening an ended empty-leg booking while another booking holds the offer is 409 `BOOKING_UNAVAILABLE`. 409 `BOOKING_INVALID_TRANSITION` when the status is unchanged or the booking changed meanwhile.',
  })
  @ApiOkResponse({ type: AdminBookingDetailDto })
  override(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: OverrideBookingStatusDto,
  ): Promise<AdminBookingDetailDto> {
    return this.bookings.overrideStatus(user, reference, body);
  }
}
