import { Body, Controller, Get, Put } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth-user.js';
import {
  CancellationTermsService,
  publicTerms,
} from './cancellation-terms.service.js';
import {
  CancellationTierTableDto,
  ChangeCancellationTermsDto,
} from './dto/cancellation-terms.dto.js';

/**
 * Flyviman's cancellation tier table (D-172), one for every operator, for
 * finance and super administrators. Customers see the same terms with every
 * search result.
 */
@ApiTags('admin: pricing')
@ApiCookieAuth()
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin/cancellation-terms')
export class AdminCancellationTermsController {
  constructor(private readonly terms: CancellationTermsService) {}

  @Get()
  @ApiOperation({ summary: 'The cancellation tiers in force' })
  @ApiOkResponse({ type: CancellationTierTableDto })
  async current(): Promise<CancellationTierTableDto> {
    return publicTerms(await this.terms.current());
  }

  @Put()
  @ApiOperation({
    summary: 'Change the cancellation tiers (creates a new version)',
    description:
      'Applies to booking requests made from now on; every booking keeps the terms it was requested on. Identical tiers write nothing. 409 `PRICING_RULE_NOT_CURRENT` when `baseVersion` is no longer the version in force. Audited with before, after and the reason.',
  })
  @ApiOkResponse({ type: CancellationTierTableDto })
  async change(
    @CurrentUser() user: AuthUser,
    @Body() dto: ChangeCancellationTermsDto,
  ): Promise<CancellationTierTableDto> {
    return publicTerms(
      await this.terms.change(user, {
        tiers: dto.tiers.map((tier) => ({
          minHoursBeforeDeparture: tier.minHoursBeforeDeparture,
          chargePercent: tier.chargePercent,
        })),
        baseVersion: dto.baseVersion,
        reason: dto.reason,
      }),
    );
  }
}
