import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { IsPlainText } from '../../../common/validation/text.js';
import { AirAmbulanceStatus, Role } from '../../../generated/prisma/enums.js';
import {
  OPERATIONS_TARGETS,
  type OperationsTarget,
} from '../air-ambulance-workflow.service.js';
import {
  AirAmbulanceQuotePriceDto,
  AirAmbulanceRequestDto,
  MAX_QUOTE_MINOR,
} from './air-ambulance.dto.js';

const ASSIGNEE =
  /^(me|none|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export class ListAirAmbulanceQueueDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: AirAmbulanceStatus,
    enumName: 'AirAmbulanceStatus',
  })
  @IsOptional()
  @IsEnum(AirAmbulanceStatus)
  status?: AirAmbulanceStatus;

  @ApiPropertyOptional({
    description:
      '`me` for the caller’s requests, `none` for unassigned ones, or an owner’s user id.',
    example: 'none',
  })
  @IsOptional()
  @Matches(ASSIGNEE, { message: 'assignee must be me, none or a user id' })
  assignee?: string;
}

/** A row of the operations queue. Never any medical data. */
export class AdminAirAmbulanceSummaryDto {
  @ApiProperty({ example: 'FLY-AA-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: AirAmbulanceStatus, enumName: 'AirAmbulanceStatus' })
  status: AirAmbulanceStatus;

  @ApiProperty({ nullable: true, type: String })
  originName: string | null;

  @ApiProperty({ nullable: true, type: String })
  destinationName: string | null;

  @ApiProperty({ format: 'date-time' })
  preferredAt: string;

  @ApiProperty()
  patientCount: number;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  assignedToId: string | null;

  @ApiProperty({ type: AirAmbulanceQuotePriceDto, nullable: true })
  price: AirAmbulanceQuotePriceDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class FeasibilityChecklistDto {
  @ApiProperty() @IsBoolean() operatorAcceptance: boolean;
  @ApiProperty() @IsBoolean() aircraft: boolean;
  @ApiProperty() @IsBoolean() crew: boolean;
  @ApiProperty() @IsBoolean() medicalTeam: boolean;
  @ApiProperty() @IsBoolean() medicalSuitability: boolean;
  @ApiProperty() @IsBoolean() equipment: boolean;
  @ApiProperty() @IsBoolean() landingPermissions: boolean;
  @ApiProperty() @IsBoolean() clearances: boolean;
  @ApiProperty() @IsBoolean() weather: boolean;
}

export class FeasibilityStateDto extends FeasibilityChecklistDto {
  @ApiProperty({ description: 'Every item checked: CONFIRMED is allowed.' })
  complete: boolean;
}

export class AdminTimelineEntryDto {
  @ApiProperty({
    enum: AirAmbulanceStatus,
    enumName: 'AirAmbulanceStatus',
    nullable: true,
  })
  fromStatus: AirAmbulanceStatus | null;

  @ApiProperty({ enum: AirAmbulanceStatus, enumName: 'AirAmbulanceStatus' })
  toStatus: AirAmbulanceStatus;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  actorId: string | null;

  @ApiProperty({ enum: Role, enumName: 'Role', nullable: true })
  actorRole: Role | null;

  @ApiProperty({
    type: Object,
    nullable: true,
    description:
      'What the step recorded (`kind`: ASSIGNMENT, FEASIBILITY or QUOTE; a QUOTE that replaced one already sent carries its `revisionReason`, which only the request’s assigned owner and a super administrator read: for anyone else it is null). Never medical or contact data.',
  })
  payload: Record<string, unknown> | null;

  @ApiProperty({ format: 'date-time' })
  at: string;
}

/** One request as operations see it. `medical` per `security-rbac.md`. */
export class AdminAirAmbulanceRequestDto extends AirAmbulanceRequestDto {
  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  assignedToId: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  selectedOperatorId: string | null;

  @ApiProperty({ type: FeasibilityStateDto, nullable: true })
  feasibility: FeasibilityStateDto | null;

  @ApiProperty({ type: [AdminTimelineEntryDto] })
  events: AdminTimelineEntryDto[];
}

export class AssignAirAmbulanceDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'An active OPS or SUPER_ADMIN user. Left out: the caller takes the request.',
  })
  @OptionalNotNull()
  @IsUUID()
  assigneeId?: string;
}

export class MoveAirAmbulanceDto {
  @ApiProperty({ enum: OPERATIONS_TARGETS })
  @IsIn(OPERATIONS_TARGETS)
  status: OperationsTarget;
}

export class QuoteAirAmbulanceDto {
  @ApiProperty({ format: 'uuid', description: 'An approved operator.' })
  @IsUUID()
  operatorId: string;

  @ApiProperty({ minimum: 1, maximum: MAX_QUOTE_MINOR, description: 'Paise.' })
  @IsInt()
  @Min(1)
  @Max(MAX_QUOTE_MINOR)
  amountMinor: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency: 'INR';

  @ApiProperty({
    minLength: 1,
    maxLength: 2000,
    description:
      'Service and cancellation conditions shown to the customer before accepting (rule 9). No medical details.',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @IsPlainText()
  conditions: string;

  @ApiPropertyOptional({
    minLength: 3,
    maxLength: 500,
    description:
      'Why a quotation already sent is replaced: required while the request is QUOTED (400 `VALIDATION_ERROR` without it), not stored otherwise. Kept encrypted in the timeline entry; the audit record says only that it was a revision. No medical details.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @IsPlainText()
  revisionReason?: string;
}

/** An operator operations may quote for a mission (W4-6). */
export class AirAmbulanceOperatorDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'Skyline Medevac' })
  name: string;
}
