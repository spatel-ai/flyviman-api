import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DevToolsGuard } from '../../integrations/dev-tools.guard.js';
import { Public } from '../auth/auth.decorators.js';
import type { EmptyLegExpiryRunDto } from './dto/empty-leg.dto.js';
import { EmptyLegsService } from './empty-legs.service.js';

/**
 * Development and test only: runs the empty-leg expiry job now. Answered
 * only with ENABLE_DEV_TOOLS, which production refuses (DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/jobs')
export class DevEmptyLegsController {
  constructor(private readonly emptyLegs: EmptyLegsService) {}

  @Post('empty-leg-expiry')
  @HttpCode(200)
  run(): Promise<EmptyLegExpiryRunDto> {
    return this.emptyLegs.runExpiry();
  }
}
