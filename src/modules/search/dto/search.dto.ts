import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsISO8601,
  IsOptional,
  IsUUID,
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

/** A one-way trip. Round trips and multi-leg come later in M5. */
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
  departureAt: string;

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

  @ApiProperty()
  distanceKm: number;

  @ApiProperty({ nullable: true, type: Number })
  flightMinutes: number | null;

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

  @ApiProperty({ type: [SearchLegDto] })
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
  @ApiProperty({ example: 'OPERATING' })
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
