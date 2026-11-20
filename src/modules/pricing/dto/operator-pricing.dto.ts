import { ApiProperty, ApiPropertyOptional, OmitType } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsNumber,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateBy,
  ValidateIf,
  ValidateNested,
} from 'class-validator';
import { AircraftPricingModel } from '../../../generated/prisma/enums.js';
import { hasHiddenCharacter } from '../../../common/validation/text.js';

/** Largest amount accepted for one input: ₹10 crore, in paise. */
const MAX_MINOR = 10_000_000_000;

/** Most fixed routes one aircraft can list. */
export const MAX_FIXED_ROUTES = 50;

const MIN_HOURS_PER = ['LEG', 'DAY'] as const;
export type MinHoursPer = (typeof MIN_HOURS_PER)[number];

/** One line of plain text: no control or text-direction characters. */
const IsOneLine = () =>
  ValidateBy({
    name: 'isOneLine',
    validator: {
      validate: (value: unknown) =>
        typeof value !== 'string' || !hasHiddenCharacter(value),
      defaultMessage: () =>
        '$property must be one line without control or text-direction characters',
    },
  });

/** An optional amount in paise: left out keeps it, `null` clears it. */
function OptionalMinor(description: string, example: number) {
  return function (target: object, key: string) {
    ApiPropertyOptional({ type: Number, nullable: true, description, example })(
      target,
      key,
    );
    ValidateIf((_, value) => value != null)(target, key);
    IsInt()(target, key);
    Min(0)(target, key);
    Max(MAX_MINOR)(target, key);
  };
}

const MIN_HOURS_PER_DOC =
  '`LEG`: each flight bills at least the minimum. `DAY`: the flights together bill at least the minimum for each day from departure to return (multi-day trips). Hourly-priced aircraft only. Left out: unchanged (`LEG` for a new minimum); `null` sets `LEG`.';

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
      'Hours of waiting not charged. Left out: unchanged (0 for a new waiting charge); `null` sets 0. Sent alone, it changes the free hours of the waiting charge in force; ignored when there is none.',
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

  @ApiPropertyOptional({
    enum: MIN_HOURS_PER,
    nullable: true,
    description: MIN_HOURS_PER_DOC,
  })
  @ValidateIf((_, value) => value != null)
  @IsIn(MIN_HOURS_PER)
  minBillableHoursPer?: MinHoursPer | null;

  @OptionalMinor(
    'Fuel surcharge per flight of the customer, in paise. Left out: unchanged; `null` clears.',
    500000,
  )
  fuelSurchargePerFlightMinor?: number | null;

  @OptionalMinor(
    'Permits per flight of the customer, in paise. Left out: unchanged; `null` clears.',
    200000,
  )
  permitPerFlightMinor?: number | null;

  @OptionalMinor(
    'Navigation charges per flight of the customer, in paise. Left out: unchanged; `null` clears.',
    100000,
  )
  navigationPerFlightMinor?: number | null;

  @OptionalMinor(
    'One other charge per trip, in paise, shown to customers under `otherChargeLabel`. Left out: unchanged; `null` clears it and its label.',
    300000,
  )
  otherChargeMinor?: number | null;

  @ApiPropertyOptional({
    minLength: 2,
    maxLength: 40,
    description:
      "The other charge's name, shown to customers. Required with a new other charge; left out: unchanged.",
    example: 'Catering',
  })
  @ValidateIf((_, value) => value !== undefined)
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsOneLine()
  @MinLength(2)
  @MaxLength(40)
  otherChargeLabel?: string;
}

export class OperatorPricingResponseDto extends OmitType(OperatorPricingDto, [
  'otherChargeLabel',
] as const) {
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

  @ApiProperty({
    enum: MIN_HOURS_PER,
    nullable: true,
    description: 'Null when no minimum is set.',
  })
  declare minBillableHoursPer: MinHoursPer | null;

  @ApiProperty({ type: Number, nullable: true })
  declare fuelSurchargePerFlightMinor: number | null;

  @ApiProperty({ type: Number, nullable: true })
  declare permitPerFlightMinor: number | null;

  @ApiProperty({ type: Number, nullable: true })
  declare navigationPerFlightMinor: number | null;

  @ApiProperty({ type: Number, nullable: true })
  declare otherChargeMinor: number | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Null when no other charge is set.',
  })
  otherChargeLabel: string | null;
}

/** A fixed price for one route, flown in either direction. */
export class FixedRouteDto {
  @ApiProperty({ format: 'uuid', description: 'An active location.' })
  @IsUUID()
  originId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'An active location other than the origin.',
  })
  @IsUUID()
  destinationId: string;

  @ApiProperty({
    description:
      "Price per flight in paise, under the aircraft's tax and commission flags.",
    example: 25000000,
  })
  @IsInt()
  @Min(100)
  @Max(MAX_MINOR)
  amountMinor: number;
}

export class FixedRouteResponseDto extends FixedRouteDto {
  @ApiProperty()
  originName: string;

  @ApiProperty()
  destinationName: string;
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
      "The aircraft's rates (hourly, sector, fixed routes) already include GST. They are reduced before tax is added.",
  })
  @IsBoolean()
  taxInclusive: boolean;

  @ApiProperty({
    description:
      "The aircraft's rates (hourly, sector, fixed routes) already include Flyviman's commission. They are reduced before commission is added.",
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

  @ApiPropertyOptional({
    enum: MIN_HOURS_PER,
    nullable: true,
    description: MIN_HOURS_PER_DOC,
  })
  @ValidateIf((_, value) => value != null)
  @IsIn(MIN_HOURS_PER)
  minBillableHoursPer?: MinHoursPer | null;

  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    description:
      "Price per flight in paise, used when the aircraft's pricing model is `SECTOR`. Left out: unchanged; `null` clears.",
    example: 25000000,
  })
  @ValidateIf((_, value) => value != null)
  @IsInt()
  @Min(100)
  @Max(MAX_MINOR)
  sectorRateMinor?: number | null;

  @ApiPropertyOptional({
    type: [FixedRouteDto],
    nullable: true,
    maxItems: MAX_FIXED_ROUTES,
    description:
      "Fixed prices per route, used when the aircraft's pricing model is `FIXED_ROUTE`; a route is priced in either direction and listed once. The complete list. Left out: unchanged; `null` or `[]` clears.",
  })
  @ValidateIf((_, value) => value != null)
  @IsArray()
  @ArrayMaxSize(MAX_FIXED_ROUTES)
  @ValidateNested({ each: true })
  @Type(() => FixedRouteDto)
  fixedRoutes?: FixedRouteDto[] | null;
}

export class AircraftPricingResponseDto extends AircraftPricingDto {
  @ApiProperty({ format: 'uuid' })
  aircraftId: string;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    enum: MIN_HOURS_PER,
    nullable: true,
    description: 'Null when no minimum is set.',
  })
  declare minBillableHoursPer: MinHoursPer | null;

  @ApiProperty({ type: Number, nullable: true })
  declare sectorRateMinor: number | null;

  @ApiProperty({
    type: [FixedRouteResponseDto],
    description: 'Empty when none is set.',
  })
  declare fixedRoutes: FixedRouteResponseDto[];
}

/** One aircraft's rate in the internal read, with what identifies it. */
export class AdminAircraftPricingDto extends AircraftPricingResponseDto {
  @ApiProperty({ example: 'VT-ABC' })
  registration: string;

  @ApiProperty()
  manufacturer: string;

  @ApiProperty()
  model: string;

  @ApiProperty({
    enum: AircraftPricingModel,
    enumName: 'AircraftPricingModel',
    description: 'Which of the rates the engine uses.',
  })
  pricingModel: AircraftPricingModel;
}

/** An operator's pricing inputs, read-only, for Flyviman staff (M10). */
export class AdminOperatorPricingDto {
  @ApiProperty({ format: 'uuid' })
  operatorId: string;

  @ApiProperty()
  operatorName: string;

  @ApiProperty({ type: OperatorPricingResponseDto })
  operator: OperatorPricingResponseDto;

  @ApiProperty({
    type: [AdminAircraftPricingDto],
    description: 'Newest first, at most 100.',
  })
  aircraft: AdminAircraftPricingDto[];

  @ApiProperty({ description: 'All of the operator’s aircraft.' })
  aircraftTotal: number;
}
