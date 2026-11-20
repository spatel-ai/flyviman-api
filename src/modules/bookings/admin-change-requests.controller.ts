import {
  Body,
  Controller,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { ChangeRequestResponseDto } from './dto/booking.dto.js';
import { DecideChangeRequestDto } from './dto/trips.dto.js';
import { TripsService } from './trips.service.js';

/** Answers to customers' change requests (M8). */
@ApiTags('admin-bookings')
@ApiCookieAuth()
@Roles(Role.OPS, Role.SUPER_ADMIN)
@Controller('admin/change-requests')
export class AdminChangeRequestsController {
  constructor(private readonly trips: TripsService) {}

  @Post(':id/decide')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve or decline a change request, with a note',
    description:
      'Operations, for any booking. The note is shown to the customer. 409 `CHANGE_REQUEST_DECIDED` when it has already been answered. A price change goes through a revised quote.',
  })
  @ApiOkResponse({ type: ChangeRequestResponseDto })
  decide(
    @CurrentUser() user: AuthUser,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: DecideChangeRequestDto,
  ): Promise<ChangeRequestResponseDto> {
    return this.trips.decide(user, id, body);
  }
}
