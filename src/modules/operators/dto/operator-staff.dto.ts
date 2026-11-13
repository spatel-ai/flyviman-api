import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsEmail,
  IsIn,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { Role } from '../../../generated/prisma/enums.js';
import { CAPABILITIES, type Capability } from '../operator-access.js';

/** At most as many as an operator can hold (MAX_AIRCRAFT in aircraft). */
const MAX_ASSIGNED = 50;

export const STAFF_STATUSES = ['INVITED', 'ACTIVE', 'SUSPENDED'] as const;
export type StaffStatus = (typeof STAFF_STATUSES)[number];

class StaffPermissionsInput {
  @ApiProperty({
    enum: CAPABILITIES,
    enumName: 'StaffCapability',
    isArray: true,
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(CAPABILITIES, { each: true })
  capabilities: Capability[];

  @ApiProperty({
    description:
      'Every aircraft of the operator, including ones added later. When true, aircraftIds is ignored.',
  })
  @IsBoolean()
  allAircraft: boolean;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      "Assigned aircraft, each one of this operator's. At least one unless allAircraft is true.",
  })
  @IsArray()
  @ArrayMaxSize(MAX_ASSIGNED)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  aircraftIds: string[];
}

export class InviteStaffDto extends StaffPermissionsInput {
  @ApiProperty({ example: 'dispatch@example.com' })
  @IsEmail()
  @MaxLength(254)
  email: string;
}

export const STAFF_STATUS_CHANGES = ['ACTIVE', 'SUSPENDED'] as const;

export class UpdateStaffDto {
  @ApiPropertyOptional({
    enum: CAPABILITIES,
    enumName: 'StaffCapability',
    isArray: true,
  })
  @OptionalNotNull()
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn(CAPABILITIES, { each: true })
  capabilities?: Capability[];

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsBoolean()
  allAircraft?: boolean;

  @ApiPropertyOptional({ type: [String], format: 'uuid' })
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(MAX_ASSIGNED)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  aircraftIds?: string[];

  @ApiPropertyOptional({
    enum: STAFF_STATUS_CHANGES,
    description: 'SUSPENDED signs the person out at once; ACTIVE reinstates.',
  })
  @OptionalNotNull()
  @IsIn(STAFF_STATUS_CHANGES)
  status?: (typeof STAFF_STATUS_CHANGES)[number];

  @ApiPropertyOptional({
    description: 'Required when suspending (at least 3 characters). Audited.',
  })
  @OptionalNotNull()
  @IsString()
  @MaxLength(1000)
  reason?: string;
}

export class RemoveStaffDto {
  @ApiProperty({ description: 'Audited.' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export class StaffMemberDto {
  @ApiProperty({ format: 'uuid', description: 'The membership id.' })
  id: string;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({ enum: STAFF_STATUSES, enumName: 'StaffStatus' })
  status: StaffStatus;

  @ApiProperty({
    enum: CAPABILITIES,
    enumName: 'StaffCapability',
    isArray: true,
  })
  capabilities: Capability[];

  @ApiProperty()
  allAircraft: boolean;

  @ApiProperty({ type: [String], format: 'uuid' })
  aircraftIds: string[];

  @ApiProperty({ type: String, format: 'date-time' })
  invitedAt: string;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  lastLoginAt: string | null;
}

/** What the caller may do in their organisation, for the portal to show. */
export class OperatorAccessDto {
  @ApiProperty({ enum: [Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF] })
  role: Role;

  @ApiProperty({
    enum: CAPABILITIES,
    enumName: 'StaffCapability',
    isArray: true,
  })
  capabilities: Capability[];

  @ApiProperty()
  allAircraft: boolean;

  @ApiProperty({
    type: [String],
    format: 'uuid',
    description: 'Assigned aircraft; empty when allAircraft is true.',
  })
  aircraftIds: string[];
}
