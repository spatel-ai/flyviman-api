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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AircraftService } from './aircraft.service.js';
import {
  toAircraftDto,
  toDocumentDto,
  toSummaryDto,
} from './aircraft.mappers.js';
import {
  AdminAircraftDetailDto,
  AdminAircraftQueryDto,
  AdminAircraftSummaryDto,
  AircraftDocumentResponseDto,
  AircraftReasonDto,
  VerifyAircraftDocumentDto,
} from './dto/aircraft.dto.js';

/** Operations and super administrators only; finance has no aircraft access (security-rbac.md). */
const REVIEWERS = [Role.OPS, Role.SUPER_ADMIN];

@ApiTags('admin-aircraft')
@ApiCookieAuth()
@Controller('admin/aircraft')
export class AdminAircraftController {
  constructor(private readonly aircraft: AircraftService) {}

  @Get()
  @Roles(...REVIEWERS)
  @ApiOperation({ summary: 'List aircraft for review' })
  @ApiOkResponse({ type: [AdminAircraftSummaryDto] })
  async list(
    @Query() query: AdminAircraftQueryDto,
  ): Promise<Paginated<AdminAircraftSummaryDto>> {
    const page = await this.aircraft.adminList(query);
    return new Paginated(
      page.items.map((row) => ({
        ...toSummaryDto(row),
        operatorId: row.operatorId,
        operatorName: row.operatorName,
      })),
      page.page,
      page.pageSize,
      page.total,
    );
  }

  @Get(':id')
  @Roles(...REVIEWERS)
  @ApiOperation({ summary: 'Aircraft detail for review' })
  @ApiOkResponse({ type: AdminAircraftDetailDto })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminAircraftDetailDto> {
    const row = await this.aircraft.adminGet(id);
    return { ...toAircraftDto(row), operatorName: row.operatorName };
  }

  @Post(':id/approve')
  @Roles(...REVIEWERS)
  @HttpCode(200)
  @ApiOperation({
    summary: 'Approve an aircraft listing',
    description:
      'Required documents must be verified and unexpired. Audited. The operator is notified.',
  })
  @ApiOkResponse({ type: AdminAircraftDetailDto })
  async approve(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminAircraftDetailDto> {
    await this.aircraft.review(actor, id, 'approve');
    return this.detail(id);
  }

  @Post(':id/reject')
  @Roles(...REVIEWERS)
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject an aircraft listing' })
  @ApiOkResponse({ type: AdminAircraftDetailDto })
  async reject(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AircraftReasonDto,
  ): Promise<AdminAircraftDetailDto> {
    await this.aircraft.review(actor, id, 'reject', body.reason);
    return this.detail(id);
  }

  @Post(':id/suspend')
  @Roles(...REVIEWERS)
  @HttpCode(200)
  @ApiOperation({ summary: 'Suspend an approved aircraft' })
  @ApiOkResponse({ type: AdminAircraftDetailDto })
  async suspend(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AircraftReasonDto,
  ): Promise<AdminAircraftDetailDto> {
    await this.aircraft.review(actor, id, 'suspend', body.reason);
    return this.detail(id);
  }

  @Post(':id/reinstate')
  @Roles(...REVIEWERS)
  @HttpCode(200)
  @ApiOperation({ summary: 'Reinstate a suspended aircraft' })
  @ApiOkResponse({ type: AdminAircraftDetailDto })
  async reinstate(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminAircraftDetailDto> {
    await this.aircraft.review(actor, id, 'reinstate');
    return this.detail(id);
  }

  @Post(':id/release-registration')
  @Roles(...REVIEWERS)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Release a registration mark claimed in error',
    description:
      'Deletes a draft or rejected aircraft so the mark can be reused. Cannot be undone; a reason is required and audited.',
  })
  @ApiNoContentResponse()
  async release(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: AircraftReasonDto,
  ): Promise<void> {
    await this.aircraft.releaseRegistration(actor, id, body.reason);
  }

  @Post('documents/:documentId/verify')
  @Roles(...REVIEWERS)
  @HttpCode(200)
  @ApiOperation({ summary: 'Verify or reject an aircraft document' })
  @ApiOkResponse({ type: AircraftDocumentResponseDto })
  async verifyDocument(
    @CurrentUser() actor: AuthUser,
    @Param('documentId', ParseUUIDPipe) documentId: string,
    @Body() body: VerifyAircraftDocumentDto,
  ): Promise<AircraftDocumentResponseDto> {
    return toDocumentDto(
      await this.aircraft.verifyAircraftDocument(
        actor,
        documentId,
        body.decision,
        body.reason,
      ),
    );
  }
}
