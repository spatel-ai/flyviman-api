import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDefined,
  IsEnum,
  IsIn,
  IsInt,
  IsISO31661Alpha2,
  IsLatitude,
  IsLongitude,
  IsOptional,
  IsString,
  IsTimeZone,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import {
  AircraftCategory,
  LocationType,
} from '../../../generated/prisma/enums.js';
import { LocationResponseDto } from './location.dto.js';

/** Codes and country are stored in capitals whatever the caller sends. */
const upper = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toUpperCase() : value,
  );

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

/** ₹1 crore in paise: far above any real landing or handling charge. */
const MAX_CHARGE_MINOR = 1_000_000_000;

export const LOCATION_CURRENCIES = ['INR'];

export class AdminListLocationsDto extends PageQueryDto {
  @ApiPropertyOptional({ description: 'Part of a name or city, or a code.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;

  @ApiPropertyOptional({ enum: LocationType, enumName: 'LocationType' })
  @IsOptional()
  @IsEnum(LocationType)
  type?: LocationType;

  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isActive?: boolean;
}

/**
 * When capabilities are sent, every field must be present. Null means
 * unknown; omitting a field would otherwise clear it on update.
 */
export class LocationCapabilitiesInputDto {
  @ApiProperty({ type: Number, nullable: true, minimum: 1, maximum: 6000 })
  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(1)
  @Max(6000)
  runwayLengthM: number | null;

  @ApiProperty({ type: Boolean, nullable: true })
  @IsDefined()
  @ValidateIf((_, value) => value !== null)
  @IsBoolean()
  nightOperations: boolean | null;

  @ApiProperty()
  @IsBoolean()
  helicopterApproved: boolean;
}

export class CategoryChargeDto {
  @ApiProperty({ enum: AircraftCategory, enumName: 'AircraftCategory' })
  @IsEnum(AircraftCategory)
  category: AircraftCategory;

  @ApiProperty({ description: 'Per landing, in paise.', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_CHARGE_MINOR)
  landingMinor: number;

  @ApiProperty({ description: 'Per stop, in paise.', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_CHARGE_MINOR)
  parkingMinor: number;

  @ApiProperty({ description: 'Per stop, in paise.', minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(MAX_CHARGE_MINOR)
  handlingMinor: number;
}

/** Default charges at a location, one entry per aircraft category. */
export class LocationChargesDto {
  @ApiProperty({ enum: LOCATION_CURRENCIES, example: 'INR' })
  @IsIn(LOCATION_CURRENCIES)
  currency: string;

  @ApiProperty({ type: [CategoryChargeDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(Object.keys(AircraftCategory).length)
  @ArrayUnique((charge: CategoryChargeDto) => charge.category, {
    message: 'each aircraft category may appear only once',
  })
  @ValidateNested({ each: true })
  @Type(() => CategoryChargeDto)
  categories: CategoryChargeDto[];
}

export class CreateLocationDto {
  @ApiProperty({ enum: LocationType, enumName: 'LocationType' })
  @IsEnum(LocationType)
  type: LocationType;

  @ApiProperty({ example: 'Kedarnath Helipad' })
  @trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'BOM' })
  @IsOptional()
  @upper()
  @Matches(/^[A-Z]{3}$/, { message: 'iata must be three letters' })
  iata?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'VABB' })
  @IsOptional()
  @upper()
  @Matches(/^[A-Z]{4}$/, { message: 'icao must be four letters' })
  icao?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(100)
  state?: string | null;

  @ApiProperty({ example: 'IN' })
  @upper()
  @IsISO31661Alpha2()
  country: string;

  @ApiProperty({ example: 30.7346 })
  @IsLatitude()
  latitude: number;

  @ApiProperty({ example: 79.0669 })
  @IsLongitude()
  longitude: number;

  @ApiProperty({ example: 'Asia/Kolkata' })
  @IsTimeZone()
  timeZone: string;

  @ApiProperty({ type: LocationCapabilitiesInputDto })
  @IsDefined()
  @ValidateNested()
  @Type(() => LocationCapabilitiesInputDto)
  capabilities: LocationCapabilitiesInputDto;

  @ApiPropertyOptional({ type: LocationChargesDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationChargesDto)
  charges?: LocationChargesDto | null;
}

/** Any subset of the fields. `isActive: false` hides it from search. */
export class UpdateLocationDto {
  @ApiPropertyOptional({ enum: LocationType, enumName: 'LocationType' })
  @OptionalNotNull()
  @IsEnum(LocationType)
  type?: LocationType;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @trim()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @upper()
  @Matches(/^[A-Z]{3}$/, { message: 'iata must be three letters' })
  iata?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @upper()
  @Matches(/^[A-Z]{4}$/, { message: 'icao must be four letters' })
  icao?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(100)
  city?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @trim()
  @IsString()
  @MaxLength(100)
  state?: string | null;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @upper()
  @IsISO31661Alpha2()
  country?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsLatitude()
  latitude?: number;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsLongitude()
  longitude?: number;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsTimeZone()
  timeZone?: string;

  @ApiPropertyOptional({ type: LocationCapabilitiesInputDto })
  @OptionalNotNull()
  @ValidateNested()
  @Type(() => LocationCapabilitiesInputDto)
  capabilities?: LocationCapabilitiesInputDto;

  @ApiPropertyOptional({ type: LocationChargesDto, nullable: true })
  @IsOptional()
  @ValidateNested()
  @Type(() => LocationChargesDto)
  charges?: LocationChargesDto | null;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsBoolean()
  isActive?: boolean;
}

export class CategoryChargeResponseDto {
  @ApiProperty({ enum: AircraftCategory, enumName: 'AircraftCategory' })
  category: AircraftCategory;

  @ApiProperty()
  landingMinor: number;

  @ApiProperty()
  parkingMinor: number;

  @ApiProperty()
  handlingMinor: number;
}

export class LocationChargesResponseDto {
  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({ type: [CategoryChargeResponseDto] })
  categories: CategoryChargeResponseDto[];
}

/** Everything, for operations and super administrators. */
export class AdminLocationResponseDto extends LocationResponseDto {
  @ApiProperty({ type: LocationChargesResponseDto, nullable: true })
  charges: LocationChargesResponseDto | null;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Source of a seeded row, for example `ourairports:VABB`.',
  })
  externalRef: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}
