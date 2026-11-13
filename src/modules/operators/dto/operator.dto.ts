import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  Equals,
  IsArray,
  IsEmail,
  IsEnum,
  IsIn,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import {
  DocumentVerificationStatus,
  OperatorDocumentType,
  OperatorStatus,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';
import { PASSWORD_MIN_LENGTH } from '../../../common/crypto/password.js';
import { E164, IsDateOnly } from '../../../common/validation/formats.js';
import { OperatorAccessDto } from './operator-staff.dto.js';

const present = (_object: unknown, value: unknown) =>
  value !== null && value !== undefined;

/** Categories an operator can offer. Scheduled airlines come from suppliers. */
export const OPERATOR_CATEGORIES = [
  ServiceCategory.PRIVATE_CHARTER,
  ServiceCategory.HELICOPTER,
  ServiceCategory.EMPTY_LEG,
  ServiceCategory.AIR_AMBULANCE,
];

export class AddressDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  line1: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf(present)
  @IsString()
  @MaxLength(200)
  line2?: string | null;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  city: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  state: string;

  @ApiProperty({ example: '400001' })
  @IsString()
  @Matches(/^[A-Za-z0-9 -]{3,12}$/, { message: 'postalCode is not valid' })
  postalCode: string;

  @ApiProperty({ example: 'IN', description: 'ISO 3166-1 alpha-2.' })
  @IsISO31661Alpha2()
  country: string;
}

export class RegisterOperatorDto {
  @ApiProperty({ example: 'Skyline Aviation Private Limited' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName: string;

  @ApiProperty({ example: 'Meera Nair' })
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  contactName: string;

  @ApiProperty({ description: 'Becomes the administrator sign-in.' })
  @IsEmail()
  @MaxLength(254)
  email: string;

  @ApiProperty({ format: 'password', minLength: PASSWORD_MIN_LENGTH })
  @IsString()
  @MinLength(PASSWORD_MIN_LENGTH)
  @MaxLength(200)
  password: string;

  @ApiPropertyOptional({ example: '+919876543210' })
  @IsOptional()
  @Matches(E164, {
    message: 'phone must be in international format, for example +919876543210',
  })
  phone?: string;

  @ApiProperty({ description: 'Must be true.' })
  @Equals(true, { message: 'acceptTerms must be true' })
  acceptTerms: boolean;
}

export class UpdateOperatorProfileDto {
  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  legalName?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf(present)
  @IsString()
  @MaxLength(200)
  tradingName?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf(present)
  @IsString()
  @MaxLength(50)
  registrationNumber?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, description: 'GSTIN.' })
  @ValidateIf(present)
  @IsString()
  @MaxLength(50)
  taxNumber?: string | null;

  @ApiPropertyOptional({ type: AddressDto, nullable: true })
  @ValidateIf(present)
  @ValidateNested()
  @Type(() => AddressDto)
  businessAddress?: AddressDto | null;

  @ApiPropertyOptional({ type: AddressDto, nullable: true })
  @ValidateIf(present)
  @ValidateNested()
  @Type(() => AddressDto)
  billingAddress?: AddressDto | null;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(2)
  @MaxLength(200)
  contactName?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsEmail()
  @MaxLength(254)
  contactEmail?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf(present)
  @Matches(E164, {
    message:
      'contactPhone must be in international format, for example +919876543210',
  })
  contactPhone?: string | null;

  @ApiPropertyOptional({ enum: OPERATOR_CATEGORIES, isArray: true })
  @OptionalNotNull()
  @IsArray()
  @ArrayUnique()
  @IsIn(OPERATOR_CATEGORIES, { each: true })
  serviceCategories?: ServiceCategory[];

  @ApiPropertyOptional({ type: [String], example: ['Maharashtra', 'Goa'] })
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  operatingRegions?: string[];
}

export class AddOperatorDocumentDto {
  @ApiProperty({ enum: OperatorDocumentType, enumName: 'OperatorDocumentType' })
  @IsEnum(OperatorDocumentType)
  type: OperatorDocumentType;

  @ApiProperty({
    format: 'uuid',
    description: 'From `POST /uploads/presign`, after the file was uploaded.',
  })
  @IsUUID()
  fileId: string;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @ValidateIf(present)
  @IsDateOnly()
  issuedAt?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @ValidateIf(present)
  @IsDateOnly()
  expiresAt?: string | null;
}

export class OperatorDocumentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: OperatorDocumentType, enumName: 'OperatorDocumentType' })
  type: OperatorDocumentType;

  @ApiProperty({
    format: 'uuid',
    description: 'Use with `GET /documents/:id/download`.',
  })
  fileId: string;

  @ApiProperty()
  fileName: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  issuedAt: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  expiresAt: string | null;

  @ApiProperty({
    enum: DocumentVerificationStatus,
    enumName: 'DocumentVerificationStatus',
  })
  verificationStatus: DocumentVerificationStatus;

  @ApiProperty({ type: String, nullable: true })
  verificationNote: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class OperatorProfileResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: OperatorStatus, enumName: 'OperatorStatus' })
  status: OperatorStatus;

  @ApiProperty()
  legalName: string;

  @ApiProperty({ type: String, nullable: true })
  tradingName: string | null;

  @ApiProperty({ type: String, nullable: true })
  registrationNumber: string | null;

  @ApiProperty({ type: String, nullable: true })
  taxNumber: string | null;

  @ApiProperty({ type: AddressDto, nullable: true })
  businessAddress: AddressDto | null;

  @ApiProperty({ type: AddressDto, nullable: true })
  billingAddress: AddressDto | null;

  @ApiProperty()
  contactName: string;

  @ApiProperty()
  contactEmail: string;

  @ApiProperty({ type: String, nullable: true })
  contactPhone: string | null;

  @ApiProperty({
    enum: ServiceCategory,
    enumName: 'ServiceCategory',
    isArray: true,
  })
  serviceCategories: ServiceCategory[];

  @ApiProperty({ type: [String] })
  operatingRegions: string[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  submittedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reviewedAt: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The reason given when the application was rejected or suspended.',
  })
  reviewNote: string | null;

  @ApiProperty({
    type: [String],
    description:
      'What is still needed before the application can be submitted. Empty when it is complete.',
  })
  missing: string[];
}

/** `GET /operator/me`: what the portal needs, for staff and administrators. */
export class OperatorMeResponseDto {
  @ApiProperty({ format: 'uuid' })
  operatorId: string;

  @ApiProperty({ enum: OperatorStatus, enumName: 'OperatorStatus' })
  status: OperatorStatus;

  @ApiProperty({ description: 'Trading name, or the legal name if none.' })
  displayName: string;

  @ApiProperty({ type: OperatorAccessDto })
  access: OperatorAccessDto;
}

export class AdminOperatorSummaryDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: OperatorStatus, enumName: 'OperatorStatus' })
  status: OperatorStatus;

  @ApiProperty()
  legalName: string;

  @ApiProperty({ type: String, nullable: true })
  tradingName: string | null;

  @ApiProperty()
  contactName: string;

  @ApiProperty()
  contactEmail: string;

  @ApiProperty({
    enum: ServiceCategory,
    enumName: 'ServiceCategory',
    isArray: true,
  })
  serviceCategories: ServiceCategory[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  submittedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class AdminOperatorDetailDto extends OperatorProfileResponseDto {
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reviewedById: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ type: [OperatorDocumentResponseDto] })
  documents: OperatorDocumentResponseDto[];
}

export class ListOperatorsDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: OperatorStatus, enumName: 'OperatorStatus' })
  @IsOptional()
  @IsEnum(OperatorStatus)
  status?: OperatorStatus;

  @ApiPropertyOptional({ description: 'Part of the legal or trading name.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  q?: string;
}

export class ReasonDto {
  @ApiProperty({ description: 'Shown to the operator and audited.' })
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason: string;
}

export const DOCUMENT_DECISIONS = [
  DocumentVerificationStatus.VERIFIED,
  DocumentVerificationStatus.REJECTED,
];

export class VerifyDocumentDto {
  @ApiProperty({ enum: DOCUMENT_DECISIONS })
  @IsIn(DOCUMENT_DECISIONS)
  decision: DocumentVerificationStatus;

  @ApiPropertyOptional({ description: 'Required when rejecting.' })
  @ValidateIf(
    (object: VerifyDocumentDto, value) =>
      object.decision === DocumentVerificationStatus.REJECTED ||
      present(object, value),
  )
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  reason?: string;
}
