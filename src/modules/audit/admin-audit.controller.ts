import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AuditService } from './audit.service.js';
import { canReadAuditContents } from './audit-visibility.js';
import { AuditLogResponseDto } from './dto/audit-log-response.dto.js';
import { ListAuditLogsDto } from './dto/list-audit-logs.dto.js';

@ApiTags('admin: audit')
@ApiCookieAuth()
@Controller('admin/audit-logs')
export class AdminAuditController {
  constructor(private readonly audit: AuditService) {}

  @Get()
  @Roles(Role.OPS, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'List audit records',
    description:
      'Newest first. Filter by entity, actor, action and time range. ' +
      'Pricing rule records show before, after and reason to finance and ' +
      'super admins only; other roles get null for those fields.',
  })
  @ApiOkResponse({ type: [AuditLogResponseDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListAuditLogsDto,
  ): Promise<Paginated<AuditLogResponseDto>> {
    const result = await this.audit.list(query);
    return new Paginated(
      result.items.map((log) => {
        const readable = canReadAuditContents(log.entityType, user.role);
        return {
          id: log.id,
          actorId: log.actorId,
          actorRole: log.actorRole,
          action: log.action,
          entityType: log.entityType,
          entityId: log.entityId,
          before: readable ? log.before : null,
          after: readable ? log.after : null,
          reason: readable ? log.reason : null,
          ipAddress: log.ipAddress,
          requestId: log.requestId,
          createdAt: log.createdAt.toISOString(),
        };
      }),
      result.page,
      result.pageSize,
      result.total,
    );
  }
}
