import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import { AuditService } from './audit.service.js';
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
      'Newest first. Filter by entity, actor, action and time range.',
  })
  @ApiOkResponse({ type: [AuditLogResponseDto] })
  async list(
    @Query() query: ListAuditLogsDto,
  ): Promise<Paginated<AuditLogResponseDto>> {
    const result = await this.audit.list(query);
    return new Paginated(
      result.items.map((log) => ({
        id: log.id,
        actorId: log.actorId,
        actorRole: log.actorRole,
        action: log.action,
        entityType: log.entityType,
        entityId: log.entityId,
        before: log.before,
        after: log.after,
        reason: log.reason,
        ipAddress: log.ipAddress,
        requestId: log.requestId,
        createdAt: log.createdAt.toISOString(),
      })),
      result.page,
      result.pageSize,
      result.total,
    );
  }
}
