import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DevToolsGuard } from '../../integrations/dev-tools.guard.js';
import { Public } from '../auth/auth.decorators.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';

/**
 * Development and test only: runs the payment status sweep now. Answered
 * only with ENABLE_DEV_TOOLS, which production refuses (DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/jobs')
export class DevPaymentJobsController {
  constructor(private readonly webhooks: PaymentWebhooksService) {}

  @Post('payment-sweep')
  @HttpCode(200)
  run(): Promise<{ checked: number; applied: number; skipped: boolean }> {
    return this.webhooks.runSweep();
  }
}
