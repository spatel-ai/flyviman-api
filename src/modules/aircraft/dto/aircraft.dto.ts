import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { IsDateOnly } from '../../../common/validation/formats.js';
import {
  AircraftAvailabilityStatus,
  AircraftCategory,
  AircraftDocumentType,
  AircraftListingStatus,
  AircraftMediaKind,
  AircraftPricingModel,
  DocumentVerificationStatus,
  WingType,
} from '../../../generated/prisma/enums.js';

const present = (_object: unknown, value: unknown) =>
  value !== null && value !== undefined;

export class CreateAircraftDto {
  @ApiProperty({ example: 'VT-ABC' })
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  registration: string;

  @ApiProperty({ example: 'Cessna' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  manufacturer: string;

  @ApiProperty({ example: 'Citation CJ3+' })
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  model: string;

  @ApiProperty({ enum: AircraftCategory, enumName: 'AircraftCategory' })
  @IsEnum(AircraftCategory)
  category: AircraftCategory;

  @ApiProperty({ enum: WingType, enumName: 'WingType' })
  @IsEnum(WingType)
  wingType: WingType;

  @ApiProperty({ example: 8 })
  @IsInt()
  @Min(1)
  @Max(100)
  passengerCapacity: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(50_000)
  baggageCapacityKg?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(20_000)
  rangeKm?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(2000)
  cruiseSpeedKmh?: number | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  homeBaseId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  currentLocationId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  operatingRegions?: string[];

  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsObject()
  restrictions?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    enum: AircraftPricingModel,
    enumName: 'AircraftPricingModel',
  })
  @IsOptional()
  @IsEnum(AircraftPricingModel)
  pricingModel?: AircraftPricingModel;

  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsObject()
  specifications?: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsObject()
  medicalEquipment?: Record<string, unknown> | null;
}

export class UpdateAircraftDto {
  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(2)
  @MaxLength(20)
  registration?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  manufacturer?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  model?: string;

  @ApiPropertyOptional({ enum: AircraftCategory, enumName: 'AircraftCategory' })
  @OptionalNotNull()
  @IsEnum(AircraftCategory)
  category?: AircraftCategory;

  @ApiPropertyOptional({ enum: WingType, enumName: 'WingType' })
  @OptionalNotNull()
  @IsEnum(WingType)
  wingType?: WingType;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(100)
  passengerCapacity?: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsInt()
  @Min(0)
  @Max(50_000)
  baggageCapacityKg?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(20_000)
  rangeKm?: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsInt()
  @Min(1)
  @Max(2000)
  cruiseSpeedKmh?: number | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  homeBaseId?: string | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsUUID()
  currentLocationId?: string | null;

  @ApiPropertyOptional({ type: [String] })
  @OptionalNotNull()
  @IsArray()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  operatingRegions?: string[];

  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsObject()
  restrictions?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    enum: AircraftPricingModel,
    enumName: 'AircraftPricingModel',
  })
  @OptionalNotNull()
  @IsEnum(AircraftPricingModel)
  pricingModel?: AircraftPricingModel;

  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsObject()
  specifications?: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: Object, nullable: true })
  @IsOptional()
  @ValidateIf(present)
  @IsObject()
  medicalEquipment?: Record<string, unknown> | null;
}

export class ListAircraftQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: AircraftListingStatus,
    enumName: 'AircraftListingStatus',
  })
  @IsOptional()
  @IsEnum(AircraftListingStatus)
  listingStatus?: AircraftListingStatus;
}

export class SetAvailabilityStatusDto {
  @ApiProperty({
    enum: AircraftAvailabilityStatus,
    enumName: 'AircraftAvailabilityStatus',
  })
  @IsEnum(AircraftAvailabilityStatus)
  status: AircraftAvailabilityStatus;
}

export class AddAircraftMediaDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  fileId: string;

  @ApiProperty({ enum: AircraftMediaKind, enumName: 'AircraftMediaKind' })
  @IsEnum(AircraftMediaKind)
  kind: AircraftMediaKind;

  @ApiPropertyOptional({ default: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(1000)
  sortOrder?: number;
}

export class AddAircraftDocumentDto {
  @ApiProperty({
    enum: AircraftDocumentType,
    enumName: 'AircraftDocumentType',
  })
  @IsEnum(AircraftDocumentType)
  type: AircraftDocumentType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  fileId: string;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2024-01-15' })
  @IsOptional()
  @ValidateIf(present)
  @IsDateOnly()
  issuedAt?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, example: '2030-12-31' })
  @IsOptional()
  @ValidateIf(present)
  @IsDateOnly()
  expiresAt?: string | null;
}

export class AircraftMediaResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  fileId: string;

  @ApiProperty()
  fileName: string;

  @ApiProperty({ enum: AircraftMediaKind, enumName: 'AircraftMediaKind' })
  kind: AircraftMediaKind;

  @ApiProperty()
  sortOrder: number;
}

export class AircraftDocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    enum: AircraftDocumentType,
    enumName: 'AircraftDocumentType',
  })
  type: AircraftDocumentType;

  @ApiProperty({ format: 'uuid' })
  fileId: string;

  @ApiProperty()
  fileName: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  issuedAt: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  expiresAt: string | null;

  @ApiProperty({
    enum: DocumentVerificationStatus,
    enumName: 'DocumentVerificationStatus',
  })
  verificationStatus: DocumentVerificationStatus;
}

/** Where an aircraft is based, with the zone its local times are shown in. */
export class HomeBaseSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'IATA code, else ICAO code',
  })
  code: string | null;

  @ApiProperty({ example: 'Asia/Kolkata' })
  timeZone: string;
}

export class AircraftResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  operatorId: string;

  @ApiProperty()
  registration: string;

  @ApiProperty()
  manufacturer: string;

  @ApiProperty()
  model: string;

  @ApiProperty({ enum: AircraftCategory, enumName: 'AircraftCategory' })
  category: AircraftCategory;

  @ApiProperty({ enum: WingType, enumName: 'WingType' })
  wingType: WingType;

  @ApiProperty()
  passengerCapacity: number;

  @ApiPropertyOptional({ type: Number, nullable: true })
  baggageCapacityKg: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  rangeKm: number | null;

  @ApiPropertyOptional({ type: Number, nullable: true })
  cruiseSpeedKmh: number | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  homeBaseId: string | null;

  @ApiProperty({ type: HomeBaseSummaryDto, nullable: true })
  homeBase: HomeBaseSummaryDto | null;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  currentLocationId: string | null;

  @ApiProperty({ type: [String] })
  operatingRegions: string[];

  @ApiPropertyOptional({ type: Object, nullable: true })
  restrictions: Record<string, unknown> | null;

  @ApiProperty({
    enum: AircraftAvailabilityStatus,
    enumName: 'AircraftAvailabilityStatus',
  })
  availabilityStatus: AircraftAvailabilityStatus;

  @ApiProperty({
    enum: AircraftListingStatus,
    enumName: 'AircraftListingStatus',
  })
  listingStatus: AircraftListingStatus;

  @ApiProperty({
    enum: AircraftPricingModel,
    enumName: 'AircraftPricingModel',
  })
  pricingModel: AircraftPricingModel;

  @ApiPropertyOptional({ type: Object, nullable: true })
  specifications: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: Object, nullable: true })
  medicalEquipment: Record<string, unknown> | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  submittedAt: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  reviewNote: string | null;

  @ApiProperty({ type: [String], description: 'Missing fields for submit.' })
  missing: string[];

  @ApiProperty({
    type: [String],
    description:
      'Why search (M4) would not offer this aircraft; empty when it would. `listingNotApproved`, `operatorNotApproved`, `notAvailable`, then the `missing` codes, including `document:<TYPE>` for a required document that is absent or expired.',
  })
  searchBlockers: string[];

  @ApiProperty({ type: [AircraftMediaResponseDto] })
  media: AircraftMediaResponseDto[];

  @ApiProperty({ type: [AircraftDocumentResponseDto] })
  documents: AircraftDocumentResponseDto[];

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;
}

export class AircraftSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  registration: string;

  @ApiProperty()
  manufacturer: string;

  @ApiProperty()
  model: string;

  @ApiProperty({ enum: AircraftCategory, enumName: 'AircraftCategory' })
  category: AircraftCategory;

  @ApiProperty()
  passengerCapacity: number;

  @ApiProperty({
    enum: AircraftAvailabilityStatus,
    enumName: 'AircraftAvailabilityStatus',
  })
  availabilityStatus: AircraftAvailabilityStatus;

  @ApiProperty({
    enum: AircraftListingStatus,
    enumName: 'AircraftListingStatus',
  })
  listingStatus: AircraftListingStatus;

  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  homeBaseId: string | null;

  @ApiProperty({ type: HomeBaseSummaryDto, nullable: true })
  homeBase: HomeBaseSummaryDto | null;
}

export class AdminAircraftQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: AircraftListingStatus,
    enumName: 'AircraftListingStatus',
  })
  @IsOptional()
  @IsEnum(AircraftListingStatus)
  listingStatus?: AircraftListingStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  operatorId?: string;
}

export class AdminAircraftSummaryDto extends AircraftSummaryResponseDto {
  @ApiProperty()
  operatorName: string;

  @ApiProperty({ format: 'uuid' })
  operatorId: string;
}

export class AdminAircraftDetailDto extends AircraftResponseDto {
  @ApiProperty()
  operatorName: string;
}

export class AircraftReasonDto {
  @ApiProperty()
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export const AIRCRAFT_DOCUMENT_DECISIONS = [
  DocumentVerificationStatus.VERIFIED,
  DocumentVerificationStatus.REJECTED,
] as const;

export class VerifyAircraftDocumentDto {
  @ApiProperty({ enum: AIRCRAFT_DOCUMENT_DECISIONS })
  @IsIn(AIRCRAFT_DOCUMENT_DECISIONS)
  decision: DocumentVerificationStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason?: string;
}
