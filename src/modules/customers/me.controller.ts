import { Body, Controller, Get, HttpStatus, Patch, Post } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { AppException } from '../../common/errors/app.exception.js';
import { day } from '../../common/validation/formats.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AnyRole, CurrentUser, Roles } from '../auth/auth.decorators.js';
import { ConsentsService } from '../users/consents.service.js';
import { UsersService } from '../users/users.service.js';
import { CustomersService, Profile } from './customers.service.js';
import {
  ConsentResponseDto,
  MeResponseDto,
  ProfileResponseDto,
  RecordConsentDto,
  UpdateMeDto,
} from './dto/me.dto.js';

function profileDto(profile: Profile | null): ProfileResponseDto | null {
  return profile
    ? {
        firstName: profile.firstName,
        lastName: profile.lastName,
        dateOfBirth: day(profile.dateOfBirth),
        nationality: profile.nationality,
      }
    : null;
}

@ApiTags('me')
@ApiCookieAuth()
@Controller('me')
export class MeController {
  constructor(
    private readonly users: UsersService,
    private readonly customers: CustomersService,
    private readonly consents: ConsentsService,
  ) {}

  @Get()
  @AnyRole()
  @ApiOperation({
    summary: 'Current user',
    description: 'The signed-in user, their role and, for customers, profile.',
  })
  @ApiOkResponse({ type: MeResponseDto })
  async me(@CurrentUser() user: AuthUser): Promise<MeResponseDto> {
    const account = await this.users.findAccount(user.id);
    if (!account) {
      throw new AppException(
        'UNAUTHENTICATED',
        'Sign in to continue.',
        HttpStatus.UNAUTHORIZED,
      );
    }
    const profile = await this.customers.findProfile(user.id);
    return {
      id: account.id,
      email: account.email,
      phone: account.phone,
      role: account.role,
      status: account.status,
      profile: profileDto(profile),
    };
  }

  @Patch()
  @Roles(Role.CUSTOMER)
  @ApiOperation({
    summary: 'Update the customer profile',
    description: 'Customers only. Send only the fields to change.',
  })
  @ApiOkResponse({ type: ProfileResponseDto })
  async update(
    @CurrentUser() user: AuthUser,
    @Body() body: UpdateMeDto,
  ): Promise<ProfileResponseDto> {
    const profile = await this.customers.updateProfile(user.id, body);
    return profileDto(profile)!;
  }

  @Post('consents')
  @AnyRole()
  @ApiOperation({ summary: 'Record a consent' })
  @ApiCreatedResponse({ type: ConsentResponseDto })
  async consent(
    @CurrentUser() user: AuthUser,
    @Body() body: RecordConsentDto,
  ): Promise<ConsentResponseDto> {
    const consent = await this.consents.record(
      user.id,
      body.type,
      body.version,
    );
    return {
      type: consent.type,
      version: consent.version,
      acceptedAt: consent.acceptedAt.toISOString(),
    };
  }
}
