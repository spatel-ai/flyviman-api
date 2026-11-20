import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DevToolsGuard } from '../../integrations/dev-tools.guard.js';
import { Public } from '../auth/auth.decorators.js';
import { NotificationsService } from './notifications.service.js';

/**
 * Development and test only: sends the queued notifications now instead of
 * waiting for the ten-second dispatcher. Answered only with
 * ENABLE_DEV_TOOLS, which production refuses (DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/jobs')
export class DevNotificationsController {
  constructor(private readonly notifications: NotificationsService) {}

  @Post('notification-outbox')
  @HttpCode(200)
  async run(): Promise<{ sent: number }> {
    return { sent: await this.notifications.dispatchDue() };
  }
}
