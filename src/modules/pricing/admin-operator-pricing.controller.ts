import { Controller, Get, Param, ParseUUIDPipe } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import { AdminOperatorPricingDto } from './dto/operator-pricing.dto.js';
import { OperatorPricingService } from './operator-pricing.service.js';

/**
 * The internal read of an operator's pricing inputs (M10): read-only, for
 * operations, finance and super administrators (security-rbac.md). Nothing
 * here changes an operator's rates.
 */
@ApiTags('admin: pricing')
@ApiCookieAuth()
// Operators' rates are commercial: finance and super admin only (owner,
// 2026-11-20).
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin/operators')
export class AdminOperatorPricingController {
  constructor(private readonly pricing: OperatorPricingService) {}

  @Get(':id/pricing')
  @ApiOperation({
    summary: "An operator's rates and charges (read-only)",
    description:
      'The operator-wide defaults and each aircraft’s rate in force now, as the operator set them. Finance and super administrators only (403 for operations). 404 for an unknown operator.',
  })
  @ApiOkResponse({ type: AdminOperatorPricingDto })
  get(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminOperatorPricingDto> {
    return this.pricing.adminView(id);
  }
}
