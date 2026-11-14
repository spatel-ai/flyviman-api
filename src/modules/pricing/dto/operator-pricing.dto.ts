import { ApiProperty } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/** Largest amount accepted for one input: ₹10 crore, in paise. */
const MAX_MINOR = 10_000_000_000;

/**
 * Operator-wide pricing defaults (pricing-engine.md, "Who edits what").
 * Every field is required; `null` means "not set" (the platform default or
 * nothing applies). Saving creates new rule versions; unchanged fields
 * write nothing.
 */
export class OperatorPricingDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0.5,
    maximum: 12,
    description: 'Minimum billable hours per flight.',
    example: 1.5,
  })
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.5)
  @Max(12)
  minBillableHours: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 2,
    description:
      'Positioning and return flying, charged as this share of the hourly rate.',
    example: 0.8,
  })
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(2)
  positioningRateFactor: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 1000,
    description: 'Positioning within this distance is not charged.',
    example: 50,
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(1000)
  freeWithinKm: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Landing charge in paise, used where the airport has none on record.',
    example: 1500000,
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  landingFallbackMinor: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'Handling charge per stop in paise, used where the airport has none on record.',
    example: 500000,
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  handlingFallbackMinor: number | null;
}

export class OperatorPricingResponseDto extends OperatorPricingDto {
  @ApiProperty({ example: 'INR' })
  currency: string;
}

/** One aircraft's rate. `null` clears it (the aircraft is then priced on request). */
export class AircraftPricingDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Hourly rate in paise (₹1,80,000 is 18000000).',
    example: 18000000,
  })
  @ValidateIf((_, value) => value !== null)
  @IsInt()
  @Min(100)
  @Max(MAX_MINOR)
  hourlyRateMinor: number | null;

  @ApiProperty({
    description:
      'The rate already includes GST. It is reduced before tax is added.',
  })
  @IsBoolean()
  taxInclusive: boolean;

  @ApiProperty({
    description:
      "The rate already includes Flyviman's commission. It is reduced before commission is added.",
  })
  @IsBoolean()
  commissionInclusive: boolean;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 0.5,
    maximum: 12,
    description:
      "Overrides the operator's minimum billable hours for this aircraft.",
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.5)
  @Max(12)
  minBillableHours: number | null;
}

export class AircraftPricingResponseDto extends AircraftPricingDto {
  @ApiProperty({ format: 'uuid' })
  aircraftId: string;

  @ApiProperty({ example: 'INR' })
  currency: string;
}
