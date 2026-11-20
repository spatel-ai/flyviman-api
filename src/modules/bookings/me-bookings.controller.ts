import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { TripSummaryDto, TripsQueryDto } from './dto/trips.dto.js';
import { TripsService } from './trips.service.js';

/** The customer's trips (M8): their own bookings only. */
@ApiTags('bookings')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('me/bookings')
export class MeBookingsController {
  constructor(private readonly trips: TripsService) {}

  @Get()
  @ApiOperation({
    summary: 'The caller’s trips, upcoming or past, newest first',
    description:
      'Summary rows only: no passengers or special requests (`GET /bookings/:reference` has those). `view=upcoming` lists bookings in progress (`REQUESTED` up to `SCHEDULED`); `view=past` the rest. At most 50 per page.',
  })
  @ApiOkResponse({ type: [TripSummaryDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: TripsQueryDto,
  ): Promise<Paginated<TripSummaryDto>> {
    const { items, total } = await this.trips.list(user, query);
    return new Paginated(items, query.page, query.pageSize, total);
  }
}
