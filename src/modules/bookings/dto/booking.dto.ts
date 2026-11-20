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
  ChangeRequestKind,
  ChangeRequestStatus,
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

  @ApiPropertyOptional({
    description:
      'Paise: the estimate the customer saw and agrees to. The price is worked out again; if it differs, 409 `BOOKING_PRICE_CHANGED` carries the new estimate, and the customer can agree to it by sending it here with a new `Idempotency-Key`. Left out for a result priced on request (`price: null`): the request then asks the operator for a quote.',
  })
  @OptionalNotNull()
  @IsInt()
  @Min(0)
  @Max(MAX_TOTAL_MINOR)
  expectedTotalMinor?: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency: 'INR';

  @ApiProperty({
    minimum: 1,
    description:
      "The `cancellationTerms.version` the result detail showed (rule 9). If Flyviman's tiers have changed since, 409 `BOOKING_TERMS_CHANGED` carries the current `version` and `summary`; show them and send again with the new version and a new `Idempotency-Key`.",
  })
  @IsInt()
  @Min(1)
  cancellationTermsVersion: number;

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

  @ApiPropertyOptional({
    maxLength: 32,
    description:
      'A promotion code, already previewed with `POST /search/:searchId/results/:resultId/promo-code`; `expectedTotalMinor` is then the price with the code. Checked again, with the caps, as the booking is made: 422 `PROMO_CODE_INVALID`, `PROMO_CODE_EXPIRED`, `PROMO_CODE_NOT_APPLICABLE` (also for a result priced on request) or `PROMO_CODE_LIMIT_REACHED`, and nothing is booked. One use of the code per booking.',
  })
  @OptionalNotNull()
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  promoCode?: string;
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

  @ApiProperty({
    type: BookingPriceDto,
    nullable: true,
    description:
      'Null for a quote request (a result priced on request) until the customer accepts the operator’s quote.',
  })
  price: BookingPriceDto | null;

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
    description:
      'The document number’s last four characters only; `••••` for a number of four characters or fewer.',
  })
  documentNumberLast4: string | null;

  @ApiProperty({ type: String, format: 'date', nullable: true })
  documentExpiry: string | null;

  @ApiProperty({ type: String, nullable: true })
  specialAssistance: string | null;
}

export class ChangeRequestResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty({ enum: ChangeRequestKind, enumName: 'ChangeRequestKind' })
  kind: ChangeRequestKind;

  @ApiProperty({ enum: ChangeRequestStatus, enumName: 'ChangeRequestStatus' })
  status: ChangeRequestStatus;

  @ApiProperty()
  details: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The decision’s note, once decided.',
  })
  decisionNote: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  decidedAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
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

  // Not `enumName`: that would replace the shared schema's description.
  @ApiProperty({
    enum: BookingMode,
    description: 'As resolved when the booking was made.',
  })
  bookingMode: BookingMode;

  @ApiProperty({
    enum: PaymentModel,
    description: 'As resolved when the booking was made.',
  })
  paymentModel: PaymentModel;

  @ApiProperty({
    type: BookingPriceDto,
    nullable: true,
    description:
      'Null for a quote request (a result priced on request) until the customer accepts the operator’s quote.',
  })
  price: BookingPriceDto | null;

  @ApiProperty({ type: ItineraryDto })
  itinerary: ItineraryDto;

  @ApiProperty({ type: CancellationTermsDto })
  cancellationTerms: CancellationTermsDto;

  @ApiProperty({ type: String, nullable: true })
  specialRequests: string | null;

  @ApiProperty({ type: [BookingPassengerDto] })
  passengers: BookingPassengerDto[];

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: string | null;

  @ApiProperty({
    type: [ChangeRequestResponseDto],
    description: 'Change and cancellation requests, newest first.',
  })
  changeRequests: ChangeRequestResponseDto[];

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}
