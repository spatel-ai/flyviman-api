import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsEnum,
  IsInt,
  IsISO8601,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { E164 } from '../../../common/validation/formats.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  AirAmbulanceStatus,
  PatientMobility,
  PriceType,
} from '../../../generated/prisma/enums.js';

/** ₹2 crore in paise: the largest quotation the column holds safely. */
export const MAX_QUOTE_MINOR = 2_000_000_000;

/**
 * Shown with every air ambulance answer (rule 7): a request is not an
 * emergency response.
 */
export const EMERGENCY_NOTICE =
  'For an immediate medical emergency, call 112 or your local emergency services now. An air ambulance request is not an emergency response.';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** One line of text: no control or text-direction characters. */
const ONE_LINE = /^[^\p{Cc}\p{Cf}]+$/u;

export class MedicalDetailsInputDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 2000,
    description: 'Diagnosis and current condition. Stored encrypted.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @IsPlainText()
  patientCondition: string;

  @ApiProperty({ enum: PatientMobility, enumName: 'PatientMobility' })
  @IsEnum(PatientMobility)
  mobility: PatientMobility;

  @ApiProperty()
  @IsBoolean()
  stretcherRequired: boolean;

  @ApiProperty()
  @IsBoolean()
  oxygenRequired: boolean;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Stored encrypted.' })
  @OptionalNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @IsPlainText()
  medicalStaffRequired?: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Stored encrypted.' })
  @OptionalNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @IsPlainText()
  equipmentRequired?: string;

  @ApiPropertyOptional({ maxLength: 1000, description: 'Stored encrypted.' })
  @OptionalNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @IsPlainText()
  specialisedCare?: string;

  @ApiPropertyOptional({ maxLength: 2000, description: 'Stored encrypted.' })
  @OptionalNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @IsPlainText()
  notes?: string;
}

export class CreateAirAmbulanceRequestDto {
  @ApiProperty({ minLength: 1, maxLength: 120, example: 'Asha Rao' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(ONE_LINE, { message: 'contactName must be a single line of text' })
  contactName: string;

  @ApiProperty({ description: 'E.164.', example: '+919876543210' })
  @Matches(E164, {
    message:
      'contactPhone must be in international format, for example +919876543210',
  })
  contactPhone: string;

  @ApiPropertyOptional({ maxLength: 254 })
  @OptionalNotNull()
  @Transform(trim)
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @OptionalNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  @Matches(ONE_LINE, {
    message: 'emergencyContactName must be a single line of text',
  })
  emergencyContactName?: string;

  @ApiPropertyOptional({ description: 'E.164.' })
  @OptionalNotNull()
  @Matches(E164, {
    message:
      'emergencyContactPhone must be in international format, for example +919876543210',
  })
  emergencyContactPhone?: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The nearest airport or helipad to the patient.',
  })
  @IsUUID()
  originLocationId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'The nearest airport or helipad to the receiving facility.',
  })
  @IsUUID()
  destinationLocationId: string;

  @ApiPropertyOptional({
    maxLength: 300,
    description:
      'Where the patient is collected, for example a hospital. Stored encrypted.',
  })
  @OptionalNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(300)
  @IsPlainText()
  pickupAddress?: string;

  @ApiPropertyOptional({
    maxLength: 200,
    description: 'The receiving hospital or facility. Stored encrypted.',
  })
  @OptionalNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsPlainText()
  destinationFacility?: string;

  @ApiProperty({ format: 'date-time', description: 'UTC.' })
  @IsISO8601({ strict: true })
  preferredAt: string;

  @ApiProperty({ minimum: 1, maximum: 4, default: 1 })
  @IsInt()
  @Min(1)
  @Max(4)
  patientCount: number = 1;

  @ApiProperty({ minimum: 0, maximum: 6, default: 0 })
  @IsInt()
  @Min(0)
  @Max(6)
  accompanyingPersons: number = 0;

  @ApiProperty({ type: MedicalDetailsInputDto })
  @ValidateNested()
  @Type(() => MedicalDetailsInputDto)
  medical: MedicalDetailsInputDto;
}

/**
 * What `POST /air-ambulance/requests` answers. Kept to references and
 * statuses: the idempotency store keeps it for a day (no contact or medical
 * data).
 */
export class AirAmbulanceCreatedDto {
  @ApiProperty({ example: 'FLY-AA-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: AirAmbulanceStatus, enumName: 'AirAmbulanceStatus' })
  status: AirAmbulanceStatus;

  @ApiProperty({ example: EMERGENCY_NOTICE })
  emergencyNotice: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class AirAmbulanceQuotePriceDto {
  @ApiProperty({
    enum: PriceType,
    enumName: 'PriceType',
    description: 'Always `QUOTE`: an operator’s price sent by operations.',
  })
  priceType: PriceType;

  @ApiProperty({ description: 'Paise.' })
  amountMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;
}

export class AirAmbulanceQuoteDto {
  @ApiProperty({ type: AirAmbulanceQuotePriceDto })
  price: AirAmbulanceQuotePriceDto;

  @ApiProperty({ nullable: true, type: String })
  operatorName: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Service and cancellation conditions, shown before the customer accepts (rule 9).',
  })
  conditions: string | null;

  @ApiProperty({ format: 'date-time' })
  quotedAt: string;
}

/** A row of the customer's list. Never any medical data. */
export class AirAmbulanceSummaryDto {
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

  @ApiProperty({ type: AirAmbulanceQuotePriceDto, nullable: true })
  price: AirAmbulanceQuotePriceDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ example: EMERGENCY_NOTICE })
  emergencyNotice: string;
}

export class AirAmbulanceDocumentDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Download with `GET /documents/:id/download`.',
  })
  fileId: string;

  @ApiProperty()
  fileName: string;

  @ApiProperty()
  sizeBytes: number;
}

export class MedicalDetailsDto {
  @ApiProperty()
  patientCondition: string;

  @ApiProperty({ enum: PatientMobility, enumName: 'PatientMobility' })
  mobility: PatientMobility;

  @ApiProperty()
  stretcherRequired: boolean;

  @ApiProperty()
  oxygenRequired: boolean;

  @ApiProperty({ nullable: true, type: String })
  medicalStaffRequired: string | null;

  @ApiProperty({ nullable: true, type: String })
  equipmentRequired: string | null;

  @ApiProperty({ nullable: true, type: String })
  specialisedCare: string | null;

  @ApiProperty({ nullable: true, type: String })
  notes: string | null;

  @ApiProperty({ type: [AirAmbulanceDocumentDto] })
  documents: AirAmbulanceDocumentDto[];
}

export class AirAmbulanceTimelineEntryDto {
  @ApiProperty({ enum: AirAmbulanceStatus, enumName: 'AirAmbulanceStatus' })
  status: AirAmbulanceStatus;

  @ApiProperty({ format: 'date-time' })
  at: string;
}

/** One request as its requester sees it. */
export class AirAmbulanceRequestDto {
  @ApiProperty({ example: 'FLY-AA-7K2M9Q' })
  reference: string;

  @ApiProperty({
    enum: AirAmbulanceStatus,
    enumName: 'AirAmbulanceStatus',
    description:
      'Everything before CONFIRMED is a request, never a confirmed booking (rule 7).',
  })
  status: AirAmbulanceStatus;

  @ApiProperty()
  contactName: string;

  @ApiProperty()
  contactPhone: string;

  @ApiProperty({ nullable: true, type: String })
  contactEmail: string | null;

  @ApiProperty({ nullable: true, type: String })
  emergencyContactName: string | null;

  @ApiProperty({ nullable: true, type: String })
  emergencyContactPhone: string | null;

  @ApiProperty({ format: 'uuid' })
  originLocationId: string;

  @ApiProperty({ nullable: true, type: String })
  originName: string | null;

  @ApiProperty({ format: 'uuid' })
  destinationLocationId: string;

  @ApiProperty({ nullable: true, type: String })
  destinationName: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Stored encrypted; null unless the caller may read the medical details.',
  })
  pickupAddress: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'Stored encrypted; null unless the caller may read the medical details.',
  })
  destinationFacility: string | null;

  @ApiProperty({ format: 'date-time' })
  preferredAt: string;

  @ApiProperty()
  patientCount: number;

  @ApiProperty()
  accompanyingPersons: number;

  @ApiProperty({ type: AirAmbulanceQuoteDto, nullable: true })
  quote: AirAmbulanceQuoteDto | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  confirmedAt: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  completedAt: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  closedAt: string | null;

  @ApiProperty({
    type: MedicalDetailsDto,
    nullable: true,
    description:
      'Only for those who may read medical details; every read is audited.',
  })
  medical: MedicalDetailsDto | null;

  @ApiProperty({ type: [AirAmbulanceTimelineEntryDto] })
  timeline: AirAmbulanceTimelineEntryDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;

  @ApiProperty({ example: EMERGENCY_NOTICE })
  emergencyNotice: string;
}

export class AttachAirAmbulanceDocumentDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'From `POST /uploads/presign` with purpose `AIR_AMBULANCE_DOCUMENT`, after the upload.',
  })
  @IsUUID()
  fileId: string;
}

export class AcceptAirAmbulanceQuoteDto {
  @ApiProperty({ description: 'Paise: the quotation the customer saw.' })
  @IsInt()
  @Min(1)
  @Max(MAX_QUOTE_MINOR)
  expectedAmountMinor: number;
}
