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
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { StrictRateLimit } from '../../common/rate-limit/rate-limit.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import {
  InviteStaffDto,
  RemoveStaffDto,
  StaffMemberDto,
  UpdateStaffDto,
} from './dto/operator-staff.dto.js';
import {
  OperatorStaffService,
  type StaffMember,
} from './operator-staff.service.js';

function toStaffDto(member: StaffMember): StaffMemberDto {
  return {
    id: member.id,
    email: member.email,
    status: member.status,
    suspendedBy: member.suspendedBy,
    capabilities: member.permissions.capabilities,
    allAircraft: member.permissions.allAircraft,
    aircraftIds: member.permissions.aircraftIds,
    invitedAt: member.invitedAt.toISOString(),
    lastLoginAt: member.lastLoginAt?.toISOString() ?? null,
  };
}

/** The operator's own staff (M3 step 7). Operator administrators only. */
@ApiTags('operator-staff')
@ApiCookieAuth()
@Controller('operator/staff')
export class OperatorStaffController {
  constructor(private readonly staff: OperatorStaffService) {}

  @Get()
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({ summary: "List the operator's staff" })
  @ApiOkResponse({ type: [StaffMemberDto] })
  async list(@CurrentUser() user: AuthUser): Promise<StaffMemberDto[]> {
    return (await this.staff.list(user)).map(toStaffDto);
  }

  @Post()
  @Roles(Role.OPERATOR_ADMIN)
  @StrictRateLimit()
  @ApiOperation({
    summary: 'Invite a staff member',
    description:
      'Emails a single-use link (72 hours) to choose a password. Posting again for an invitation not yet accepted re-sends it and applies the permissions given. Needs an approved operator; at most 20 invitations an hour.',
  })
  @ApiCreatedResponse({ type: StaffMemberDto })
  async invite(
    @CurrentUser() user: AuthUser,
    @Body() body: InviteStaffDto,
  ): Promise<StaffMemberDto> {
    return toStaffDto(await this.staff.invite(user, body));
  }

  @Patch(':id')
  @Roles(Role.OPERATOR_ADMIN)
  @ApiOperation({
    summary:
      "Change a staff member's permissions, or suspend or reinstate them",
    description:
      'Permission changes apply on their next request. Suspending needs a reason and signs them out everywhere.',
  })
  @ApiOkResponse({ type: StaffMemberDto })
  async update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateStaffDto,
  ): Promise<StaffMemberDto> {
    return toStaffDto(await this.staff.update(user, id, body));
  }

  @Delete(':id')
  @Roles(Role.OPERATOR_ADMIN)
  @HttpCode(204)
  @ApiOperation({
    summary: 'Remove a staff member',
    description:
      'Ends their membership, suspends the account and signs them out. Inviting the address again brings it back.',
  })
  @ApiNoContentResponse()
  async remove(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: RemoveStaffDto,
  ): Promise<void> {
    await this.staff.remove(user, id, body.reason);
  }
}
