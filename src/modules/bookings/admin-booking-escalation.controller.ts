import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { BookingEscalationService } from './booking-escalation.service.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import {
  AdminBookingDetailDto,
  BookingEscalationInputDto,
} from './dto/admin-booking.dto.js';

/** Operations' escalation flag on a booking (M8-C). */
@ApiTags('admin-bookings')
@ApiCookieAuth()
@Roles(Role.OPS, Role.SUPER_ADMIN)
@Controller('admin/bookings')
export class AdminBookingEscalationController {
  constructor(private readonly escalation: BookingEscalationService) {}

  @Post(':reference/escalate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Escalate a booking, with a reason',
    description:
      'Flags the booking for operations’ attention (`escalatedAt`, the list’s `escalated=true` filter) without changing its status. `reason` (3–500 characters) is kept on the timeline and in the audit trail (`booking.escalate`). 409 `BOOKING_ESCALATION_CONFLICT` when it is already escalated.',
  })
  @ApiOkResponse({ type: AdminBookingDetailDto })
  escalate(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: BookingEscalationInputDto,
  ): Promise<AdminBookingDetailDto> {
    return this.escalation.escalate(user, reference, body.reason);
  }

  @Post(':reference/resolve-escalation')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Resolve a booking’s escalation, with a note',
    description:
      'Clears the flag. `reason` (3–500 characters) says how it was resolved; kept on the timeline and in the audit trail (`booking.escalation_resolve`). 409 `BOOKING_ESCALATION_CONFLICT` when it is not escalated.',
  })
  @ApiOkResponse({ type: AdminBookingDetailDto })
  resolve(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() body: BookingEscalationInputDto,
  ): Promise<AdminBookingDetailDto> {
    return this.escalation.resolve(user, reference, body.reason);
  }
}
