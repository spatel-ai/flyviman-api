import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { E164 } from '../../../common/validation/formats.js';
import { EnquiryTopic } from '../../../generated/prisma/enums.js';

const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

/** Trimmed; an empty optional contact field counts as not sent. */
const trimOptional = ({ value }: { value: unknown }) => {
  const trimmed = trim({ value });
  return trimmed === '' ? undefined : trimmed;
};

/** Control and format characters (new lines, bidirectional overrides). */
const NO_CONTROL = /^[^\p{Cc}\p{Cf}]+$/u;
/** Bidirectional overrides, which can disguise text in the staff email. */
const BIDI = /[\u202A-\u202E\u2066-\u2069\u200E\u200F]/g;
const stripBidi = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.replace(BIDI, '').trim() : value;

/**
 * A sales enquiry from the contact page. Send `email`, `phone` or both; one
 * of them is required (400 `VALIDATION_ERROR` on `email` otherwise).
 */
export class CreateEnquiryDto {
  @ApiProperty({ minLength: 1, maxLength: 120, example: 'Asha Rao' })
  @Transform(trim)
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  // One line, so it cannot add lines of its own to the staff email.
  @Matches(NO_CONTROL, { message: 'name must be a single line of text' })
  name: string;

  @ApiPropertyOptional({
    maxLength: 254,
    description: 'Send this, `phone`, or both.',
    example: 'asha@example.com',
  })
  @IsOptional()
  @Transform(trimOptional)
  @IsEmail()
  @MaxLength(254)
  email?: string;

  @ApiPropertyOptional({
    description: 'E.164. Send this, `email`, or both.',
    example: '+919876543210',
  })
  @IsOptional()
  @Transform(trimOptional)
  @Matches(E164, {
    message: 'phone must be in international format, for example +919876543210',
  })
  phone?: string;

  @ApiProperty({ enum: EnquiryTopic, enumName: 'EnquiryTopic' })
  @IsEnum(EnquiryTopic)
  topic: EnquiryTopic;

  @ApiProperty({ minLength: 10, maxLength: 2000 })
  @Transform(stripBidi)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  message: string;
}

/** What the sender is told. Never echoes the contact details or message. */
export class EnquiryResponseDto {
  @ApiProperty({
    description: 'Quote it when following up.',
    example: 'FLY-ENQ-7K2M9Q',
  })
  reference: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-13T09:30:00.000Z' })
  receivedAt: string;
}
