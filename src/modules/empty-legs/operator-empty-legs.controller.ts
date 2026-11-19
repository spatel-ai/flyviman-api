import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import {
  CreateEmptyLegDto,
  OperatorEmptyLegAircraftDto,
  OperatorEmptyLegQueryDto,
  OperatorEmptyLegResponseDto,
  UpdateEmptyLegDto,
} from './dto/empty-leg.dto.js';
import { EmptyLegsService } from './empty-legs.service.js';

/**
 * Operator administrators, and staff with "manage empty legs" on the
 * offer's aircraft (D-049). Another operator's offer, or one on an aircraft
 * out of reach, answers 404; a missing capability 403.
 */
@ApiTags('operator-empty-legs')
@ApiCookieAuth()
@Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
@Controller('operator/empty-legs')
export class OperatorEmptyLegsController {
  constructor(private readonly emptyLegs: EmptyLegsService) {}

  @Get()
  @ApiOperation({ summary: 'List own offers, newest first' })
  @ApiOkResponse({ type: [OperatorEmptyLegResponseDto] })
  async list(
    @CurrentUser() user: AuthUser,
    @Query() query: OperatorEmptyLegQueryDto,
  ): Promise<Paginated<OperatorEmptyLegResponseDto>> {
    const page = await this.emptyLegs.operatorList(user, query);
    return new Paginated(
      page.items.map((row) => this.emptyLegs.toOperator(row)),
      page.page,
      page.pageSize,
      page.total,
    );
  }

  @Post()
  @ApiOperation({
    summary: 'Create an offer',
    description:
      'Created as a draft. Approved operators only. The price is returned as a `QUOTE`. Audited.',
  })
  @ApiCreatedResponse({ type: OperatorEmptyLegResponseDto })
  async create(
    @CurrentUser() user: AuthUser,
    @Body() dto: CreateEmptyLegDto,
  ): Promise<OperatorEmptyLegResponseDto> {
    return this.emptyLegs.toOperator(await this.emptyLegs.create(user, dto));
  }

  @Get('aircraft')
  @ApiOperation({
    summary: 'Aircraft an offer can be made on',
    description:
      'Approved aircraft within your reach, by registration. Read only; for staff with "manage empty legs" who have no fleet access.',
  })
  @ApiOkResponse({ type: [OperatorEmptyLegAircraftDto] })
  aircraft(
    @CurrentUser() user: AuthUser,
  ): Promise<OperatorEmptyLegAircraftDto[]> {
    return this.emptyLegs.aircraftOptions(user);
  }

  @Get(':id')
  @ApiOperation({ summary: 'Offer detail' })
  @ApiOkResponse({ type: OperatorEmptyLegResponseDto })
  async detail(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OperatorEmptyLegResponseDto> {
    return this.emptyLegs.toOperator(
      await this.emptyLegs.operatorGet(user, id),
    );
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update an offer',
    description:
      'Drafts and published offers. On a published offer the aircraft, origin and destination are locked (409 `EMPTY_LEG_FIELD_LOCKED`); a change notifies customers following it, or, when review is required, returns it to review. Audited.',
  })
  @ApiOkResponse({ type: OperatorEmptyLegResponseDto })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEmptyLegDto,
  ): Promise<OperatorEmptyLegResponseDto> {
    return this.emptyLegs.toOperator(
      await this.emptyLegs.update(user, id, dto),
    );
  }

  @Post(':id/publish')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Publish, or submit for review if required',
    description:
      'From draft. Needs an approved operator and aircraft and validity still ahead. Goes to `PUBLISHED`, or `PENDING_REVIEW` when review is required. Audited.',
  })
  @ApiOkResponse({ type: OperatorEmptyLegResponseDto })
  async publish(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OperatorEmptyLegResponseDto> {
    return this.emptyLegs.toOperator(await this.emptyLegs.publish(user, id));
  }

  @Post(':id/withdraw')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Withdraw',
    description:
      'From draft, review or published; final. Customers following a published offer are told. Audited.',
  })
  @ApiOkResponse({ type: OperatorEmptyLegResponseDto })
  async withdraw(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<OperatorEmptyLegResponseDto> {
    return this.emptyLegs.toOperator(await this.emptyLegs.withdraw(user, id));
  }
}
