import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsIn,
  IsInt,
  IsISO8601,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { IsPlainText } from '../../../common/validation/text.js';
import { PriceType, QuoteStatus } from '../../../generated/prisma/enums.js';

/** ₹10 crore in paise, as for booking amounts. */
const MAX_TOTAL_MINOR = 10_000_000_000;

export class QuoteChargeInputDto {
  @ApiProperty({
    minimum: 0,
    maximum: 8760,
    description:
      'Applies when cancelling at least this many hours before departure.',
  })
  @IsInt()
  @Min(0)
  @Max(8760)
  minHoursBeforeDeparture: number;

  @ApiProperty({ minimum: 0, maximum: 100, description: 'Of the total.' })
  @IsInt()
  @Min(0)
  @Max(100)
  chargePercent: number;
}

export class QuoteConditionsInputDto {
  @ApiProperty({
    maxLength: 2000,
    description:
      'The cancellation conditions in words, shown to the customer before they accept (business rule 9).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @IsPlainText()
  summary: string;

  @ApiProperty({
    type: [QuoteChargeInputDto],
    description:
      'Cancellation charges by notice, longest notice first, each notice once. Empty: nothing is charged on cancellation.',
  })
  @IsArray()
  @ArrayMaxSize(10)
  @ValidateNested({ each: true })
  @Type(() => QuoteChargeInputDto)
  charges: QuoteChargeInputDto[];

  @ApiProperty({ type: [String], description: 'What the price includes.' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(200, { each: true })
  @IsPlainText({ each: true })
  inclusions: string[];

  @ApiProperty({ type: [String], description: 'What the price leaves out.' })
  @IsArray()
  @ArrayMaxSize(20)
  @IsString({ each: true })
  @MinLength(1, { each: true })
  @MaxLength(200, { each: true })
  @IsPlainText({ each: true })
  exclusions: string[];
}

export class ReviseQuoteDto {
  @ApiProperty({
    description:
      'Paise: the all-in price the customer pays (taxes and fees included).',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_TOTAL_MINOR)
  totalMinor: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency: 'INR';

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Until when the customer may accept. Left out: 48 hours from now (`BOOKING_HOLD_HOURS`). Never after the first departure; must be at least an hour ahead.',
  })
  @OptionalNotNull()
  @IsISO8601({ strict: true })
  validUntil?: string;

  @ApiProperty({ type: QuoteConditionsInputDto })
  @ValidateNested()
  @Type(() => QuoteConditionsInputDto)
  conditions: QuoteConditionsInputDto;
}

export class QuoteChargeDto {
  @ApiProperty()
  minHoursBeforeDeparture: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  chargePercent: number;
}

export class QuoteConditionsDto {
  @ApiProperty()
  summary: string;

  @ApiProperty({ type: [QuoteChargeDto] })
  charges: QuoteChargeDto[];

  @ApiProperty({ type: [String] })
  inclusions: string[];

  @ApiProperty({ type: [String] })
  exclusions: string[];
}

export class QuotePriceDto {
  @ApiProperty({
    enum: PriceType,
    enumName: 'PriceType',
    description: '`QUOTE` until the customer accepts it, then `CONFIRMED`.',
  })
  priceType: PriceType;

  @ApiProperty({ description: 'Paise.' })
  amountMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    format: 'date-time',
    description: 'The quote can be accepted until then.',
  })
  validUntil: string;
}

/** A quote as the customer and the operator see it. */
export class QuoteResponseDto {
  @ApiProperty({ example: 'FLY-QT-7K2M9Q' })
  reference: string;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty({ enum: QuoteStatus, enumName: 'QuoteStatus' })
  status: QuoteStatus;

  @ApiProperty({
    description:
      'True while the customer can still accept or decline it (sent, and before `validUntil`).',
  })
  open: boolean;

  @ApiProperty({ type: QuotePriceDto })
  price: QuotePriceDto;

  @ApiProperty({ type: QuoteConditionsDto })
  conditions: QuoteConditionsDto;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}
