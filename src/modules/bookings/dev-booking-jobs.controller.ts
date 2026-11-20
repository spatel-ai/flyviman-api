import { Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { DevToolsGuard } from '../../integrations/dev-tools.guard.js';
import { Public } from '../auth/auth.decorators.js';
import { BookingRequestsService } from './booking-requests.service.js';

/**
 * Development and test only: runs the booking hold-expiry job now. Answered
 * only with ENABLE_DEV_TOOLS, which production refuses (DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/jobs')
export class DevBookingJobsController {
  constructor(private readonly requests: BookingRequestsService) {}

  @Post('booking-hold-expiry')
  @HttpCode(200)
  run(): Promise<{
    quotesExpired: number;
    requestsClosed: number;
    skipped: boolean;
  }> {
    return this.requests.runHoldExpiry();
  }
}
