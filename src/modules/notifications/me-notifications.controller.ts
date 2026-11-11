import {
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PageQueryDto } from '../../common/dto/page-query.dto.js';
import { Paginated } from '../../common/dto/paginated.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AnyRole, CurrentUser } from '../auth/auth.decorators.js';
import { NotificationResponseDto } from './dto/notification-response.dto.js';
import {
  InAppNotification,
  NotificationsService,
} from './notifications.service.js';

function toDto(item: InAppNotification): NotificationResponseDto {
  return {
    id: item.id,
    templateKey: item.templateKey,
    title: item.title,
    body: item.body,
    readAt: item.readAt?.toISOString() ?? null,
    createdAt: item.createdAt.toISOString(),
  };
}

@ApiTags('me')
@ApiCookieAuth()
@AnyRole()
@Controller('me/notifications')
export class MeNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Get()
  @ApiOperation({ summary: 'In-app notifications, newest first' })
  @ApiOkResponse({ type: [NotificationResponseDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<NotificationResponseDto>> {
    const result = await this.notifications.listInApp(
      user.id,
      query.page,
      query.pageSize,
    );
    return new Paginated(
      result.items.map(toDto),
      result.page,
      result.pageSize,
      result.total,
    );
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  @ApiOkResponse({ type: NotificationResponseDto })
  async read(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<NotificationResponseDto> {
    return toDto(await this.notifications.markRead(user.id, id));
  }
}
