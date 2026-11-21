import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsIn,
  IsInt,
  IsString,
  IsUUID,
  Max,
  Min,
  MaxLength,
  MinLength,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { IsPlainText } from '../../../common/validation/text.js';

/** ₹10 crore in paise, the highest offer price (`MAX_PRICE_MINOR`). */
const MAX_TOTAL_MINOR = 1_000_000_000;

/** A booking request for a listed empty-leg offer (M8-C). */
export class CreateEmptyLegBookingDto {
  @ApiProperty({ format: 'uuid', description: 'From `GET /empty-legs`.' })
  @IsUUID()
  emptyLegId: string;

  @ApiProperty({
    minimum: 1,
    maximum: 50,
    description: 'Who is flying; at most the offer’s `seatsAvailable`.',
  })
  @IsInt()
  @Min(1)
  @Max(50)
  passengerCount: number;

  @ApiProperty({
    description:
      'Paise: the offer’s price as the customer saw it. If the operator changed it since, 409 `BOOKING_PRICE_CHANGED` carries the new one in `details` (`totalMinor`, `currency`, `priceType`, `validUntil`); send it back with a new `Idempotency-Key` to agree to it.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_TOTAL_MINOR)
  expectedTotalMinor: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency: 'INR';

  @ApiProperty({
    minimum: 1,
    description:
      "The `cancellationTerms.version` the offer detail showed (rule 9). If Flyviman's tiers have changed since, 409 `BOOKING_TERMS_CHANGED` carries the current `version` and `summary`.",
  })
  @IsInt()
  @Min(1)
  cancellationTermsVersion: number;

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Saved passengers (`/me/passengers`) to copy onto the booking, at most `passengerCount`. May be left out and set later.',
  })
  @OptionalNotNull()
  @IsArray()
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  passengerIds?: string[];

  @ApiPropertyOptional({ maxLength: 1000 })
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @IsPlainText()
  specialRequests?: string;
}
