import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AdminPricingService } from './admin-pricing.service.js';
import {
  CreatePricingRuleDto,
  DeactivatePricingRuleDto,
  ListPriceCalculationsDto,
  ListPricingRulesDto,
  PriceCalculationDetailDto,
  PriceCalculationSummaryDto,
  PricingRuleResponseDto,
  UpdatePricingRuleDto,
} from './dto/admin-pricing.dto.js';

/**
 * Flyviman's commercial settings: commission, tax, minimum charge and the
 * engine's platform defaults (M5 slice 3). Finance and super administrators.
 */
@ApiTags('admin: pricing')
@ApiCookieAuth()
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin/pricing-rules')
export class AdminPricingRulesController {
  constructor(private readonly pricing: AdminPricingService) {}

  @Get()
  @ApiOperation({
    summary: 'List pricing rules',
    description:
      'Platform and category rules. `active=true` (default): in force now; `active=false`: every version.',
  })
  @ApiOkResponse({ type: [PricingRuleResponseDto] })
  async list(
    @Query() query: ListPricingRulesDto,
  ): Promise<Paginated<PricingRuleResponseDto>> {
    const { items, total } = await this.pricing.listRules(query);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a pricing rule',
    description:
      'Takes effect at once. One rule per type and scope: 409 `PRICING_RULE_EXISTS` when one is in force. Audited with the reason.',
  })
  @ApiCreatedResponse({ type: PricingRuleResponseDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePricingRuleDto,
  ): Promise<PricingRuleResponseDto> {
    return this.pricing.createRule(user, dto);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a pricing rule (creates a new version)',
    description:
      'Closes the version in force and creates the next; identical settings write nothing. 409 `PRICING_RULE_NOT_CURRENT` if it was changed or ended meanwhile. Audited with before, after and the reason.',
  })
  @ApiOkResponse({ type: PricingRuleResponseDto })
  change(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdatePricingRuleDto,
  ): Promise<PricingRuleResponseDto> {
    return this.pricing.changeRule(user, id, dto.config, dto.reason);
  }

  @Post(':id/deactivate')
  @HttpCode(200)
  @ApiOperation({
    summary: 'End a pricing rule',
    description:
      'Category rules only; the platform default then applies. Platform rules answer 409 `PRICING_RULE_REQUIRED`. Audited with the reason.',
  })
  @ApiOkResponse({ type: PricingRuleResponseDto })
  deactivate(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: DeactivatePricingRuleDto,
  ): Promise<PricingRuleResponseDto> {
    return this.pricing.deactivateRule(id, dto.reason);
  }
}

/**
 * Stored engine prices, for explaining any estimate a customer saw. Operator
 * payable, platform revenue, rule settings and line bases are for finance and
 * super administrators only (pricing-engine.md, output).
 */
@ApiTags('admin: pricing')
@ApiCookieAuth()
@Roles(Role.OPS, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin/price-calculations')
export class AdminPriceCalculationsController {
  constructor(private readonly pricing: AdminPricingService) {}

  @Get()
  @ApiOperation({ summary: 'List stored price calculations, newest first' })
  @ApiOkResponse({ type: [PriceCalculationSummaryDto] })
  async list(
    @Query() query: ListPriceCalculationsDto,
  ): Promise<Paginated<PriceCalculationSummaryDto>> {
    const { items, total } = await this.pricing.listCalculations(query);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  @Get(':id')
  @ApiOperation({ summary: 'One calculation: inputs, rules and breakdown' })
  @ApiOkResponse({ type: PriceCalculationDetailDto })
  detail(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<PriceCalculationDetailDto> {
    return this.pricing.calculation(user, id);
  }
}
