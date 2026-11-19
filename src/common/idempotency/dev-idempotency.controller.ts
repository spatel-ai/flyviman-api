import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DevToolsGuard } from '../../integrations/dev-tools.guard.js';
import { Public } from '../../modules/auth/auth.decorators.js';
import { IdempotencyPurge } from './idempotency-purge.js';

/**
 * Development and test only: runs the daily idempotency key purge now.
 * Answered only with ENABLE_DEV_TOOLS, which production refuses.
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/jobs')
export class DevIdempotencyController {
  constructor(private readonly purge: IdempotencyPurge) {}

  @Post('idempotency-purge')
  @HttpCode(200)
  run(): Promise<{ deleted: number; skipped: boolean }> {
    return this.purge.run();
  }
}
