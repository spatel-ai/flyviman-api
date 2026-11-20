import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { PageQueryDto } from '../../common/dto/page-query.dto.js';
import { Paginated } from '../../common/dto/paginated.js';
import {
  Idempotent,
  IdempotencyClaimParam,
} from '../../common/idempotency/idempotency.interceptor.js';
import type { IdempotencyClaim } from '../../common/idempotency/idempotency.store.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AirAmbulanceReferencePipe } from './air-ambulance-reference.pipe.js';
import { AirAmbulanceWorkflowService } from './air-ambulance-workflow.service.js';
import { detail, summaries } from './air-ambulance.presenter.js';
import {
  type AirAmbulanceActor,
  AirAmbulanceService,
  type AirAmbulanceRequestView,
} from './air-ambulance.service.js';
import {
  AcceptAirAmbulanceQuoteDto,
  AirAmbulanceCreatedDto,
  AirAmbulanceDocumentDto,
  AirAmbulanceRequestDto,
  AirAmbulanceSummaryDto,
  AttachAirAmbulanceDocumentDto,
  CreateAirAmbulanceRequestDto,
  EMERGENCY_NOTICE,
} from './dto/air-ambulance.dto.js';

function actorOf(user: AuthUser): AirAmbulanceActor {
  return { id: user.id, role: user.role };
}

/**
 * Air ambulance requests, customer side (M11, W4-4). Ownership is the
 * session's: another customer's request is 404. A request is never a
 * confirmed booking until operations confirm it (rule 7).
 */
@ApiTags('air-ambulance')
@ApiCookieAuth()
@Roles(Role.CUSTOMER)
@Controller('air-ambulance/requests')
export class AirAmbulanceController {
  constructor(
    private readonly service: AirAmbulanceService,
    private readonly workflow: AirAmbulanceWorkflowService,
  ) {}

  private async summary(
    view: AirAmbulanceRequestView,
  ): Promise<AirAmbulanceSummaryDto> {
    return (await summaries(this.service, [view]))[0];
  }

  @Post()
  @Idempotent()
  @ApiOperation({
    summary: 'Submit an air ambulance request',
    description:
      'Records the request as `SUBMITTED` with the medical details encrypted; operations take it from there. Both locations must be active (404 `NOT_FOUND`, field in `details`) and different (400 `VALIDATION_ERROR`). The answer holds the reference, status and `emergencyNotice` only. Medical details are never logged or audited. A repeat with the same `Idempotency-Key` and body returns the first answer.',
  })
  @ApiHeader({
    name: 'Idempotency-Key',
    required: true,
    description: 'A UUID, new for each request and reused on retry.',
    schema: { type: 'string', format: 'uuid' },
  })
  @ApiCreatedResponse({ type: AirAmbulanceCreatedDto })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() body: CreateAirAmbulanceRequestDto,
    @IdempotencyClaimParam() claim: IdempotencyClaim,
  ): Promise<AirAmbulanceCreatedDto> {
    const view = await this.service.create(
      actorOf(user),
      { ...body, preferredAt: new Date(body.preferredAt) },
      claim,
    );
    return {
      reference: view.reference,
      status: view.status,
      emergencyNotice: EMERGENCY_NOTICE,
      createdAt: view.createdAt.toISOString(),
    };
  }

  @Get()
  @ApiOperation({
    summary: 'The caller’s air ambulance requests, newest first',
    description: 'Summary rows only; no medical or contact details.',
  })
  @ApiOkResponse({ type: [AirAmbulanceSummaryDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<AirAmbulanceSummaryDto>> {
    const { items, total } = await this.service.listOwn(
      actorOf(user),
      query.page,
      query.pageSize,
    );
    return new Paginated(
      await summaries(this.service, items),
      query.page,
      query.pageSize,
      total,
    );
  }

  @Get(':reference')
  @ApiOperation({
    summary:
      'One of the caller’s requests: status, quotation, contacts, medical details',
    description:
      'Every read of the medical details is audited (`air_ambulance_request.medical_read`, no medical data). Another customer’s request is 404.',
  })
  @ApiOkResponse({ type: AirAmbulanceRequestDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
  ): Promise<AirAmbulanceRequestDto> {
    return detail(this.service, reference, actorOf(user));
  }

  @Post(':reference/documents')
  @ApiOperation({
    summary: 'Attach an uploaded medical document',
    description:
      'Reserve the upload with `POST /uploads/presign` (purpose `AIR_AMBULANCE_DOCUMENT`: PDF, JPEG or PNG, 10 MB at most), send the file, then attach it here. 422 `UPLOAD_NOT_FOUND` for a file not uploaded or not the caller’s; 409 `AIR_AMBULANCE_CLOSED` once the request is closed; 409 `AIR_AMBULANCE_DOCUMENT_LIMIT_REACHED` at 10 documents. Downloads (`GET /documents/:id/download`) are open only to those who may read the medical details, and audited.',
  })
  @ApiCreatedResponse({ type: AirAmbulanceDocumentDto })
  attach(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
    @Body() body: AttachAirAmbulanceDocumentDto,
  ): Promise<AirAmbulanceDocumentDto> {
    return this.service.attachDocument(actorOf(user), reference, body.fileId);
  }

  @Post(':reference/quote/accept')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Accept the quotation',
    description:
      'QUOTED to ACCEPTED. Send the amount shown as `expectedAmountMinor`: 409 `AIR_AMBULANCE_QUOTE_CHANGED` (current amount in `details`) if it differs; 409 `AIR_AMBULANCE_QUOTE_UNAVAILABLE` if the operator can no longer fly it; 409 `AIR_AMBULANCE_INVALID_TRANSITION` when there is no open quotation. Still a request: only operations confirm, after verifying the mission.',
  })
  @ApiOkResponse({ type: AirAmbulanceSummaryDto })
  async accept(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
    @Body() body: AcceptAirAmbulanceQuoteDto,
  ): Promise<AirAmbulanceSummaryDto> {
    return this.summary(
      await this.workflow.accept(
        actorOf(user),
        reference,
        body.expectedAmountMinor,
      ),
    );
  }

  @Post(':reference/quote/decline')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Decline the quotation',
    description:
      'QUOTED to DECLINED. 409 `AIR_AMBULANCE_INVALID_TRANSITION` when there is no open quotation.',
  })
  @ApiOkResponse({ type: AirAmbulanceSummaryDto })
  async decline(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
  ): Promise<AirAmbulanceSummaryDto> {
    return this.summary(await this.workflow.decline(actorOf(user), reference));
  }

  @Post(':reference/cancel')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Withdraw the request',
    description:
      'To CANCELLED from any status before COMPLETED. 409 `AIR_AMBULANCE_INVALID_TRANSITION` once closed.',
  })
  @ApiOkResponse({ type: AirAmbulanceSummaryDto })
  async cancel(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
  ): Promise<AirAmbulanceSummaryDto> {
    return this.summary(await this.workflow.cancel(actorOf(user), reference));
  }
}
