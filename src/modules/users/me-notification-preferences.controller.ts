import { Body, Controller, Get, Patch } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import {
  NotificationPreferencesResponseDto,
  UpdateNotificationPreferencesDto,
} from './dto/notification-preferences.dto.js';
import { UsersService } from './users.service.js';

/**
 * The caller's own opt-outs from non-mandatory SMS and WhatsApp messages,
 * read by the notification events when choosing channels.
 */
@ApiTags('me')
@ApiCookieAuth()
@Roles(Role.CUSTOMER, Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
@Controller('me/notification-preferences')
export class MeNotificationPreferencesController {
  constructor(private readonly users: UsersService) {}

  @Get()
  @ApiOperation({ summary: 'My SMS and WhatsApp opt-outs' })
  @ApiOkResponse({ type: NotificationPreferencesResponseDto })
  get(
    @CurrentUser() user: AuthUser,
  ): Promise<NotificationPreferencesResponseDto> {
    return this.users.notificationPreferences(user.id);
  }

  @Patch()
  @ApiOperation({ summary: 'Change my SMS and WhatsApp opt-outs' })
  @ApiOkResponse({ type: NotificationPreferencesResponseDto })
  update(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateNotificationPreferencesDto,
  ): Promise<NotificationPreferencesResponseDto> {
    return this.users.updateNotificationPreferences(user.id, {
      smsOptedOut: body.smsOptedOut,
      whatsappOptedOut: body.whatsappOptedOut,
    });
  }
}
