import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth-user.js';
import { QuoteResponseDto } from '../quotes/dto/quote.dto.js';
import { BookingReferencePipe } from './booking-reference.pipe.js';
import { BookingRequestsService } from './booking-requests.service.js';
import { OverridePriceDto } from './dto/price-override.dto.js';

/**
 * Manual price override (M10): operations, finance and super administrators
 * (security-rbac.md, "Override a price or quote (reason required)").
 */
@ApiTags('admin: bookings')
@ApiCookieAuth()
@Roles(Role.OPS, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin/bookings')
export class AdminPriceOverrideController {
  constructor(private readonly requests: BookingRequestsService) {}

  @Post(':reference/price-override')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Override the price of a booking request with a new quote',
    description:
      'Issues a new quote (`QUOTE`) at `totalMinor`, superseding the open one, which is never edited; the customer accepts or declines it as any quote. Only while the request is `OPERATOR_PENDING`, after the operator has sent a quote, and before anything is paid: otherwise 409 `BOOKING_INVALID_TRANSITION`. Conditions carry over from the latest quote unless given. The booking’s calculation is copied with the override, its reason and who set it (`overrideReason`); Flyviman absorbs the difference. 409 `BOOKING_UNAVAILABLE` when the aircraft can no longer fly the trip. Audited (`booking.price_override`) with before, after and the reason.',
  })
  @ApiOkResponse({ type: QuoteResponseDto })
  override(
    @CurrentUser() user: AuthUser,
    @Param('reference', BookingReferencePipe) reference: string,
    @Body() dto: OverridePriceDto,
  ): Promise<QuoteResponseDto> {
    return this.requests.overridePrice(user, reference, dto);
  }
}
