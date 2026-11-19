import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsUUID,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from '../../../common/validation/formats.js';

export const SCHEDULED_CABINS = [
  'ECONOMY',
  'PREMIUM_ECONOMY',
  'BUSINESS',
] as const;
export type ScheduledCabin = (typeof SCHEDULED_CABINS)[number];

export const SCHEDULED_DIRECTIONS = ['OUTBOUND', 'RETURN'] as const;
export const PROVIDER_STATUSES = ['OK', 'TIMEOUT', 'ERROR'] as const;
export const REVALIDATION_STATUSES = [
  'AVAILABLE',
  'PRICE_CHANGED',
  'SOLD_OUT',
] as const;

export class ScheduledPassengersDto {
  @ApiProperty({ minimum: 1, maximum: 9, example: 1 })
  @IsInt()
  @Min(1)
  @Max(9)
  adults: number;

  @ApiProperty({
    minimum: 0,
    maximum: 8,
    example: 0,
    description: 'Seated. Adults and children together at most 9.',
  })
  @IsInt()
  @Min(0)
  @Max(8)
  children: number;

  @ApiProperty({
    minimum: 0,
    example: 0,
    description: 'On a lap: at most one per adult.',
  })
  @IsInt()
  @Min(0)
  @Max(9)
  infants: number;
}

export class ScheduledSearchDto {
  @ApiProperty({
    format: 'uuid',
    description: 'An active airport with an IATA code (`GET /locations`).',
  })
  @IsUUID()
  originId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  destinationId: string;

  @ApiProperty({
    format: 'date',
    example: '2026-12-05',
    description:
      'Local date at the origin, `YYYY-MM-DD`: today there or later, within a year.',
  })
  @IsDateOnly()
  departureDate: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-12-08',
    description:
      'For a return trip: local date at the destination, on or after `departureDate`, within a year. Results then hold both directions.',
  })
  @IsOptional()
  @IsDateOnly()
  returnDate?: string;

  @ApiProperty({ type: ScheduledPassengersDto })
  @IsObject()
  @ValidateNested()
  @Type(() => ScheduledPassengersDto)
  passengers: ScheduledPassengersDto;

  @ApiProperty({ enum: SCHEDULED_CABINS, enumName: 'ScheduledCabin' })
  @IsIn(SCHEDULED_CABINS)
  cabin: ScheduledCabin;
}

export class ScheduledLocationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  iata: string | null;

  @ApiProperty({ type: String, nullable: true })
  icao: string | null;

  @ApiProperty({ example: 'Asia/Kolkata' })
  timeZone: string;
}

export class ScheduledCarrierDto {
  @ApiProperty({ example: '6E' })
  code: string;

  @ApiProperty({ example: 'IndiGo' })
  name: string;
}

export class ScheduledSegmentDto {
  @ApiProperty({ type: ScheduledLocationDto })
  from: ScheduledLocationDto;

  @ApiProperty({ type: ScheduledLocationDto })
  to: ScheduledLocationDto;

  @ApiProperty({
    example: '2026-12-05T06:15:00+05:30',
    description: 'Local time at `from`, ISO 8601 with its offset.',
  })
  departAt: string;

  @ApiProperty({
    example: '2026-12-05T08:25:00+05:30',
    description: 'Local time at `to`, ISO 8601 with its offset.',
  })
  arriveAt: string;

  @ApiProperty({ example: '6E 2131' })
  flightNumber: string;

  @ApiProperty()
  durationMinutes: number;
}

export class ScheduledFareDto {
  @ApiProperty({
    description:
      'Paise, the total for all travellers: adults, children and infants together.',
  })
  amountMinor: number;

  @ApiProperty({ enum: ['INR'] })
  currency: 'INR';

  @ApiProperty({
    enum: ['LIVE_FARE'],
    description:
      "The supplier's price now; rechecked by revalidation before payment.",
  })
  priceType: 'LIVE_FARE';

  @ApiProperty({ example: 'SAVER' })
  fareFamily: string;
}

export class ScheduledBaggageDto {
  @ApiProperty()
  cabinKg: number;

  @ApiProperty()
  checkedKg: number;
}

export class ScheduledOfferDto {
  @ApiProperty({ format: 'uuid' })
  offerId: string;

  @ApiProperty({ type: ScheduledCarrierDto })
  carrier: ScheduledCarrierDto;

  @ApiProperty({ type: [ScheduledSegmentDto] })
  segments: ScheduledSegmentDto[];

  @ApiProperty({
    enum: SCHEDULED_DIRECTIONS,
    enumName: 'ScheduledDirection',
  })
  direction: (typeof SCHEDULED_DIRECTIONS)[number];

  @ApiProperty()
  stops: number;

  @ApiProperty({ type: ScheduledFareDto })
  fare: ScheduledFareDto;

  @ApiProperty({ type: ScheduledBaggageDto })
  baggage: ScheduledBaggageDto;

  @ApiProperty()
  refundable: boolean;

  @ApiProperty({
    format: 'date-time',
    description:
      'The fare holds until then. Set at search time, when the search itself expires; a revalidation may store a new fare and validity, never past that.',
  })
  validUntil: string;
}

export class ScheduledProviderStatusDto {
  @ApiProperty({ example: 'mock' })
  name: string;

  @ApiProperty({ enum: PROVIDER_STATUSES, enumName: 'ScheduledProviderStatus' })
  status: (typeof PROVIDER_STATUSES)[number];
}

export class ScheduledSearchResponseDto {
  @ApiProperty({ format: 'uuid' })
  searchId: string;

  @ApiProperty({
    description:
      'True when a supplier timed out or failed: the results hold only the others.',
  })
  partial: boolean;

  @ApiProperty({ type: [ScheduledProviderStatusDto] })
  providers: ScheduledProviderStatusDto[];

  @ApiProperty({
    type: ScheduledPassengersDto,
    description:
      'The party searched for: every fare is the total for all of them.',
  })
  passengers: ScheduledPassengersDto;

  @ApiProperty({
    type: [ScheduledOfferDto],
    description:
      'Outbound first, then return; each by departure, then fare. Only flights with seats for the whole party; an offer found sold out at revalidation is left out.',
  })
  results: ScheduledOfferDto[];
}

export class ScheduledFareRuleDto {
  @ApiProperty({ example: 'Cancellation' })
  title: string;

  @ApiProperty()
  text: string;
}

export class ScheduledCancellationDto {
  @ApiProperty()
  refundable: boolean;

  @ApiPropertyOptional({
    description: 'Paise per passenger. Absent when the fare is not refundable.',
  })
  feeMinor?: number;
}

export class ScheduledChangeDto {
  @ApiProperty()
  allowed: boolean;

  @ApiPropertyOptional({
    description:
      'Paise per passenger, plus any fare difference. Absent when changes are not allowed.',
  })
  feeMinor?: number;
}

export class ScheduledFareRulesDto {
  @ApiProperty({ format: 'uuid' })
  offerId: string;

  @ApiProperty({ type: [ScheduledFareRuleDto] })
  rules: ScheduledFareRuleDto[];

  @ApiProperty({ type: ScheduledCancellationDto })
  cancellation: ScheduledCancellationDto;

  @ApiProperty({ type: ScheduledChangeDto })
  change: ScheduledChangeDto;
}

export class RevalidateScheduledDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  searchId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  offerId: string;
}

export class ScheduledRevalidationDto {
  @ApiProperty({
    enum: REVALIDATION_STATUSES,
    enumName: 'ScheduledRevalidationStatus',
  })
  status: (typeof REVALIDATION_STATUSES)[number];

  @ApiPropertyOptional({
    type: ScheduledFareDto,
    description: 'The fare now. Absent when sold out.',
  })
  fare?: ScheduledFareDto;

  @ApiPropertyOptional({
    format: 'date-time',
    description:
      "How long the rechecked fare holds, never past the search's expiry. Absent when sold out.",
  })
  validUntil?: string;
}
