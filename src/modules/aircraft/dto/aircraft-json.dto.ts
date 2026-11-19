import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsInt,
  IsObject,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateBy,
  ValidateNested,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import {
  hasHiddenCharacter,
  IsPlainText,
} from '../../../common/validation/text.js';
import {
  JSON_LIMITS,
  LOCAL_TIME,
  maxYearOfManufacture,
} from '../aircraft-json.js';

/**
 * Typed shapes of the aircraft JSON columns (D-104), used for both requests
 * and responses. Every field is optional and none may be `null`; unknown
 * keys are refused by the global `forbidNonWhitelisted`. Reads go through
 * the matching `parse…` functions in `aircraft-json.ts`.
 */

const NOT_BLANK = /\S/;

/** Text that is not blank, within a length, without hidden characters. */
const IsText = (max: number) =>
  applyDecorators(
    IsString(),
    Matches(NOT_BLANK, { message: '$property must not be blank' }),
    MaxLength(max),
    IsPlainText(),
  );

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
    maxItems: JSON_LIMITS.maxExcludedLocations,
    description: 'Locations the aircraft does not fly to or from.',
  })
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(JSON_LIMITS.maxExcludedLocations)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  excludedLocationIds?: string[];

  @ApiPropertyOptional({
    minimum: 0,
    maximum: JSON_LIMITS.maxNoticeMinutes,
    description: 'Notice needed before departure, in minutes.',
  })
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(JSON_LIMITS.maxNoticeMinutes)
  minimumNoticeMinutes?: number;
}

export class AircraftSpecificationsDto {
  @ApiPropertyOptional({
    maxLength: JSON_LIMITS.maxTextLength,
    description: 'A description of the cabin, shown to customers.',
  })
  @OptionalNotNull()
  @IsText(JSON_LIMITS.maxTextLength)
  cabin?: string;

  @ApiPropertyOptional({
    minimum: JSON_LIMITS.minYear,
    description: 'Up to next year.',
  })
  @OptionalNotNull()
  @IsInt()
  @Min(JSON_LIMITS.minYear)
  @ValidateBy({
    name: 'notLaterThanNextYear',
    validator: {
      validate: (value) =>
        typeof value !== 'number' || value <= maxYearOfManufacture(),
      defaultMessage: () =>
        'yearOfManufacture must not be later than next year',
    },
  })
  yearOfManufacture?: number;

  @ApiPropertyOptional({
    type: [String],
    maxItems: JSON_LIMITS.maxAmenities,
    example: ['Wi-Fi', 'Enclosed lavatory'],
  })
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(JSON_LIMITS.maxAmenities)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(NOT_BLANK, { each: true, message: 'each amenity must not be blank' })
  @MaxLength(JSON_LIMITS.maxAmenityLength, { each: true })
  @ValidateBy(
    {
      name: 'singleLineText',
      validator: {
        validate: (value) =>
          typeof value !== 'string' || !hasHiddenCharacter(value),
        defaultMessage: () =>
          'each amenity must not contain control or text-direction characters',
      },
    },
    { each: true },
  )
  amenities?: string[];
}

export class OxygenDto {
  @ApiProperty({ minimum: 1, maximum: JSON_LIMITS.maxOxygenLitres })
  @IsInt()
  @Min(1)
  @Max(JSON_LIMITS.maxOxygenLitres)
  litres: number;
}

export class AircraftMedicalEquipmentDto {
  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsBoolean()
  stretcher?: boolean;

  @ApiPropertyOptional({ type: OxygenDto })
  @OptionalNotNull()
  @IsObject()
  @ValidateNested()
  @Type(() => OxygenDto)
  oxygen?: OxygenDto;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsBoolean()
  ventilator?: boolean;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsBoolean()
  defibrillator?: boolean;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsBoolean()
  patientMonitor?: boolean;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsBoolean()
  incubator?: boolean;

  @ApiPropertyOptional({ minimum: 0, maximum: JSON_LIMITS.maxInfusionPumps })
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(JSON_LIMITS.maxInfusionPumps)
  infusionPumps?: number;

  @ApiPropertyOptional({ maxLength: JSON_LIMITS.maxTextLength })
  @OptionalNotNull()
  @IsText(JSON_LIMITS.maxTextLength)
  notes?: string;
}
