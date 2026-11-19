import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import {
  AircraftCategory,
  PriceType,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';

/** Fixed-wing categories a charter search can ask for. */
export const CHARTER_CATEGORIES = [
  AircraftCategory.TURBOPROP,
  AircraftCategory.LIGHT_JET,
  AircraftCategory.MIDSIZE_JET,
  AircraftCategory.HEAVY_JET,
] as const;

/** Trip types a search accepts. Multi-leg comes later. */
export const SEARCH_TRIP_TYPES = ['ONE_WAY', 'ROUND_TRIP'] as const;
export type SearchTripType = (typeof SEARCH_TRIP_TYPES)[number];

export const ROUND_TRIP_STRATEGIES = ['WAIT', 'RETURN_TO_BASE'] as const;

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;

/** A one-way or round trip. Multi-leg comes later in M5. */
export class HelicopterSearchDto {
  @ApiProperty({
    format: 'uuid',
    description: 'An active location (`GET /locations`).',
  })
  @IsUUID()
  originId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  destinationId: string;

  @ApiProperty({
    description: 'ISO 8601 with offset, at least an hour ahead.',
    example: '2026-12-05T10:00:00+05:30',
  })
  @IsISO8601({ strict: true })
  // A time without an offset would be read in the server's zone (D-099).
  @Matches(OFFSET, {
    message: 'departureAt must include a time zone offset (Z or +05:30)',
  })
  departureAt: string;

  @ApiPropertyOptional({
    enum: SEARCH_TRIP_TYPES,
    enumName: 'SearchTripType',
    default: 'ONE_WAY',
  })
  @IsOptional()
  @IsIn(SEARCH_TRIP_TYPES)
  tripType?: SearchTripType;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'Round trips only, and required for them (null or absent for one way): when the return flight leaves the destination. ISO 8601 with offset, at least an hour after `departureAt` and within 30 days of it.',
    example: '2026-12-07T16:00:00+05:30',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  @Matches(OFFSET, {
    message: 'returnAt must include a time zone offset (Z or +05:30)',
  })
  returnAt?: string | null;

  @ApiProperty({ minimum: 1, maximum: 50, example: 4 })
  @IsInt()
  @Min(1)
  @Max(50)
  passengerCount: number;
}

export class CharterSearchDto extends HelicopterSearchDto {
  @ApiPropertyOptional({
    enum: CHARTER_CATEGORIES,
    enumName: 'CharterCategory',
    description: 'Limit to one fixed-wing category. All of them when left out.',
  })
  @IsOptional()
  @IsIn(CHARTER_CATEGORIES)
  category?: (typeof CHARTER_CATEGORIES)[number];
}

export class SearchPriceDto {
  @ApiProperty({ enum: PriceType, enumName: 'PriceType' })
  priceType: PriceType;

  @ApiProperty({ description: 'Paise.' })
  amountMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;
}

export class SearchAircraftDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  manufacturer: string;

  @ApiProperty()
  model: string;

  @ApiProperty({ enum: AircraftCategory, enumName: 'AircraftCategory' })
  category: AircraftCategory;

  @ApiProperty()
  passengerCapacity: number;
}

export class SearchResultDto {
  @ApiProperty({ format: 'uuid' })
  resultId: string;

  @ApiProperty({ type: SearchAircraftDto })
  aircraft: SearchAircraftDto;

  @ApiProperty()
  operatorName: string;

  @ApiProperty({
    description:
      'The flying the customer books: out and back for a round trip.',
  })
  distanceKm: number;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Out and back for a round trip. Null when unknown.',
  })
  flightMinutes: number | null;

  @ApiProperty({ enum: SEARCH_TRIP_TYPES, enumName: 'SearchTripType' })
  tripType: SearchTripType;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description: 'The return departure; null for a one-way trip.',
  })
  returnAt: string | null;

  @ApiProperty({
    enum: ROUND_TRIP_STRATEGIES,
    enumName: 'RoundTripStrategy',
    nullable: true,
    description:
      'How the round trip was priced: the aircraft waits at the destination, or returns to base between the flights. Null for a one-way trip or a price on request.',
  })
  roundTripStrategy: (typeof ROUND_TRIP_STRATEGIES)[number] | null;

  @ApiProperty({
    type: SearchPriceDto,
    nullable: true,
    description: 'Always an `ESTIMATE`. Null when the price is on request.',
  })
  price: SearchPriceDto | null;

  @ApiProperty({ format: 'date-time' })
  validUntil: string;

  @ApiProperty({ type: [String] })
  warnings: string[];
}

export class SearchLegDto {
  @ApiProperty({ format: 'uuid' })
  originId: string;

  @ApiProperty()
  originName: string;

  @ApiProperty({ format: 'uuid' })
  destinationId: string;

  @ApiProperty()
  destinationName: string;

  @ApiProperty({ format: 'date-time' })
  departureAt: string;
}

export class SearchResponseDto {
  @ApiProperty({ format: 'uuid' })
  searchId: string;

  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;

  @ApiProperty({
    enum: CHARTER_CATEGORIES,
    enumName: 'CharterCategory',
    nullable: true,
    description: 'The fixed-wing class asked for; null for any.',
  })
  aircraftCategory: (typeof CHARTER_CATEGORIES)[number] | null;

  @ApiProperty({
    type: [SearchLegDto],
    description: 'One leg, or the outbound and the return for a round trip.',
  })
  legs: SearchLegDto[];

  @ApiProperty()
  passengerCount: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({
    type: [SearchResultDto],
    description: 'Priced first, cheapest first.',
  })
  results: SearchResultDto[];
}

export class BreakdownLineDto {
  @ApiProperty({
    example: 'FLYING',
    description:
      '`FLYING` is every flight (the legs, positioning and any return to base between them) in one line; other codes as the engine sets them (`WAITING`, `OVERNIGHT`, `CREW`, `LANDING_HANDLING`, `MIN_CHARGE`, `PLATFORM_FEE`, `TAX`).',
  })
  code: string;

  @ApiProperty()
  label: string;

  @ApiProperty({ description: 'Paise.' })
  amountMinor: number;

  @ApiPropertyOptional()
  basis?: string;
}

export class SearchResultDetailDto extends SearchResultDto {
  @ApiProperty({ format: 'uuid' })
  searchId: string;

  @ApiProperty({ type: [SearchLegDto] })
  legs: SearchLegDto[];

  @ApiProperty()
  passengerCount: number;

  @ApiProperty({ type: [BreakdownLineDto] })
  breakdown: BreakdownLineDto[];

  @ApiProperty({ type: [String] })
  assumptions: string[];

  @ApiProperty({ type: [String], description: 'What the estimate leaves out.' })
  exclusions: string[];

  @ApiProperty({
    enum: ['REQUEST'],
    description: 'Charter is confirmed only after the operator accepts.',
  })
  bookingMode: 'REQUEST';

  @ApiProperty({ type: [String] })
  confirmationRequirements: string[];

  @ApiProperty({
    description: 'Shown before the customer commits (business rule 9).',
  })
  cancellationNote: string;
}
