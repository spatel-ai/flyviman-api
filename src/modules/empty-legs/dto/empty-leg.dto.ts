import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { type ListSort, SortField } from '../../../common/dto/list-sort.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { IsDateOnly } from '../../../common/validation/formats.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  AircraftCategory,
  EmptyLegStatus,
  PriceType,
} from '../../../generated/prisma/enums.js';
import { MAX_PRICE_MINOR } from '../empty-leg-rules.js';
import { CancellationTierTableDto } from '../../pricing/dto/cancellation-terms.dto.js';

const OFFSET = /(Z|[+-]\d{2}:\d{2})$/;
const trim = ({ value }: { value: unknown }) =>
  typeof value === 'string' ? value.trim() : value;

// --- Requests ----------------------------------------------------------------

export class CreateEmptyLegDto {
  @ApiProperty({
    format: 'uuid',
    description: 'An aircraft of your operator, within your reach.',
  })
  @IsUUID()
  aircraftId: string;

  @ApiProperty({ format: 'uuid', description: 'An active location.' })
  @IsUUID()
  originId: string;

  @ApiProperty({
    format: 'uuid',
    description: 'An active location, other than the origin.',
  })
  @IsUUID()
  destinationId: string;

  @ApiProperty({
    format: 'date-time',
    description: 'Earliest departure. ISO 8601 with offset, within 365 days.',
    example: '2026-12-05T08:00:00+05:30',
  })
  @IsISO8601({ strict: true })
  @Matches(OFFSET, { message: 'departureFrom must include a time zone offset' })
  departureFrom: string;

  @ApiProperty({
    format: 'date-time',
    description:
      'Latest departure. After `departureFrom`, in the future, at most 14 days after it.',
    example: '2026-12-05T18:00:00+05:30',
  })
  @IsISO8601({ strict: true })
  @Matches(OFFSET, { message: 'departureTo must include a time zone offset' })
  departureTo: string;

  @ApiProperty({
    minimum: 1,
    description: "Seats offered; at most the aircraft's passenger capacity.",
  })
  @IsInt()
  @Min(1)
  @Max(100)
  seatsAvailable: number;

  @ApiProperty({
    minimum: 1,
    maximum: MAX_PRICE_MINOR,
    description:
      'The whole offer, in paise (INR). What the customer pays; returned as a `QUOTE`.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_MINOR)
  priceMinor: number;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the offer stops being bookable: in the future and not after `departureTo`.',
  })
  @IsISO8601({ strict: true })
  @Matches(OFFSET, { message: 'validUntil must include a time zone offset' })
  validUntil: string;

  @ApiProperty({
    minLength: 10,
    maxLength: 2000,
    description: 'Booking conditions shown before the customer commits.',
  })
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  @IsPlainText()
  conditions: string;
}

/**
 * Every field optional. Aircraft, origin and destination are fixed once the
 * offer has been published.
 */
export class UpdateEmptyLegDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @OptionalNotNull()
  @IsUUID()
  aircraftId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @OptionalNotNull()
  @IsUUID()
  originId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @OptionalNotNull()
  @IsUUID()
  destinationId?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @OptionalNotNull()
  @IsISO8601({ strict: true })
  @Matches(OFFSET, { message: 'departureFrom must include a time zone offset' })
  departureFrom?: string;

  @ApiPropertyOptional({ format: 'date-time' })
  @OptionalNotNull()
  @IsISO8601({ strict: true })
  @Matches(OFFSET, { message: 'departureTo must include a time zone offset' })
  departureTo?: string;

  @ApiPropertyOptional({ minimum: 1 })
  @OptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(100)
  seatsAvailable?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: MAX_PRICE_MINOR })
  @OptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_MINOR)
  priceMinor?: number;

  @ApiPropertyOptional({ format: 'date-time' })
  @OptionalNotNull()
  @IsISO8601({ strict: true })
  @Matches(OFFSET, { message: 'validUntil must include a time zone offset' })
  validUntil?: string;

  @ApiPropertyOptional({ minLength: 10, maxLength: 2000 })
  @OptionalNotNull()
  @Transform(trim)
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  @IsPlainText()
  conditions?: string;
}

export class EmptyLegReasonDto {
  @ApiProperty({ minLength: 3, maxLength: 1000 })
  @Transform(trim)
  @IsString()
  @MinLength(3)
  @MaxLength(1000)
  @IsPlainText()
  reason: string;
}

export class OperatorEmptyLegQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: EmptyLegStatus, enumName: 'EmptyLegStatus' })
  @IsOptional()
  @IsEnum(EmptyLegStatus)
  status?: EmptyLegStatus;
}

/** The operator's list: the admin's filters do not apply, but the order does. */
export class OperatorEmptyLegListQueryDto extends OperatorEmptyLegQueryDto {
  @SortField()
  sort: ListSort = 'created_desc';
}

export class AdminEmptyLegQueryDto extends OperatorEmptyLegQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  operatorId?: string;
}

export class PublicEmptyLegQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ format: 'uuid', description: 'Origin location id.' })
  @IsOptional()
  @IsUUID()
  origin?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Destination location id.',
  })
  @IsOptional()
  @IsUUID()
  destination?: string;

  @ApiPropertyOptional({
    format: 'date',
    description:
      'YYYY-MM-DD, India time. Offers whose departure window ends on or after the start of this day.',
  })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    description:
      'YYYY-MM-DD, India time. Offers whose departure window starts on or before the end of this day.',
  })
  @IsOptional()
  @IsDateOnly()
  to?: string;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    description: 'At least this many seats available.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  passengers?: number;

  @ApiPropertyOptional({
    minimum: 1,
    description: 'Highest price, in paise.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(MAX_PRICE_MINOR)
  maxPrice?: number;
}

// --- Responses -----------------------------------------------------------------

export class EmptyLegLocationDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  city: string | null;

  @ApiProperty({ type: String, nullable: true })
  iata: string | null;

  @ApiProperty({ type: String, nullable: true })
  icao: string | null;

  @ApiProperty({ example: 'Asia/Kolkata' })
  timeZone: string;
}

export class EmptyLegAircraftDto {
  @ApiProperty({
    description: 'Manufacturer and model.',
    example: 'Cessna Citation CJ3+',
  })
  type: string;

  @ApiProperty({ enum: AircraftCategory, enumName: 'AircraftCategory' })
  category: AircraftCategory;

  @ApiProperty({ description: "The aircraft's passenger capacity." })
  seats: number;
}

export class OperatorEmptyLegAircraftDto extends EmptyLegAircraftDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  registration: string;
}

export class EmptyLegPriceDto {
  @ApiProperty({ description: 'Paise.' })
  amountMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    enum: PriceType,
    enumName: 'PriceType',
    description: "`QUOTE` for an operator's price. Never `CONFIRMED`.",
  })
  priceType: PriceType;
}

/** What a customer sees of a listed offer. */
export class EmptyLegResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'FLY-EL-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: EmptyLegStatus, enumName: 'EmptyLegStatus' })
  status: EmptyLegStatus;

  @ApiProperty({ type: EmptyLegAircraftDto })
  aircraft: EmptyLegAircraftDto;

  @ApiProperty()
  operatorName: string;

  @ApiProperty({ type: EmptyLegLocationDto })
  origin: EmptyLegLocationDto;

  @ApiProperty({ type: EmptyLegLocationDto })
  destination: EmptyLegLocationDto;

  @ApiProperty({ format: 'date-time' })
  departureFrom: string;

  @ApiProperty({ format: 'date-time' })
  departureTo: string;

  @ApiProperty()
  seatsAvailable: number;

  @ApiProperty({ type: EmptyLegPriceDto })
  price: EmptyLegPriceDto;

  @ApiProperty({
    format: 'date-time',
    description: 'Not bookable from this time.',
  })
  validUntil: string;

  @ApiProperty({ description: 'Booking conditions.' })
  conditions: string;
}

/** The public detail, with the caller's alert state. */
export class EmptyLegDetailResponseDto extends EmptyLegResponseDto {
  @ApiProperty({
    description:
      'Whether the signed-in customer follows this offer for change alerts. False when not signed in as a customer.',
  })
  interested: boolean;

  @ApiProperty({
    type: CancellationTierTableDto,
    description:
      "Flyviman's cancellation tiers, shown before a booking request (rule 9). Send `version` as `cancellationTermsVersion` with `POST /bookings/empty-leg`.",
  })
  cancellationTerms: CancellationTierTableDto;

  @ApiProperty({
    format: 'date-time',
    description:
      'When the offer last changed. Send it as `offerUpdatedAt` with `POST /bookings/empty-leg`.',
  })
  updatedAt: string;
}

/** The operator's and operations' view. */
export class OperatorEmptyLegResponseDto extends EmptyLegResponseDto {
  @ApiProperty({ type: OperatorEmptyLegAircraftDto })
  declare aircraft: OperatorEmptyLegAircraftDto;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why operations last rejected it; cleared on publishing again.',
  })
  reviewNote: string | null;

  @ApiProperty({ format: 'date-time', type: String, nullable: true })
  submittedAt: string | null;

  @ApiProperty({ format: 'date-time', type: String, nullable: true })
  publishedAt: string | null;

  @ApiProperty({ description: 'Customers following it.' })
  interestCount: number;

  @ApiProperty({
    description: 'Whether PATCH is allowed (draft or published).',
  })
  editable: boolean;

  @ApiProperty({ description: 'Whether publish is allowed (draft).' })
  publishable: boolean;

  @ApiProperty({
    description:
      'Whether withdraw is allowed (draft, under review or published, with no live booking request).',
  })
  withdrawable: boolean;

  @ApiProperty({
    description:
      'A customer’s booking request for the offer is live (M8-C): until it is answered the price, seats, departure window and conditions cannot change and the offer cannot be withdrawn (409 `EMPTY_LEG_HAS_LIVE_REQUEST`).',
  })
  hasLiveRequest: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

export class AdminEmptyLegResponseDto extends OperatorEmptyLegResponseDto {
  @ApiProperty({ format: 'uuid' })
  operatorId: string;
}

export class EmptyLegInterestResponseDto {
  @ApiProperty({ format: 'uuid' })
  emptyLegId: string;

  @ApiProperty({ example: true })
  interested: boolean;
}

export class EmptyLegExpiryRunDto {
  expired: number;
  skipped: boolean;
}
