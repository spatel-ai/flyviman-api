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
  AdminOperatorDetailDto,
  AdminOperatorSummaryDto,
  ListOperatorsDto,
  OperatorDocumentResponseDto,
  ReasonDto,
  VerifyDocumentDto,
} from './dto/operator.dto.js';
import {
  toDocumentDto,
  toProfileDto,
  toSummaryDto,
} from './operator.mappers.js';
import type { OperatorAction } from './operator-transitions.js';
import { OperatorRecord, OperatorsService } from './operators.service.js';

@ApiTags('admin: operators')
@ApiCookieAuth()
@Controller('admin')
export class AdminOperatorsController {
  constructor(private readonly operators: OperatorsService) {}

  @Get('operators')
  @Roles(Role.OPS, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'List operators',
    description: 'Longest-waiting applications first.',
  })
  @ApiOkResponse({ type: [AdminOperatorSummaryDto] })
  async list(
    @Query() query: ListOperatorsDto,
  ): Promise<Paginated<AdminOperatorSummaryDto>> {
    const result = await this.operators.list(query);
    return new Paginated(
      result.items.map(toSummaryDto),
      result.page,
      result.pageSize,
      result.total,
    );
  }

  @Get('operators/:id')
  @Roles(Role.OPS, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'One operator with its compliance documents' })
  @ApiOkResponse({ type: AdminOperatorDetailDto })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminOperatorDetailDto> {
    return this.detailDto(await this.operators.getById(id));
  }

  @Post('operators/:id/approve')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve an operator',
    description: 'The required documents must be verified first. Audited.',
  })
  @ApiOkResponse({ type: AdminOperatorDetailDto })
  approve(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminOperatorDetailDto> {
    return this.act(actor, id, 'approve');
  }

  @Post('operators/:id/reject')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Reject an application',
    description: 'Needs a reason, which the operator sees. Audited.',
  })
  @ApiOkResponse({ type: AdminOperatorDetailDto })
  reject(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<AdminOperatorDetailDto> {
    return this.act(actor, id, 'reject', body.reason);
  }

  @Post('operators/:id/suspend')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Suspend an approved operator',
    description: 'Needs a reason, which the operator sees. Audited.',
  })
  @ApiOkResponse({ type: AdminOperatorDetailDto })
  suspend(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: ReasonDto,
  ): Promise<AdminOperatorDetailDto> {
    return this.act(actor, id, 'suspend', body.reason);
  }

  @Post('operators/:id/reinstate')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({ summary: 'Reinstate a suspended operator' })
  @ApiOkResponse({ type: AdminOperatorDetailDto })
  reinstate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminOperatorDetailDto> {
    return this.act(actor, id, 'reinstate');
  }

  @Post('documents/:id/verify')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Verify or reject a compliance document',
    description: 'A rejection needs a reason. Audited.',
  })
  @ApiOkResponse({ type: OperatorDocumentResponseDto })
  async verifyDocument(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: VerifyDocumentDto,
  ): Promise<OperatorDocumentResponseDto> {
    return toDocumentDto(
      await this.operators.verifyDocument(
        id,
        actor,
        body.decision,
        body.reason,
      ),
    );
  }

  private async act(
    actor: AuthUser,
    id: string,
    action: OperatorAction,
    reason?: string,
  ): Promise<AdminOperatorDetailDto> {
    return this.detailDto(
      await this.operators.transition(actor, id, action, reason),
    );
  }

  private async detailDto(
    operator: OperatorRecord,
  ): Promise<AdminOperatorDetailDto> {
    const [missing, documents] = await Promise.all([
      this.operators.missing(operator),
      this.operators.listDocuments(operator.id),
    ]);
    return Object.assign(toProfileDto(operator, missing), {
      reviewedById: operator.reviewedById,
      createdAt: operator.createdAt.toISOString(),
      documents: documents.map(toDocumentDto),
    });
  }
}
