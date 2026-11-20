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
import { presentAuditContents } from './audit-visibility.js';
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
      'super admins only, and of matching limits (MATCHING_LIMITS) to operations; other roles get null for those fields. ' +
      'Passenger and medical fields inside before and after are null for roles that may not read them ' +
      '(medical: super admin only; identity document numbers: no one; passenger details: operations and super admin). ' +
      '`restricted` is true on every row where something was withheld or redacted.',
  })
  @ApiOkResponse({ type: [AuditLogResponseDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListAuditLogsDto,
  ): Promise<Paginated<AuditLogResponseDto>> {
    const result = await this.audit.list(query);
    return new Paginated(
      result.items.map((log) => {
        const contents = presentAuditContents(log, user.role);
        return {
          id: log.id,
          actorId: log.actorId,
          actorRole: log.actorRole,
          action: log.action,
          entityType: log.entityType,
          entityId: log.entityId,
          before: contents.before,
          after: contents.after,
          reason: contents.reason,
          restricted: contents.restricted,
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
