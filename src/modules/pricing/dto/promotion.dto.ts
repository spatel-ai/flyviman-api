import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { IsPlainText } from '../../../common/validation/text.js';
import { PriceType } from '../../../generated/prisma/enums.js';
import { CODE_PATTERN, normalizeCode } from '../promotions.js';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const code = () =>
  Transform(({ value }) =>
    typeof value === 'string' ? normalizeCode(value) : value,
  );

/** ₹10 crore in paise, the ceiling on any amount (engineering checklist). */
const MAX_MINOR = 10_000_000_000;

export const PROMOTION_KINDS = ['PERCENT', 'FIXED'] as const;
/** The categories the engine prices; null is both. */
export const PROMOTION_CATEGORIES = ['PRIVATE_CHARTER', 'HELICOPTER'] as const;
export const PROMOTION_STATUSES = ['SCHEDULED', 'ACTIVE', 'ENDED'] as const;

export class CreatePromotionDto {
  @ApiProperty({
    description:
      'Letters, digits and dashes, 3–32 characters; kept upper case. Unique: 409 `PROMOTION_CODE_EXISTS`.',
    example: 'WINTER10',
  })
  @code()
  @IsString()
  @Matches(CODE_PATTERN, {
    message: 'code must be 3–32 letters, digits or inner dashes',
  })
  code!: string;

  @ApiProperty({
    minLength: 2,
    maxLength: 60,
    description: 'Shown to the customer on the discount line.',
    example: 'Winter offer',
  })
  @trim()
  @IsString()
  @IsPlainText()
  @MinLength(2)
  @MaxLength(60)
  name!: string;

  @ApiProperty({ enum: PROMOTION_KINDS })
  @IsIn(PROMOTION_KINDS)
  kind!: (typeof PROMOTION_KINDS)[number];

  @ApiPropertyOptional({
    description:
      'PERCENT only: a share of the price before tax, more than 0 and at most 100, two decimals at most.',
    example: 10,
  })
  @ValidateIf((dto: CreatePromotionDto) => dto.kind === 'PERCENT')
  @IsNumber({ maxDecimalPlaces: 2, allowNaN: false, allowInfinity: false })
  @Min(0.01)
  @Max(100)
  percent?: number;

  @ApiPropertyOptional({
    description: 'FIXED only: paise off (₹500 is 50000).',
    example: 50000,
  })
  @ValidateIf((dto: CreatePromotionDto) => dto.kind === 'FIXED')
  @IsInt()
  @Min(100)
  @Max(MAX_MINOR)
  amountMinor?: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency!: 'INR';

  @ApiPropertyOptional({
    enum: PROMOTION_CATEGORIES,
    nullable: true,
    description: 'Left out or null: charter and helicopter.',
  })
  @IsOptional()
  @IsIn(PROMOTION_CATEGORIES)
  category?: (typeof PROMOTION_CATEGORIES)[number] | null;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description:
      'With `destinationId`: only trips between the two places, either direction. Both or neither.',
  })
  @IsOptional()
  @IsUUID()
  originId?: string | null;

  @ApiPropertyOptional({ format: 'uuid', nullable: true })
  @IsOptional()
  @IsUUID()
  destinationId?: string | null;

  @ApiProperty({ format: 'date-time' })
  @IsISO8601({ strict: true })
  startsAt!: string;

  @ApiProperty({
    format: 'date-time',
    description: 'After `startsAt`, and in the future.',
  })
  @IsISO8601({ strict: true })
  endsAt!: string;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Bookings that may use the code in all. Null: no limit.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1_000_000)
  maxUses?: number | null;

  @ApiPropertyOptional({
    nullable: true,
    description: 'Bookings one customer may make with it. Null: no limit.',
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  maxUsesPerCustomer?: number | null;

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description: 'Why the promotion is created. Kept in the audit record.',
  })
  @trim()
  @IsString()
  @IsPlainText()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class EndPromotionDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description: 'Why it is ended early. Kept in the audit record.',
  })
  @trim()
  @IsString()
  @IsPlainText()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

export class ListPromotionsDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PROMOTION_STATUSES })
  @OptionalNotNull()
  @IsIn(PROMOTION_STATUSES)
  status?: (typeof PROMOTION_STATUSES)[number];
}

export class PromotionResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() code!: string;
  @ApiProperty() name!: string;
  @ApiProperty({ enum: PROMOTION_KINDS }) kind!: 'PERCENT' | 'FIXED';
  @ApiProperty({ type: Number, nullable: true }) percent!: number | null;
  @ApiProperty({ type: Number, nullable: true }) amountMinor!: number | null;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ enum: PROMOTION_CATEGORIES, nullable: true })
  category!: (typeof PROMOTION_CATEGORIES)[number] | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  originId!: string | null;
  @ApiProperty({ type: String, nullable: true }) originName!: string | null;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  destinationId!: string | null;
  @ApiProperty({ type: String, nullable: true })
  destinationName!: string | null;
  @ApiProperty({ format: 'date-time' }) startsAt!: string;
  @ApiProperty({ format: 'date-time' }) endsAt!: string;
  @ApiProperty({ type: Number, nullable: true }) maxUses!: number | null;
  @ApiProperty({ type: Number, nullable: true })
  maxUsesPerCustomer!: number | null;
  @ApiProperty({ description: 'Bookings made with the code so far.' })
  uses!: number;
  @ApiProperty({ enum: PROMOTION_STATUSES })
  status!: (typeof PROMOTION_STATUSES)[number];
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  endedAt!: string | null;
  @ApiProperty({ description: 'Whether it can still be ended.' })
  endable!: boolean;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

/** A customer's code, checked against one search result. */
export class ApplyPromoCodeDto {
  @ApiProperty({ example: 'WINTER10', maxLength: 32 })
  @code()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  code!: string;
}

export class PromoPriceDto {
  @ApiProperty({ enum: [PriceType.ESTIMATE], enumName: 'PriceType' })
  priceType!: PriceType;
  @ApiProperty({ description: 'Paise, with the code applied.' })
  amountMinor!: number;
  @ApiProperty({ example: 'INR' }) currency!: string;
  @ApiProperty({ format: 'date-time' }) validUntil!: string;
}

export class PromoLineDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty() amountMinor!: number;
}

export class PromoPreviewResponseDto {
  @ApiProperty({ example: 'WINTER10' }) code!: string;
  @ApiProperty({ description: 'The label of the discount line.' })
  name!: string;
  @ApiProperty({
    description:
      'Paise the code takes off this trip; 0 when it lowers nothing here (it is then not worth sending).',
  })
  amountOffMinor!: number;
  @ApiProperty({ type: PromoPriceDto }) price!: PromoPriceDto;
  @ApiProperty({ type: [PromoLineDto] }) breakdown!: PromoLineDto[];
  @ApiProperty({ type: [String] }) assumptions!: string[];
}
