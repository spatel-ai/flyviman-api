import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { SortedPageQueryDto } from '../../../common/dto/list-sort.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  BookingPaymentStatus,
  BookingStatus,
  ChangeRequestStatus,
  PriceType,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';
import {
  BookingPriceDto,
  CancellationChargeDto,
  CancellationTermsDto,
} from './booking.dto.js';

/** ₹10 crore in paise, as for `expectedTotalMinor`. */
const MAX_MINOR = 10_000_000_000;

// --- Trips list ------------------------------------------------------------

export const TRIP_VIEWS = ['upcoming', 'past'] as const;
export type TripView = (typeof TRIP_VIEWS)[number];

export class TripsQueryDto extends SortedPageQueryDto {
  @ApiPropertyOptional({
    enum: TRIP_VIEWS,
    default: 'upcoming',
    description:
      '`upcoming`: bookings still in progress (requested up to scheduled). `past`: completed, cancelled, expired, declined or unavailable. Decided by status, not by the departure time.',
  })
  @OptionalNotNull()
  @IsIn(TRIP_VIEWS)
  view: TripView = 'upcoming';

  @ApiPropertyOptional({ minimum: 1, maximum: 50, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  override pageSize: number = 20;
}

/** One row of the trips list: no passengers, no special requests. */
export class TripSummaryDto {
  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;

  @ApiProperty({ enum: BookingPaymentStatus, enumName: 'BookingPaymentStatus' })
  paymentStatus: BookingPaymentStatus;

  @ApiProperty({
    type: BookingPriceDto,
    nullable: true,
    description:
      'Null for a quote request (a result priced on request) until the customer accepts the operator’s quote.',
  })
  price: BookingPriceDto | null;

  @ApiProperty({ enum: ['ONE_WAY', 'ROUND_TRIP'], enumName: 'SearchTripType' })
  tripType: 'ONE_WAY' | 'ROUND_TRIP';

  @ApiProperty()
  originName: string;

  @ApiProperty()
  destinationName: string;

  @ApiProperty({ format: 'date-time', description: 'The first departure.' })
  departureAt: string;

  @ApiProperty()
  passengerCount: number;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

// --- Cancellation ----------------------------------------------------------

export class CancellationQuoteDto {
  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;

  @ApiProperty({
    type: CancellationTermsDto,
    description: 'The terms the booking was made on (rule 9).',
  })
  terms: CancellationTermsDto;

  @ApiProperty({
    description: 'Whole hours from now to the first departure; 0 once passed.',
  })
  hoursBeforeDeparture: number;

  @ApiProperty({
    type: CancellationChargeDto,
    nullable: true,
    description:
      'The rule that applies now. Notice shorter than every rule gets the last (shortest-notice) rule. Null when the terms carry no charges.',
  })
  appliedCharge: CancellationChargeDto | null;

  @ApiProperty({
    enum: PriceType,
    enumName: 'PriceType',
    description: 'Of the booking’s price.',
  })
  priceType: PriceType;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The booking’s price, paise. Null for a quote request, which has no price yet.',
  })
  totalMinor: number | null;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    description:
      'True only when the price is `CONFIRMED`. Otherwise the rule is shown but no money is charged: `chargeMinor` is 0.',
  })
  amountKnown: boolean;

  @ApiProperty({
    description:
      'Paise charged if cancelled now; rounded down. Send it back as `expectedChargeMinor` to cancel.',
  })
  chargeMinor: number;

  @ApiProperty({
    description:
      'Paise paid towards the booking: succeeded payments less refunds completed or under way, leaving out money flagged for a refund of its own (a late or second payment).',
  })
  paidMinor: number;

  @ApiProperty({
    description:
      'Paise due back: paid less the charge, never below 0. Nothing is moved here: finance makes the refund from its queue (`GET /admin/refunds/due`).',
  })
  refundMinor: number;

  @ApiProperty({ description: 'What the figures mean, in one sentence.' })
  explanation: string;

  @ApiProperty({ format: 'date-time' })
  evaluatedAt: string;
}

export class CancelBookingDto {
  @ApiProperty({
    description:
      'Paise: the charge the customer was shown (`GET …/cancellation-quote`). If it differs now, 409 `BOOKING_CANCELLATION_CHANGED` carries the new figures.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_MINOR)
  expectedChargeMinor: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency: 'INR';

  @ApiPropertyOptional({ maxLength: 500 })
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  @IsPlainText()
  reason?: string;
}

export class BookingCancelledDto {
  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;

  @ApiProperty({ format: 'date-time' })
  cancelledAt: string;

  @ApiProperty({ type: CancellationQuoteDto })
  cancellation: CancellationQuoteDto;
}

// --- Change requests -------------------------------------------------------

export class CreateChangeRequestDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 1000,
    description: 'What the customer would like changed, in their words.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @IsPlainText()
  details: string;
}

export const DECISIONS = [
  ChangeRequestStatus.APPROVED,
  ChangeRequestStatus.REJECTED,
] as const;

export class DecideChangeRequestDto {
  @ApiProperty({ enum: DECISIONS })
  @IsIn(DECISIONS)
  decision: (typeof DECISIONS)[number];

  @ApiProperty({
    minLength: 1,
    maxLength: 1000,
    description: 'Shown to the customer.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @IsPlainText()
  note: string;
}
