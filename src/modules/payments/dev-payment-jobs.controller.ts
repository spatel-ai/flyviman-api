import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DevToolsGuard } from '../../integrations/dev-tools.guard.js';
import { Public } from '../auth/auth.decorators.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';
import { SettlementsService } from './settlements.service.js';

/**
 * Development and test only: runs the payment status sweep or the
 * settlement job now. Answered
 * only with ENABLE_DEV_TOOLS, which production refuses (DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/jobs')
export class DevPaymentJobsController {
  constructor(
    private readonly webhooks: PaymentWebhooksService,
    private readonly settlements: SettlementsService,
  ) {}

  @Post('payment-sweep')
  @HttpCode(200)
  run(): Promise<{ checked: number; applied: number; skipped: boolean }> {
    return this.webhooks.runSweep();
  }

  @Post('settlement-sync')
  @HttpCode(200)
  settlementSync(): Promise<{
    checked: number;
    written: number;
    skipped: boolean;
  }> {
    return this.settlements.runSync();
  }
}
