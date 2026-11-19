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
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import {
  AdminEmptyLegQueryDto,
  AdminEmptyLegResponseDto,
  EmptyLegReasonDto,
} from './dto/empty-leg.dto.js';
import { EmptyLegsService } from './empty-legs.service.js';

@ApiTags('admin-empty-legs')
@ApiCookieAuth()
@Roles(Role.OPS, Role.SUPER_ADMIN)
@Controller('admin/empty-legs')
export class AdminEmptyLegsController {
  constructor(private readonly emptyLegs: EmptyLegsService) {}

  @Get()
  @ApiOperation({
    summary: 'Offers, including those awaiting review',
    description:
      'Every status; filter with `status=PENDING_REVIEW` for the review queue. Oldest submission first.',
  })
  @ApiOkResponse({ type: [AdminEmptyLegResponseDto] })
  async list(
    @Query() query: AdminEmptyLegQueryDto,
  ): Promise<Paginated<AdminEmptyLegResponseDto>> {
    const page = await this.emptyLegs.adminList(query);
    return new Paginated(
      page.items.map((row) => this.emptyLegs.toAdmin(row)),
      page.page,
      page.pageSize,
      page.total,
    );
  }

  @Post(':id/approve')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve for publication',
    description:
      'From `PENDING_REVIEW` to `PUBLISHED`. Needs an approved operator and aircraft and validity still ahead. Audited; the operator is told.',
  })
  @ApiOkResponse({ type: AdminEmptyLegResponseDto })
  async approve(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminEmptyLegResponseDto> {
    return this.emptyLegs.toAdmin(
      await this.emptyLegs.review(actor, id, 'approve'),
    );
  }

  @Post(':id/reject')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject with reason',
    description:
      'From `PENDING_REVIEW` back to `DRAFT`, with the reason as `reviewNote`. Audited; the operator is told.',
  })
  @ApiOkResponse({ type: AdminEmptyLegResponseDto })
  async reject(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: EmptyLegReasonDto,
  ): Promise<AdminEmptyLegResponseDto> {
    return this.emptyLegs.toAdmin(
      await this.emptyLegs.review(actor, id, 'reject', body.reason),
    );
  }
}
