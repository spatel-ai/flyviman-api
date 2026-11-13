import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DevToolsGuard } from '../../integrations/dev-tools.guard.js';
import { Public } from '../auth/auth.decorators.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { ComplianceService } from './compliance.service.js';
import type { ExpiryRunDto } from './dto/expiring-documents.dto.js';

/**
 * Development and test only: runs the daily expiry job, or the notification
 * outbox, now. Answered only
 * with ENABLE_DEV_TOOLS, which production refuses (DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/jobs')
export class DevComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly notifications: NotificationsService,
  ) {}

  @Post('document-expiry-alerts')
  @HttpCode(200)
  run(): Promise<ExpiryRunDto> {
    return this.compliance.runExpiryAlerts();
  }

  /** Sends the notification outbox's due messages now. */
  @Post('notification-outbox')
  @HttpCode(200)
  async outbox(): Promise<{ sent: number }> {
    return { sent: await this.notifications.dispatchDue() };
  }
}
