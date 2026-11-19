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
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  AircraftCategory,
  BookingMode,
  BookingPaymentStatus,
  BookingStatus,
  Gender,
  IdentityDocumentType,
  PaymentModel,
  PriceType,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';

/** ₹10 crore in paise: far above any charter, far below 2^53. */
const MAX_TOTAL_MINOR = 10_000_000_000;

export class CreateBookingDto {
  @ApiProperty({
    format: 'uuid',
    description: 'From `POST /search/charter` or `/search/helicopter`.',
  })
  @IsUUID()
  searchId: string;

  @ApiProperty({ format: 'uuid', description: 'The chosen result.' })
  @IsUUID()
  resultId: string;

  @ApiProperty({
    description:
      'Paise: the estimate the customer saw and agrees to. The price is worked out again; if it differs, 409 `BOOKING_PRICE_CHANGED` carries the new estimate, and the customer can agree to it by sending it here with a new `Idempotency-Key`.',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_TOTAL_MINOR)
  expectedTotalMinor: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency: 'INR';

  @ApiPropertyOptional({
    type: [String],
    format: 'uuid',
    description:
      'Saved passengers (`/me/passengers`) to copy onto the booking, at most the search’s passenger count. May be left out and set later.',
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

export class BookingPriceDto {
  @ApiProperty({ enum: PriceType, enumName: 'PriceType' })
  priceType: PriceType;

  @ApiProperty({ description: 'Paise.' })
  amountMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    format: 'date-time',
    nullable: true,
    type: String,
    description:
      'Until when an `ESTIMATE` holds. The operator’s quote replaces it.',
  })
  validUntil: string | null;
}

/** What `POST /bookings` answers: references and statuses, no passenger data. */
export class BookingCreatedDto {
  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;

  @ApiProperty({ enum: BookingPaymentStatus, enumName: 'BookingPaymentStatus' })
  paymentStatus: BookingPaymentStatus;

  @ApiProperty({ type: BookingPriceDto })
  price: BookingPriceDto;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class ItineraryLegDto {
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

export class ItineraryAircraftDto {
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

export class ItineraryDto {
  @ApiProperty({ enum: [1] })
  version: 1;

  @ApiProperty({ enum: ['SEARCH'] })
  source: 'SEARCH';

  @ApiProperty({ format: 'uuid' })
  searchId: string;

  @ApiProperty({ format: 'uuid' })
  resultId: string;

  @ApiProperty({ enum: ['ONE_WAY', 'ROUND_TRIP'], enumName: 'SearchTripType' })
  tripType: 'ONE_WAY' | 'ROUND_TRIP';

  @ApiProperty()
  passengerCount: number;

  @ApiProperty({
    type: [ItineraryLegDto],
    description: 'One leg, or the outbound and the return.',
  })
  legs: ItineraryLegDto[];

  @ApiProperty({
    enum: ['WAIT', 'RETURN_TO_BASE'],
    enumName: 'RoundTripStrategy',
    nullable: true,
  })
  roundTripStrategy: 'WAIT' | 'RETURN_TO_BASE' | null;

  @ApiProperty({ type: ItineraryAircraftDto })
  aircraft: ItineraryAircraftDto;

  @ApiProperty()
  operatorName: string;

  @ApiProperty()
  distanceKm: number;

  @ApiProperty({ type: Number, nullable: true })
  flightMinutes: number | null;
}

export class CancellationChargeDto {
  @ApiProperty()
  minHoursBeforeDeparture: number;

  @ApiProperty({ minimum: 0, maximum: 100 })
  chargePercent: number;
}

export class CancellationTermsDto {
  @ApiProperty({ enum: [1] })
  version: 1;

  @ApiProperty({ enum: ['PLATFORM', 'OPERATOR_QUOTE'] })
  source: 'PLATFORM' | 'OPERATOR_QUOTE';

  @ApiProperty({ description: 'The text shown before the customer committed.' })
  summary: string;

  @ApiProperty({
    type: [CancellationChargeDto],
    description: 'Longest notice first. Empty: nothing can be charged yet.',
  })
  charges: CancellationChargeDto[];

  @ApiProperty({ format: 'date-time' })
  acceptedAt: string;
}

export class BookingPassengerDto {
  @ApiProperty()
  firstName: string;

  @ApiProperty()
  lastName: string;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  dateOfBirth: string | null;

  @ApiProperty({ enum: Gender, enumName: 'Gender' })
  gender: Gender;

  @ApiProperty({ type: String, nullable: true })
  nationality: string | null;

  @ApiProperty({
    enum: IdentityDocumentType,
    enumName: 'IdentityDocumentType',
    nullable: true,
  })
  documentType: IdentityDocumentType | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The document number’s last four characters only.',
  })
  documentNumberLast4: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  documentExpiry: string | null;

  @ApiProperty({ type: String, nullable: true })
  specialAssistance: string | null;
}

export class BookingResponseDto {
  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;

  @ApiProperty({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
    description:
      'Separate from `status`: payment never confirms a booking by itself.',
  })
  paymentStatus: BookingPaymentStatus;

  @ApiProperty({ enum: BookingMode, enumName: 'BookingMode' })
  bookingMode: BookingMode;

  @ApiProperty({ enum: PaymentModel, enumName: 'PaymentModel' })
  paymentModel: PaymentModel;

  @ApiProperty({ type: BookingPriceDto })
  price: BookingPriceDto;

  @ApiProperty({ type: ItineraryDto })
  itinerary: ItineraryDto;

  @ApiProperty({ type: CancellationTermsDto })
  cancellationTerms: CancellationTermsDto;

  @ApiProperty({ type: String, nullable: true })
  specialRequests: string | null;

  @ApiProperty({ type: [BookingPassengerDto] })
  passengers: BookingPassengerDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}
