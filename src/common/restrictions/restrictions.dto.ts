import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsObject,
  IsUUID,
  Matches,
  Max,
  Min,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { OptionalNotNull } from '../dto/optional.js';
import { LOCAL_TIME, RESTRICTION_LIMITS } from './restrictions.js';

/**
 * The restrictions of an aircraft or an operator (D-104), for requests and
 * responses. Every field is optional and none may be `null`; unknown keys
 * are refused by the global `forbidNonWhitelisted`. Reads go through
 * `parseRestrictions`.
 */

export class OperatingHoursDto {
  @ApiProperty({ example: '06:00', description: 'Local time, HH:MM (24 h).' })
  @Matches(LOCAL_TIME, {
    message: '$property must be a time in the form HH:MM',
  })
  start: string;

  @ApiProperty({
    example: '20:00',
    description: 'Local time, HH:MM (24 h). Before `start` spans midnight.',
  })
  @Matches(LOCAL_TIME, {
    message: '$property must be a time in the form HH:MM',
  })
  @ValidateBy({
    name: 'differsFromStart',
    validator: {
      validate: (value, args) =>
        value !== (args?.object as OperatingHoursDto | undefined)?.start,
      defaultMessage: () => 'end must differ from start',
    },
  })
  end: string;
}

export class AircraftRestrictionsDto {
  @ApiPropertyOptional({
    type: OperatingHoursDto,
    description:
      'When the aircraft may depart and arrive, in the local time of each location.',
  })
  @OptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => OperatingHoursDto)
  operatingHours?: OperatingHoursDto;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    maxItems: RESTRICTION_LIMITS.maxExcludedLocations,
    description: 'Locations the aircraft does not fly to or from.',
  })
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(RESTRICTION_LIMITS.maxExcludedLocations)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  excludedLocationIds?: string[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: RESTRICTION_LIMITS.maxNoticeMinutes,
    description: 'Notice needed before departure, in minutes.',
  })
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(RESTRICTION_LIMITS.maxNoticeMinutes)
  minimumNoticeMinutes?: number;
}
