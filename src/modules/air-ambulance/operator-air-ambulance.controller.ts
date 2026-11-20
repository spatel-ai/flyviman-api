import { Controller, Get, Param, Query } from '@nestjs/common';
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
import { AirAmbulanceReferencePipe } from './air-ambulance-reference.pipe.js';
import {
  operatorDetail,
  operatorSummaries,
} from './air-ambulance.presenter.js';
import { AirAmbulanceService } from './air-ambulance.service.js';
import {
  OperatorAirAmbulanceRequestDto,
  OperatorAirAmbulanceSummaryDto,
} from './dto/operator-air-ambulance.dto.js';

/**
 * Air ambulance missions for the selected operator's administrators (M11,
 * W4-6): from the customer's acceptance on, while the operator is approved.
 * Operator staff have no access (security-rbac.md).
 */
@ApiTags('operator: air ambulance')
@ApiCookieAuth()
@Roles(Role.OPERATOR_ADMIN)
@Controller('operator/air-ambulance/requests')
export class OperatorAirAmbulanceController {
  constructor(private readonly service: AirAmbulanceService) {}

  @Get()
  @ApiOperation({
    summary: 'Missions the operator was selected for, newest first',
    description:
      'Requests where this operator is selected and the status is ACCEPTED, CONFIRMED or COMPLETED. Approved operator only (409 `OPERATOR_NOT_APPROVED`). Summary rows: no medical, contact or price data.',
  })
  @ApiOkResponse({ type: [OperatorAirAmbulanceSummaryDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: PageQueryDto,
  ): Promise<Paginated<OperatorAirAmbulanceSummaryDto>> {
    const { items, total } = await this.service.listForOperator(
      { id: user.id, role: user.role },
      query.page,
      query.pageSize,
    );
    return new Paginated(
      await operatorSummaries(this.service, items),
      query.page,
      query.pageSize,
      total,
    );
  }

  @Get(':reference')
  @ApiOperation({
    summary: 'One mission, with the places and medical details',
    description:
      'Every read of the medical details is audited (`air_ambulance_request.medical_read`, no medical data). 404 for a request this operator was not selected for, one not yet accepted, or when the operator is not approved. No customer contact details or quotation amount.',
  })
  @ApiOkResponse({ type: OperatorAirAmbulanceRequestDto })
  get(
    @CurrentUser() user: AuthUser,
    @Param('reference', AirAmbulanceReferencePipe) reference: string,
  ): Promise<OperatorAirAmbulanceRequestDto> {
    return operatorDetail(this.service, reference, {
      id: user.id,
      role: user.role,
    });
  }
}
