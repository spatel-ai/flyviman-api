import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  Max,
  Min,
  ValidateIf,
} from 'class-validator';

/** Largest amount accepted for one input: ₹10 crore, in paise. */
const MAX_MINOR = 10_000_000_000;

/**
 * Operator-wide pricing defaults (pricing-engine.md, "Who edits what").
 * The original five fields are required; `null` means "not set" (the
 * platform default or nothing applies). The round-trip charges (M5 slice
 * 4b) are optional: left out, the value in force is kept. Saving creates
 * new rule versions; unchanged fields write nothing.
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

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Round trips: per hour on the ground between a same-day outbound and return, in paise, beyond `waitingFreeHours`. Left out: unchanged; `null` clears.',
    example: 2000000,
  })
  @ValidateIf((_, value) => value != null)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  waitingHourlyMinor?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0,
    maximum: 24,
    description:
      'Hours of waiting not charged. Saved with `waitingHourlyMinor` (0 when left out or null); ignored without it.',
    example: 1,
  })
  @ValidateIf((_, value) => value != null)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0)
  @Max(24)
  waitingFreeHours?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Round trips: per night the aircraft spends away from base, in paise. Left out: unchanged; `null` clears.',
    example: 5000000,
  })
  @ValidateIf((_, value) => value != null)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  overnightMinor?: number | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      'Round trips: crew allowance and accommodation per night away from base, in paise (0 when included in the overnight charge). Left out: unchanged; `null` clears.',
    example: 3000000,
  })
  @ValidateIf((_, value) => value != null)
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  crewNightMinor?: number | null;
}

export class OperatorPricingResponseDto extends OperatorPricingDto {
  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({ type: Number, nullable: true })
  declare waitingHourlyMinor: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Null when no waiting charge is set.',
  })
  declare waitingFreeHours: number | null;

  @ApiProperty({ type: Number, nullable: true })
  declare overnightMinor: number | null;

  @ApiProperty({ type: Number, nullable: true })
  declare crewNightMinor: number | null;
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
      "Overrides the operator's minimum billable hours for this aircraft. Required; `null` clears the override.",
  })
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
