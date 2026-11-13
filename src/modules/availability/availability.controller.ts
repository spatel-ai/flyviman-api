import {
  Body,
  Controller,
  Delete,
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
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import { AvailabilityService } from './availability.service.js';
import {
  toBlock,
  toConflict,
  toFleetAircraft,
  toSlot,
} from './availability.mappers.js';
import {
  BlockResponseDto,
  CalendarResponseDto,
  CreateBlockDto,
  CreateSlotDto,
  FleetCalendarResponseDto,
  RangeQueryDto,
  SlotResponseDto,
  SoftHoldConflictDto,
  UpdateSlotDto,
} from './dto/availability.dto.js';

/** Operator administrators, and staff with "manage availability" on their assigned aircraft (D-049). */
@ApiTags('availability')
@ApiCookieAuth()
@Controller('operator')
export class AvailabilityController {
  constructor(private readonly availability: AvailabilityService) {}

  @Get('availability/conflicts')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @ApiOperation({
    summary: "Overlapping soft holds on this operator's aircraft",
  })
  @ApiOkResponse({ type: [SoftHoldConflictDto] })
  async conflicts(
    @CurrentUser() user: AuthUser,
  ): Promise<SoftHoldConflictDto[]> {
    const pairs = await this.availability.conflicts(user);
    return pairs.map(toConflict);
  }

  @Get('availability')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @ApiOperation({
    summary: 'Every aircraft with its slots and blocks in a range',
    description:
      'For the fleet timeline. The range covers at most 42 days; at most 2,000 slots and 2,000 blocks are returned, with `truncated` set when cut.',
  })
  @ApiOkResponse({ type: FleetCalendarResponseDto })
  async fleet(
    @CurrentUser() user: AuthUser,
    @Query() query: RangeQueryDto,
  ): Promise<FleetCalendarResponseDto> {
    const result = await this.availability.fleetCalendar(
      user,
      new Date(query.from),
      new Date(query.to),
    );
    return {
      aircraft: result.aircraft.map(toFleetAircraft),
      slots: result.slots.map(toSlot),
      blocks: result.blocks.map(toBlock),
      truncated: result.truncated,
    };
  }

  @Get('aircraft/:id/availability')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @ApiOperation({ summary: 'Slots and blocks overlapping a date range' })
  @ApiOkResponse({ type: CalendarResponseDto })
  async calendar(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() query: RangeQueryDto,
  ): Promise<CalendarResponseDto> {
    const result = await this.availability.calendar(
      user,
      id,
      new Date(query.from),
      new Date(query.to),
    );
    return {
      slots: result.slots.map(toSlot),
      blocks: result.blocks.map(toBlock),
    };
  }

  @Post('aircraft/:id/availability/slots')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @ApiOperation({ summary: 'Add an availability or departure slot' })
  @ApiCreatedResponse({ type: SlotResponseDto })
  async addSlot(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateSlotDto,
  ): Promise<SlotResponseDto> {
    return toSlot(
      await this.availability.addSlot(user, id, {
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        kind: body.kind,
        originId: body.originId,
      }),
    );
  }

  @Patch('aircraft/:id/availability/slots/:slotId')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @ApiOperation({ summary: 'Change a slot' })
  @ApiOkResponse({ type: SlotResponseDto })
  async updateSlot(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('slotId', ParseUUIDPipe) slotId: string,
    @Body() body: UpdateSlotDto,
  ): Promise<SlotResponseDto> {
    return toSlot(
      await this.availability.updateSlot(user, id, slotId, {
        startsAt: body.startsAt ? new Date(body.startsAt) : undefined,
        endsAt: body.endsAt ? new Date(body.endsAt) : undefined,
        kind: body.kind,
        originId: body.originId,
      }),
    );
  }

  @Delete('aircraft/:id/availability/slots/:slotId')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a slot' })
  @ApiNoContentResponse()
  async removeSlot(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('slotId', ParseUUIDPipe) slotId: string,
  ): Promise<void> {
    await this.availability.removeSlot(user, id, slotId);
  }

  @Post('aircraft/:id/availability/blocks')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @ApiOperation({ summary: 'Block time (maintenance, blackout, soft hold)' })
  @ApiCreatedResponse({ type: BlockResponseDto })
  async addBlock(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: CreateBlockDto,
  ): Promise<BlockResponseDto> {
    return toBlock(
      await this.availability.addBlock(user, id, {
        startsAt: new Date(body.startsAt),
        endsAt: new Date(body.endsAt),
        reason: body.reason,
        expiresAt: body.expiresAt ? new Date(body.expiresAt) : undefined,
        note: body.note,
      }),
    );
  }

  @Delete('aircraft/:id/availability/blocks/:blockId')
  @Roles(Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF)
  @HttpCode(204)
  @ApiOperation({ summary: 'Remove a block that is not a booking hold' })
  @ApiNoContentResponse()
  async removeBlock(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('blockId', ParseUUIDPipe) blockId: string,
  ): Promise<void> {
    await this.availability.removeBlock(user, id, blockId);
  }
}
