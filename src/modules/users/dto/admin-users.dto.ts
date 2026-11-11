import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { Role, UserStatus } from '../../../generated/prisma/enums.js';
import { STAFF_ROLES } from '../users.service.js';

export class ListUsersDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: Role, enumName: 'Role' })
  @IsOptional()
  @IsEnum(Role)
  role?: Role;

  @ApiPropertyOptional({ enum: UserStatus, enumName: 'UserStatus' })
  @IsOptional()
  @IsEnum(UserStatus)
  status?: UserStatus;

  @ApiPropertyOptional({
    description: 'Part of an email address or phone number.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export const SETTABLE_STATUSES = [UserStatus.ACTIVE, UserStatus.SUSPENDED];

export class SetUserStatusDto {
  @ApiProperty({ enum: SETTABLE_STATUSES })
  @IsIn(SETTABLE_STATUSES)
  status: UserStatus;

  @ApiProperty({ description: 'Why the status is being changed. Audited.' })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}

export class CreateStaffDto {
  @ApiProperty({ example: 'ops.lead@flyviman.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ enum: STAFF_ROLES })
  @IsIn(STAFF_ROLES)
  role: Role;
}
