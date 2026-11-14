import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Put,
} from '@nestjs/common';
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
  AircraftPricingDto,
  AircraftPricingResponseDto,
  OperatorPricingDto,
  OperatorPricingResponseDto,
} from './dto/operator-pricing.dto.js';
import { OperatorPricingService } from './operator-pricing.service.js';

/**
 * An operator administrator's own pricing inputs (M5 slice 2). Staff cannot
 * read or change prices. Every change is versioned and audited.
 */
@ApiTags('operator-pricing')
@ApiCookieAuth()
@Roles(Role.OPERATOR_ADMIN)
@Controller('operator')
export class OperatorPricingController {
  constructor(private readonly pricing: OperatorPricingService) {}

  @Get('pricing')
  @ApiOperation({ summary: 'Operator-wide pricing defaults' })
  @ApiOkResponse({ type: OperatorPricingResponseDto })
  getOperator(
    @CurrentUser() user: AuthUser,
  ): Promise<OperatorPricingResponseDto> {
    return this.pricing.getOperator(user);
  }

  @Put('pricing')
  @ApiOperation({
    summary: 'Set operator-wide pricing defaults (new rule versions, audited)',
  })
  @ApiOkResponse({ type: OperatorPricingResponseDto })
  setOperator(
    @CurrentUser() user: AuthUser,
    @Body() dto: OperatorPricingDto,
  ): Promise<OperatorPricingResponseDto> {
    return this.pricing.setOperator(user, dto);
  }

  @Get('aircraft/:id/pricing')
  @ApiOperation({ summary: "One aircraft's rate" })
  @ApiOkResponse({ type: AircraftPricingResponseDto })
  getAircraft(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AircraftPricingResponseDto> {
    return this.pricing.getAircraft(user, id);
  }

  @Put('aircraft/:id/pricing')
  @ApiOperation({
    summary: "Set one aircraft's rate (new rule versions, audited)",
  })
  @ApiOkResponse({ type: AircraftPricingResponseDto })
  setAircraft(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: AircraftPricingDto,
  ): Promise<AircraftPricingResponseDto> {
    return this.pricing.setAircraft(user, id, dto);
  }
}
