import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
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
import {
  CreatePromotionDto,
  EndPromotionDto,
  ListPromotionsDto,
  PromotionResponseDto,
} from './dto/promotion.dto.js';
import { PromotionsService } from './promotions.service.js';

/**
 * Promotion codes (M10), for finance and super administrators
 * (security-rbac.md: "Configure commission, markup, fees, tax, promotions").
 * Created and ended, never edited, so a price that used one stays
 * explainable. Automatic discounts are the `DISCOUNT` pricing rule.
 */
@ApiTags('admin: pricing')
@ApiCookieAuth()
@Roles(Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin/promotions')
export class AdminPromotionsController {
  constructor(private readonly promotions: PromotionsService) {}

  @Get()
  @ApiOperation({
    summary: 'List promotion codes, newest first',
    description:
      '`status`: `SCHEDULED` (not started), `ACTIVE`, `ENDED` (past `endsAt` or ended early). Each carries its `uses` so far.',
  })
  @ApiOkResponse({ type: [PromotionResponseDto] })
  async list(
    @Query() query: ListPromotionsDto,
  ): Promise<Paginated<PromotionResponseDto>> {
    const { items, total } = await this.promotions.list(query);
    return new Paginated(items, query.page, query.pageSize, total);
  }

  @Post()
  @ApiOperation({
    summary: 'Create a promotion code',
    description:
      'A percentage (`percent`) or a fixed amount (`amountMinor`) off the price before tax, funded by Flyviman and limited, with any `DISCOUNT` rule, to its charges on the trip. Optional category and route (both ends, either direction), validity window, caps overall and per customer. 409 `PROMOTION_CODE_EXISTS`. Audited (`promotion.create`) with the reason.',
  })
  @ApiCreatedResponse({ type: PromotionResponseDto })
  create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreatePromotionDto,
  ): Promise<PromotionResponseDto> {
    return this.promotions.create(user, dto);
  }

  @Post(':id/end')
  @HttpCode(200)
  @ApiOperation({
    summary: 'End a promotion now',
    description:
      'The code stops applying at once; bookings already made keep their price. 409 `PROMOTION_ENDED` when it has already ended. Audited (`promotion.end`) with before, after and the reason.',
  })
  @ApiOkResponse({ type: PromotionResponseDto })
  end(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: EndPromotionDto,
  ): Promise<PromotionResponseDto> {
    return this.promotions.end(id, dto.reason);
  }
}
