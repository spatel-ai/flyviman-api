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
import { ComplianceService } from './compliance.service.js';
import {
  ExpiringDocumentDto,
  ExpiringDocumentsQueryDto,
} from './dto/expiring-documents.dto.js';

@ApiTags('admin-compliance')
@ApiCookieAuth()
@Controller('admin/documents')
export class AdminComplianceController {
  constructor(private readonly compliance: ComplianceService) {}

  @Get('expiring')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Certificates and insurance nearing expiry, or expired',
    description:
      'The current copy of each operator and aircraft document (a renewal replaces the copy it renews), for live operators and listings, soonest first.',
  })
  @ApiOkResponse({ type: [ExpiringDocumentDto] })
  async expiring(
    @Query() query: ExpiringDocumentsQueryDto,
  ): Promise<Paginated<ExpiringDocumentDto>> {
    const page = await this.compliance.expiring(query);
    return new Paginated(
      page.items.map((row) => ({
        kind: row.kind,
        documentId: row.documentId,
        type: row.type,
        expiresAt: row.expiresAt.toISOString().slice(0, 10),
        daysLeft: row.daysLeft,
        verificationStatus: row.verificationStatus,
        operatorId: row.operatorId,
        operatorName: row.operatorName,
        aircraftId: row.aircraftId,
        registration: row.registration,
      })),
      page.page,
      page.pageSize,
      page.total,
    );
  }
}
