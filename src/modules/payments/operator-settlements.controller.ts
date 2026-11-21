import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PageQueryDto } from '../../common/dto/page-query.dto.js';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { OperatorSettlementDto } from './dto/settlement.dto.js';
import { SettlementsService } from './settlements.service.js';

/** An operator's own settlements (M9, W4-2): its administrators only. */
@ApiTags('operator-settlements')
@ApiCookieAuth()
@Roles(Role.OPERATOR_ADMIN)
@Controller('operator/settlements')
export class OperatorSettlementsController {
  constructor(private readonly settlements: SettlementsService) {}

  @Get()
  @ApiOperation({
    summary: 'Own settlement records, newest first',
    description:
      'What Flyviman owes the caller’s organisation per completed booking: the money kept, the commission and tax deducted, the payable, its status and, once paid, the bank reference of the payout.',
  })
  @ApiOkResponse({ type: [OperatorSettlementDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<OperatorSettlementDto>> {
    const { items, total } = await this.settlements.operatorList(
      user,
      query.page,
      query.pageSize,
    );
    return new Paginated(items, query.page, query.pageSize, total);
  }
}
