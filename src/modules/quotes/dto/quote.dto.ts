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

/**
 * What the operator writes beside its price. The cancellation terms are
 * Flyviman's (D-172): the quote carries the booking's snapshot, never the
 * operator's own.
 */
export class QuoteConditionsInputDto {
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
    minimum: 1,
    maximum: MAX_TOTAL_MINOR,
    description:
      "Paise: the operator's price for the trip, before Flyviman's commission, fees and tax (tax- and commission-exclusive). Flyviman's pricing rules work out the customer's total, labelled `QUOTE`, from it (D-172).",
  })
  @IsInt()
  @Min(1)
  @Max(MAX_TOTAL_MINOR)
  operatorPriceMinor: number;

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

/** A quote as the customer sees it: the total only. */
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

  @ApiProperty({
    type: QuoteConditionsDto,
    description:
      "`summary` and `charges` are Flyviman's cancellation terms the booking was requested on (D-172); `inclusions` and `exclusions` are the operator's.",
  })
  conditions: QuoteConditionsDto;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/**
 * What accepting a quote answers: references, status and time only, since an
 * idempotent answer is kept for replay (D-128); the operator's inclusions and
 * exclusions are free text. `GET /quotes/:reference` has the details.
 */
export class QuoteAcceptedDto {
  @ApiProperty({ example: 'FLY-QT-7K2M9Q' })
  reference: string;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty({ enum: QuoteStatus, enumName: 'QuoteStatus' })
  status: QuoteStatus;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/** The operator's own price for its quote; never in a customer's view (D-099). */
export class OperatorQuotePriceDto {
  @ApiProperty({
    enum: PriceType,
    enumName: 'PriceType',
    description: 'As the quote: `QUOTE` until accepted, then `CONFIRMED`.',
  })
  priceType: PriceType;

  @ApiProperty({ description: "Paise: the operator's price as entered." })
  amountMinor: number;

  @ApiProperty({
    description:
      'Paise: what Flyviman pays the operator (the price, less commission where commission is deducted).',
  })
  payableMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;
}

/** A quote as its operator sees it: the customer's view plus its own price. */
export class OperatorQuoteResponseDto extends QuoteResponseDto {
  @ApiProperty({
    type: OperatorQuotePriceDto,
    nullable: true,
    description:
      "Null for a quote sent before quotes were priced from the operator's price (D-172).",
  })
  operatorPrice: OperatorQuotePriceDto | null;
}
