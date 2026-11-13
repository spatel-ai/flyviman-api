import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { applyDecorators } from '@nestjs/common';
import {
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';

/**
 * An ISO 8601 timestamp that names its offset (`Z` or `+05:30`). A value
 * without one would be read in the server's own time zone, not UTC.
 */
function IsTimestamp(): PropertyDecorator {
  return applyDecorators(
    IsISO8601({ strict: true }),
    Matches(/T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/, {
      message: '$property must include a time and a UTC offset, for example Z',
    }),
  );
}
import {
  AircraftAvailabilityStatus,
  AircraftListingStatus,
  AvailabilityBlockReason,
  AvailabilitySlotKind,
} from '../../../generated/prisma/enums.js';
import { HomeBaseSummaryDto } from '../../aircraft/dto/aircraft.dto.js';

/** Reasons an operator may set. Confirmed bookings are created by bookings (M8). */
export const OPERATOR_BLOCK_REASONS = [
  AvailabilityBlockReason.MAINTENANCE,
  AvailabilityBlockReason.BLACKOUT,
  AvailabilityBlockReason.SOFT_HOLD,
  AvailabilityBlockReason.OTHER,
] as const;

export class RangeQueryDto {
  @ApiProperty({ example: '2026-12-01T00:00:00.000Z' })
  @IsTimestamp()
  from: string;

  @ApiProperty({ example: '2026-12-31T00:00:00.000Z' })
  @IsTimestamp()
  to: string;
}

export class CreateSlotDto {
  @ApiProperty()
  @IsTimestamp()
  startsAt: string;

  @ApiProperty()
  @IsTimestamp()
  endsAt: string;

  @ApiProperty({ enum: AvailabilitySlotKind, enumName: 'AvailabilitySlotKind' })
  @IsEnum(AvailabilitySlotKind)
  kind: AvailabilitySlotKind;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  originId?: string | null;
}

export class UpdateSlotDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsTimestamp()
  startsAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsTimestamp()
  endsAt?: string;

  @ApiPropertyOptional({
    enum: AvailabilitySlotKind,
    enumName: 'AvailabilitySlotKind',
  })
  @IsOptional()
  @IsEnum(AvailabilitySlotKind)
  kind?: AvailabilitySlotKind;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  originId?: string | null;
}

export class CreateBlockDto {
  @ApiProperty()
  @IsTimestamp()
  startsAt: string;

  @ApiProperty()
  @IsTimestamp()
  endsAt: string;

  @ApiProperty({ enum: OPERATOR_BLOCK_REASONS })
  @IsIn(OPERATOR_BLOCK_REASONS)
  reason: (typeof OPERATOR_BLOCK_REASONS)[number];

  @ApiPropertyOptional({
    description: 'Required for a soft hold. When the hold lapses.',
  })
  @IsOptional()
  @IsTimestamp()
  expiresAt?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(500)
  note?: string;
}

export class SlotResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  aircraftId: string;

  @ApiProperty()
  startsAt: string;

  @ApiProperty()
  endsAt: string;

  @ApiProperty({ enum: AvailabilitySlotKind, enumName: 'AvailabilitySlotKind' })
  kind: AvailabilitySlotKind;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  originId: string | null;
}

export class BlockResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  aircraftId: string;

  @ApiProperty()
  startsAt: string;

  @ApiProperty()
  endsAt: string;

  @ApiProperty({
    enum: AvailabilityBlockReason,
    enumName: 'AvailabilityBlockReason',
  })
  reason: AvailabilityBlockReason;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  bookingId: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  expiresAt: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  note: string | null;
}

export class FleetAircraftDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  registration: string;

  @ApiProperty({
    enum: AircraftListingStatus,
    enumName: 'AircraftListingStatus',
  })
  listingStatus: AircraftListingStatus;

  @ApiProperty({
    enum: AircraftAvailabilityStatus,
    enumName: 'AircraftAvailabilityStatus',
  })
  availabilityStatus: AircraftAvailabilityStatus;

  @ApiProperty({ type: HomeBaseSummaryDto, nullable: true })
  homeBase: HomeBaseSummaryDto | null;
}

export class FleetCalendarResponseDto {
  @ApiProperty({ type: [FleetAircraftDto] })
  aircraft: FleetAircraftDto[];

  @ApiProperty({ type: [SlotResponseDto] })
  slots: SlotResponseDto[];

  @ApiProperty({ type: [BlockResponseDto] })
  blocks: BlockResponseDto[];

  @ApiProperty({
    description: `True when the range held more than ${2000} slots or blocks and the list was cut short`,
  })
  truncated: boolean;
}

export class CalendarResponseDto {
  @ApiProperty({ type: [SlotResponseDto] })
  slots: SlotResponseDto[];

  @ApiProperty({ type: [BlockResponseDto] })
  blocks: BlockResponseDto[];
}

export class SoftHoldConflictDto {
  @ApiProperty({ format: 'uuid' })
  aircraftId: string;

  @ApiProperty({ type: BlockResponseDto })
  hold: BlockResponseDto;

  @ApiProperty({ type: BlockResponseDto })
  overlaps: BlockResponseDto;
}
