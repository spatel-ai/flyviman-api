import {
  Body,
  Controller,
  Get,
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
  CreateStaffDto,
  ListUsersDto,
  SetUserStatusDto,
} from './dto/admin-users.dto.js';
import { AdminUserResponseDto } from './dto/user-response.dto.js';
import { UserDetail, UsersService } from './users.service.js';

function toDto(user: UserDetail): AdminUserResponseDto {
  return {
    id: user.id,
    email: user.email,
    phone: user.phone,
    role: user.role,
    status: user.status,
    emailVerifiedAt: user.emailVerifiedAt?.toISOString() ?? null,
    phoneVerifiedAt: user.phoneVerifiedAt?.toISOString() ?? null,
    lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
    createdAt: user.createdAt.toISOString(),
  };
}

@ApiTags('admin: users')
@ApiCookieAuth()
@Controller('admin')
export class AdminUsersController {
  constructor(private readonly users: UsersService) {}

  @Get('users')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'List users', description: 'Newest first.' })
  @ApiOkResponse({ type: [AdminUserResponseDto] })
  async list(
    @Query() query: ListUsersDto,
  ): Promise<Paginated<AdminUserResponseDto>> {
    const result = await this.users.list(query);
    return new Paginated(
      result.items.map(toDto),
      result.page,
      result.pageSize,
      result.total,
    );
  }

  @Get('users/:id')
  @Roles(Role.OPS, Role.SUPER_ADMIN)
  @ApiOperation({ summary: 'One user' })
  @ApiOkResponse({ type: AdminUserResponseDto })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminUserResponseDto> {
    return toDto(await this.users.getDetail(id));
  }

  @Patch('users/:id/status')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Suspend or reinstate a user',
    description:
      'Needs a reason and is audited. A suspended user is refused on their next request.',
  })
  @ApiOkResponse({ type: AdminUserResponseDto })
  async setStatus(
    @CurrentUser() actor: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: SetUserStatusDto,
  ): Promise<AdminUserResponseDto> {
    return toDto(
      await this.users.setStatus(actor, id, body.status, body.reason),
    );
  }

  @Post('staff')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Create an internal account',
    description:
      'The person receives an email link to choose a password; the account is active once they do. Repeat the call for an account that is still waiting to send a new link.',
  })
  @ApiCreatedResponse({ type: AdminUserResponseDto })
  async createStaff(
    @Body() body: CreateStaffDto,
  ): Promise<AdminUserResponseDto> {
    return toDto(await this.users.createStaff(body.email, body.role));
  }
}
