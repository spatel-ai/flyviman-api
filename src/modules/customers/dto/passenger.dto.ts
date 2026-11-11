import {
  ApiProperty,
  ApiPropertyOptional,
  OmitType,
  PartialType,
} from '@nestjs/swagger';
import {
  IsEnum,
  IsISO31661Alpha2,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsDateOnly } from '../../../common/validation/formats.js';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import {
  Gender,
  IdentityDocumentType,
} from '../../../generated/prisma/enums.js';

const present = (_object: unknown, value: unknown) =>
  value !== null && value !== undefined;

export class CreatePassengerDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName: string;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @ValidateIf(present)
  @IsDateOnly()
  dateOfBirth?: string | null;

  @ApiPropertyOptional({ enum: Gender, enumName: 'Gender' })
  @OptionalNotNull()
  @IsEnum(Gender)
  gender?: Gender;

  @ApiPropertyOptional({ type: String, nullable: true, example: 'IN' })
  @ValidateIf(present)
  @IsISO31661Alpha2()
  nationality?: string | null;

  @ApiPropertyOptional({
    enum: IdentityDocumentType,
    enumName: 'IdentityDocumentType',
    nullable: true,
  })
  @ValidateIf(present)
  @IsEnum(IdentityDocumentType)
  documentType?: IdentityDocumentType | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'Stored encrypted.',
  })
  @ValidateIf(present)
  @IsString()
  @Matches(/^[A-Za-z0-9 -]{4,30}$/, {
    message:
      'documentNumber must be 4 to 30 letters, digits, spaces or hyphens',
  })
  documentNumber?: string | null;

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @ValidateIf(present)
  @IsDateOnly()
  documentExpiry?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @ValidateIf(present)
  @IsString()
  @MaxLength(500)
  specialAssistance?: string | null;
}

const NAME_FIELDS = ['firstName', 'lastName', 'gender'] as const;

/**
 * Every field optional. Names and gender cannot be cleared, so unlike the
 * other fields they do not accept `null`.
 */
export class UpdatePassengerDto extends PartialType(
  OmitType(CreatePassengerDto, NAME_FIELDS),
) {
  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  firstName?: string;

  @ApiPropertyOptional()
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  lastName?: string;

  @ApiPropertyOptional({ enum: Gender, enumName: 'Gender' })
  @OptionalNotNull()
  @IsEnum(Gender)
  gender?: Gender;
}

export class PassengerResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  dateOfBirth: string | null;

  @ApiProperty({ enum: Gender, enumName: 'Gender' })
  gender: Gender;

  @ApiProperty({ type: String, nullable: true })
  nationality: string | null;

  @ApiProperty({
    enum: IdentityDocumentType,
    enumName: 'IdentityDocumentType',
    nullable: true,
  })
  documentType: IdentityDocumentType | null;

  @ApiProperty({ type: String, nullable: true })
  documentNumber: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  documentExpiry: string | null;

  @ApiProperty({ type: String, nullable: true })
  specialAssistance: string | null;
}
