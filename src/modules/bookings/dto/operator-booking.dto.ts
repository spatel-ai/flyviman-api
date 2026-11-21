import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  BookingPaymentStatus,
  BookingStatus,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';
import {
  BookingPriceDto,
  CancellationTermsDto,
  ItineraryDto,
  ItineraryLegDto,
} from './booking.dto.js';
import { BookingRequestAircraftDto } from './booking-request.dto.js';

export class OperatorBookingQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: BookingStatus,
    enumName: 'BookingStatus',
    description:
      'Left out: the upcoming trips (`CONFIRMED`, `SCHEDULED`). Any status may be asked for.',
  })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  aircraftId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'First departure at or after this time.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  departureFrom?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'First departure before this time.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  departureTo?: string;
}

/** A booking as the operator's bookings list shows it: no passenger data. */
export class OperatorBookingSummaryDto {
  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;

  @ApiProperty({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
    description:
      'Separate from `status`: a payment never confirms a booking by itself.',
  })
  paymentStatus: BookingPaymentStatus;

  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;

  @ApiProperty({ type: BookingRequestAircraftDto })
  aircraft: BookingRequestAircraftDto;

  @ApiProperty({ type: [ItineraryLegDto] })
  legs: ItineraryLegDto[];

  @ApiProperty()
  passengerCount: number;

  @ApiProperty({
    type: BookingPriceDto,
    nullable: true,
    description:
      'The customer’s total with its `priceType`. Null for a request still priced on request.',
  })
  price: BookingPriceDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

/** A traveller on the manifest: names only (never documents or assistance notes). */
export class OperatorBookingPassengerDto {
  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;
}

/** What the caller may do with the booking now; the API decides again on each call. */
export class OperatorBookingActionsDto {
  @ApiProperty({ description: '`CONFIRMED` → `SCHEDULED`.' })
  schedule: boolean;

  @ApiProperty({
    description: '`SCHEDULED` → `COMPLETED`, once the last leg has departed.',
  })
  complete: boolean;

  @ApiProperty({
    description: 'Cancel, with a reason, before it is completed.',
  })
  cancel: boolean;
}

export class OperatorBookingDetailDto extends OperatorBookingSummaryDto {
  @ApiProperty({ type: ItineraryDto })
  itinerary: ItineraryDto;

  @ApiProperty({ type: CancellationTermsDto })
  cancellationTerms: CancellationTermsDto;

  @ApiProperty({ type: String, nullable: true })
  specialRequests: string | null;

  @ApiProperty({
    type: [OperatorBookingPassengerDto],
    nullable: true,
    description:
      'The manifest (names only), once the booking is `CONFIRMED`, `SCHEDULED` or `COMPLETED`; null before then and after a cancellation.',
  })
  passengers: OperatorBookingPassengerDto[] | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: string | null;

  @ApiProperty({ type: OperatorBookingActionsDto })
  actions: OperatorBookingActionsDto;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/** The moves an operator makes on a confirmed booking. */
export const OPERATOR_STATUS_MOVES = [
  BookingStatus.SCHEDULED,
  BookingStatus.COMPLETED,
] as const;

export class UpdateOperatorBookingStatusDto {
  @ApiProperty({
    enum: OPERATOR_STATUS_MOVES,
    description:
      '`SCHEDULED` from `CONFIRMED`; `COMPLETED` from `SCHEDULED`, once the last leg has departed.',
  })
  @IsIn(OPERATOR_STATUS_MOVES)
  status: (typeof OPERATOR_STATUS_MOVES)[number];
}

export class CancelOperatorBookingDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description:
      'Why you cannot fly it. Kept for you and Flyviman (stored encrypted); the customer is told the booking was cancelled.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @IsPlainText()
  reason: string;
}
