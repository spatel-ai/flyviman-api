import { Controller, Get } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { OperatorDashboardResponseDto } from './dto/operator-dashboard.dto.js';
import { OperatorDashboardService } from './operator-dashboard.service.js';

@ApiTags('operator')
@ApiCookieAuth()
@Controller('operator/dashboard')
export class OperatorDashboardController {
  constructor(private readonly dashboard: OperatorDashboardService) {}

  @Get()
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @ApiOperation({
    summary: 'Counts for the operator dashboard',
    description:
      'Open booking requests, quotes sent and expiring, confirmed trips in the next 14 days, fleet and document status, live empty legs, and, for operator administrators only, settlements due and paid in the last 30 days. Staff get only the sections their capabilities open, counted over the aircraft in their reach; other sections are `null`. Counts and settlement sums only: no passenger or medical data.',
  })
  @ApiOkResponse({ type: OperatorDashboardResponseDto })
  get(@CurrentUser() user: AuthUser): Promise<OperatorDashboardResponseDto> {
    return this.dashboard.dashboard(user);
  }
}
