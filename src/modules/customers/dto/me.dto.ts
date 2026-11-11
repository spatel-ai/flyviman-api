import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO31661Alpha2,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { IsDateOnly } from '../../../common/validation/formats.js';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { ConsentType } from '../../../generated/prisma/enums.js';
import { UserResponseDto } from '../../users/dto/user-response.dto.js';

export class ProfileResponseDto {
  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  dateOfBirth: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'IN' })
  nationality: string | null;
}

export class MeResponseDto extends UserResponseDto {
  @ApiProperty({
    type: ProfileResponseDto,
    nullable: true,
    description: 'Present for customers; null for operator and internal users.',
  })
  profile: ProfileResponseDto | null;
}

export class UpdateMeDto {
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

  @ApiPropertyOptional({ type: String, format: 'date', nullable: true })
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsDateOnly()
  dateOfBirth?: string | null;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'ISO 3166-1 alpha-2.',
    example: 'IN',
  })
  @ValidateIf((_object, value) => value !== null && value !== undefined)
  @IsISO31661Alpha2()
  nationality?: string | null;
}

export class RecordConsentDto {
  @ApiProperty({ enum: ConsentType, enumName: 'ConsentType' })
  @IsEnum(ConsentType)
  type: ConsentType;

  @ApiPropertyOptional({
    description:
      'Required for BOOKING_CONDITIONS and MARKETING. Ignored for TERMS and PRIVACY, which always record the published version.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  version?: string;
}

export class ConsentResponseDto {
  @ApiProperty({ enum: ConsentType, enumName: 'ConsentType' })
  type: ConsentType;

  @ApiProperty()
  version: string;

  @ApiProperty({ format: 'date-time' })
  acceptedAt: string;
}
