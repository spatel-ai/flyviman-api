import { ApiProperty } from '@nestjs/swagger';
import { Role, UserStatus } from '../../../generated/prisma/enums.js';

export class UserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true, example: 'asha@example.com' })
  email: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+919876543210' })
  phone: string | null;

  @ApiProperty({ enum: Role, enumName: 'Role' })
  role: Role;

  @ApiProperty({ enum: UserStatus, enumName: 'UserStatus' })
  status: UserStatus;
}

export class AdminUserResponseDto extends UserResponseDto {
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  emailVerifiedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  phoneVerifiedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLoginAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
