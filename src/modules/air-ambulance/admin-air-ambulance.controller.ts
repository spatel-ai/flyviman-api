import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Put,
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
import { AirAmbulanceReferencePipe } from './air-ambulance-reference.pipe.js';
import { AirAmbulanceWorkflowService } from './air-ambulance-workflow.service.js';
import { adminDetail, adminSummaries } from './air-ambulance.presenter.js';
import {
  type AirAmbulanceActor,
  type AirAmbulanceRequestView,
  AirAmbulanceService,
} from './air-ambulance.service.js';
import {
  AirAmbulanceOperatorDto,
  AdminAirAmbulanceRequestDto,
  AdminAirAmbulanceSummaryDto,
  AssignAirAmbulanceDto,
  FeasibilityChecklistDto,
  ListAirAmbulanceQueueDto,
  MoveAirAmbulanceDto,
  QuoteAirAmbulanceDto,
} from './dto/admin-air-ambulance.dto.js';

function actorOf(user: AuthUser): AirAmbulanceActor {
  return { id: user.id, role: user.role };
}

/**
 * The operations queue for air ambulance requests (M11, W4-5). Operations
 * see every request; the medical details only as its assigned owner (the
 * super administrator always), and every such read is audited. Changes are
 * made by the owner or a super administrator (403 `AIR_AMBULANCE_NOT_OWNER`).
 */
@ApiTags('admin: air ambulance')
@ApiCookieAuth()
@Roles(Role.OPS, Role.SUPER_ADMIN)
@Controller('admin/air-ambulance/requests')
export class AdminAirAmbulanceController {
  constructor(
    private readonly service: AirAmbulanceService,
    private readonly workflow: AirAmbulanceWorkflowService,
  ) {}

  private async summary(
    view: AirAmbulanceRequestView,
  ): Promise<AdminAirAmbulanceSummaryDto> {
    return (await adminSummaries(this.service, [view]))[0];
  }

  @Get()
  @ApiOperation({
    summary: 'The request queue, newest first',
    description:
      'Filter by `status` and `assignee` (`me`, `none` for unassigned, or a user id). No medical or contact details.',
  })
  @ApiOkResponse({ type: [AdminAirAmbulanceSummaryDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: ListAirAmbulanceQueueDto,
  ): Promise<Paginated<AdminAirAmbulanceSummaryDto>> {
    const { items, total } = await this.service.queue(actorOf(user), query);
    return new Paginated(
      await adminSummaries(this.service, items),
      query.page,
      query.pageSize,
      total,
    );
  }

  @Get(':reference')
  @ApiOperation({
    summary: 'One request, with its timeline and feasibility checklist',
    description:
      '`medical` is null unless the caller is the assigned owner or a super administrator; returning it is audited (`air_ambulance_request.medical_read`).',
  })
  @ApiOkResponse({ type: AdminAirAmbulanceRequestDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
  ): Promise<AdminAirAmbulanceRequestDto> {
    return adminDetail(this.service, reference, actorOf(user));
  }

  @Post(':reference/assign')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign an operations owner',
    description:
      'The caller when `assigneeId` is left out. The first assignment moves SUBMITTED to ASSIGNED. Operations may take an unassigned request or hand on their own (403 `AIR_AMBULANCE_NOT_OWNER` otherwise); a super administrator may reassign any. 422 `AIR_AMBULANCE_ASSIGNEE_INVALID` unless the owner is an active OPS or SUPER_ADMIN user; 409 `AIR_AMBULANCE_CLOSED` once closed. Audited.',
  })
  @ApiOkResponse({ type: AdminAirAmbulanceSummaryDto })
  async assign(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
    @Body() body: AssignAirAmbulanceDto,
  ): Promise<AdminAirAmbulanceSummaryDto> {
    return this.summary(
      await this.workflow.assign(actorOf(user), reference, body.assigneeId),
    );
  }

  @Patch(':reference/status')
  @ApiOperation({
    summary: 'Move the request through the workflow',
    description:
      'ASSIGNED to SOURCING to FEASIBILITY_CHECK; ACCEPTED to CONFIRMED; CONFIRMED to COMPLETED; DECLINED or CANCELLED from any open status. CONFIRMED needs every feasibility item checked (422 `AIR_AMBULANCE_FEASIBILITY_INCOMPLETE`, the missing items in `details`) and the selected operator still approved (409 `OPERATOR_NOT_APPROVED`) with an approved air ambulance aircraft (409 `AIR_AMBULANCE_OPERATOR_NOT_ELIGIBLE`); it is never reached any other way (rule 7). 409 `AIR_AMBULANCE_INVALID_TRANSITION` for any other move. Writes a timeline entry and an audit record.',
  })
  @ApiOkResponse({ type: AdminAirAmbulanceSummaryDto })
  async move(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
    @Body() body: MoveAirAmbulanceDto,
  ): Promise<AdminAirAmbulanceSummaryDto> {
    return this.summary(
      await this.workflow.move(actorOf(user), reference, body.status),
    );
  }

  @Put(':reference/feasibility')
  @ApiOperation({
    summary: 'Record the feasibility checklist',
    description:
      'The whole checklist, as it stands, while FEASIBILITY_CHECK, QUOTED or ACCEPTED (409 `AIR_AMBULANCE_INVALID_TRANSITION` otherwise). Each recording is a timeline entry and an audit record.',
  })
  @ApiOkResponse({ type: AdminAirAmbulanceSummaryDto })
  async feasibility(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
    @Body() body: FeasibilityChecklistDto,
  ): Promise<AdminAirAmbulanceSummaryDto> {
    return this.summary(
      await this.workflow.recordFeasibility(actorOf(user), reference, {
        operatorAcceptance: body.operatorAcceptance,
        aircraft: body.aircraft,
        crew: body.crew,
        medicalTeam: body.medicalTeam,
        medicalSuitability: body.medicalSuitability,
        equipment: body.equipment,
        landingPermissions: body.landingPermissions,
        clearances: body.clearances,
        weather: body.weather,
      }),
    );
  }

  @Post(':reference/quote')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Send the customer a quotation',
    description:
      'From an approved operator (409 `OPERATOR_NOT_APPROVED`; 404 for an unknown operator) with an approved air ambulance aircraft (409 `AIR_AMBULANCE_OPERATOR_NOT_ELIGIBLE`; `GET /admin/air-ambulance/operators` lists them), labelled `QUOTE`. FEASIBILITY_CHECK to QUOTED; while QUOTED it replaces the last quotation. 409 `AIR_AMBULANCE_INVALID_TRANSITION` in any other status. Audited with the amount and operator.',
  })
  @ApiOkResponse({ type: AdminAirAmbulanceSummaryDto })
  async quote(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
    @Body() body: QuoteAirAmbulanceDto,
  ): Promise<AdminAirAmbulanceSummaryDto> {
    return this.summary(
      await this.workflow.quote(actorOf(user), reference, body),
    );
  }
}

/** Who operations may quote (W4-6). Its own path, so `:reference` cannot take it. */
@ApiTags('admin: air ambulance')
@ApiCookieAuth()
@Roles(Role.OPS, Role.SUPER_ADMIN)
@Controller('admin/air-ambulance/operators')
export class AdminAirAmbulanceOperatorsController {
  constructor(private readonly service: AirAmbulanceService) {}

  @Get()
  @ApiOperation({
    summary: 'Operators that may be quoted for a mission',
    description:
      'Approved operators with at least one approved air ambulance aircraft (category `AIR_AMBULANCE_FIXED` or `AIR_AMBULANCE_ROTARY`), by name (a short list: only operators with an approved air ambulance aircraft). Quoting any other operator answers 409 `AIR_AMBULANCE_OPERATOR_NOT_ELIGIBLE`.',
  })
  @ApiOkResponse({ type: [AirAmbulanceOperatorDto] })
  list(): Promise<AirAmbulanceOperatorDto[]> {
    return this.service.eligibleOperators();
  }
}
