import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { IsPlainText } from '../../../common/validation/text.js';
import { NotificationChannel } from '../../../generated/prisma/enums.js';

export class ContentItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'summer-sale-1a2b3c' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ nullable: true, type: String, example: 'IN' })
  region: string | null;

  @ApiProperty()
  sortOrder: number;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'Null while unpublished (a draft).',
  })
  publishedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

export class CreateContentItemDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsPlainText()
  title: string;

  @ApiProperty({ maxLength: 5000 })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  @IsPlainText()
  body: string;

  @ApiPropertyOptional({ maxLength: 8, example: 'IN' })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  region?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({
    description: 'Publish now. Default false: saved as a draft.',
  })
  @IsOptional()
  @IsBoolean()
  published?: boolean;
}

export class UpdateContentItemDto {
  @ApiPropertyOptional({ maxLength: 200 })
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsPlainText()
  title?: string;

  @ApiPropertyOptional({ maxLength: 5000 })
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  @IsPlainText()
  body?: string;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 8 })
  @IsOptional()
  @IsString()
  @MaxLength(8)
  region?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 10000 })
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(10000)
  sortOrder?: number;

  @ApiPropertyOptional({
    description: 'true publishes (or keeps it published); false unpublishes.',
  })
  @OptionalNotNull()
  @IsBoolean()
  published?: boolean;
}

export class AdminPolicyResponseDto {
  @ApiProperty({ example: 'terms' })
  slug: string;

  @ApiProperty()
  title: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ example: '2026-11-19', nullable: true, type: String })
  version: string | null;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  publishedAt: string | null;

  @ApiProperty({
    description: 'Versions published so far, the current one included.',
  })
  versionCount: number;
}

export class PublishPolicyDto {
  @ApiProperty({ maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  @IsPlainText()
  title: string;

  @ApiProperty({
    maxLength: 50000,
    description: 'Plain text with blank lines between paragraphs.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  @IsPlainText()
  body: string;

  @ApiPropertyOptional({
    minimum: 0,
    maximum: 1000000,
    description:
      'The `versionCount` the editor loaded (0 for a policy with no version). When sent and another version has been published since, 409 `CONTENT_VERSION_CONFLICT` and nothing is written. Leave it out to publish regardless.',
  })
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(1000000)
  baseVersion?: number;
}

export class NotificationTemplateResponseDto {
  @ApiProperty({ example: 'customer.welcome' })
  key: string;

  @ApiProperty({ enum: NotificationChannel, enumName: 'NotificationChannel' })
  channel: NotificationChannel;

  @ApiProperty({ nullable: true, type: String })
  subject: string | null;

  @ApiProperty()
  body: string;

  @ApiProperty()
  isActive: boolean;

  @ApiProperty({
    type: [String],
    description:
      'Placeholders the built-in wording uses. A change must keep every one and may add none.',
  })
  placeholders: string[];

  @ApiProperty({
    description: 'False while no row is stored and the built-in text applies.',
  })
  stored: boolean;
}

export class UpdateNotificationTemplateDto {
  @ApiProperty({ enum: NotificationChannel, enumName: 'NotificationChannel' })
  @IsEnum(NotificationChannel)
  channel: NotificationChannel;

  @ApiPropertyOptional({ nullable: true, type: String, maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  subject?: string | null;

  @ApiProperty({ maxLength: 5000 })
  @IsString()
  @MinLength(1)
  @MaxLength(5000)
  body: string;

  @ApiProperty()
  @IsBoolean()
  isActive: boolean;
}
