import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
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
import { QuoteConditionsInputDto } from '../../quotes/dto/quote.dto.js';

/** ₹10 crore in paise, as for booking amounts. */
const MAX_TOTAL_MINOR = 10_000_000_000;

/**
 * A price set by Flyviman staff on a booking request (M10): a new quote,
 * never an edit of the one in place.
 */
export class OverridePriceDto {
  @ApiProperty({
    description:
      'Paise: the all-in price the customer pays (taxes and fees included).',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_TOTAL_MINOR)
  totalMinor!: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency!: 'INR';

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description:
      'Why the price is overridden. Kept on the calculation and in the audit record; never shown to the customer.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsPlainText()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      'Until when the customer may accept. Left out: 48 hours from now (`BOOKING_HOLD_HOURS`). Never after the first departure; at least an hour ahead.',
  })
  @OptionalNotNull()
  @IsISO8601({ strict: true })
  validUntil?: string;

  @ApiPropertyOptional({
    type: QuoteConditionsInputDto,
    description:
      'The conditions shown with the price (rule 9). Left out: those of the booking’s latest quote; required when it has none.',
  })
  @OptionalNotNull()
  @ValidateNested()
  @Type(() => QuoteConditionsInputDto)
  conditions?: QuoteConditionsInputDto;
}
