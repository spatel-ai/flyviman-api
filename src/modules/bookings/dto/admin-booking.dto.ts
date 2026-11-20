import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  BookingEventType,
  BookingMode,
  BookingPaymentStatus,
  BookingStatus,
  ChangeRequestStatus,
  PaymentModel,
  PaymentPurpose,
  PaymentReviewReason,
  PaymentStatus,
  Role,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';
import { QuoteResponseDto } from '../../quotes/dto/quote.dto.js';
import {
  BookingPassengerDto,
  BookingPriceDto,
  CancellationTermsDto,
  ChangeRequestResponseDto,
  ItineraryDto,
} from './booking.dto.js';
import { BookingNoteDto } from './booking-request.dto.js';

export class AdminBookingQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    maxLength: 254,
    description:
      'A booking reference (or its start, `FLY-BK-7K2`), or the customer’s exact email address or phone number (E.164).',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(254)
  @IsPlainText()
  q?: string;

  @ApiPropertyOptional({ enum: BookingStatus, enumName: 'BookingStatus' })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
  })
  @IsOptional()
  @IsEnum(BookingPaymentStatus)
  paymentStatus?: BookingPaymentStatus;

  @ApiPropertyOptional({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  @IsOptional()
  @IsEnum(ServiceCategory)
  category?: ServiceCategory;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  operatorId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Requested at or after.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Requested before.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class AssignBookingDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'An active operations user or super administrator; `null` removes the owner.',
  })
  @ValidateIf((_, value) => value !== null)
  @IsUUID()
  assigneeId: string | null;
}

export class OverrideBookingStatusDto {
  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  @IsEnum(BookingStatus)
  status: BookingStatus;

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description:
      'Why the status is overridden. Kept on the timeline and in the audit trail; never put passenger or medical details here.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @IsPlainText()
  reason: string;
}

export class AdminBookingPartyDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true })
  name: string | null;
}

export class AdminBookingCustomerDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone: string | null;
}

export class AdminBookingSummaryDto {
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
    description: 'Null for a quote request until a quote is accepted.',
  })
  price: BookingPriceDto | null;

  @ApiProperty({ type: AdminBookingCustomerDto })
  customer: AdminBookingCustomerDto;

  @ApiProperty({ type: AdminBookingPartyDto, nullable: true })
  operator: AdminBookingPartyDto | null;

  @ApiProperty({ type: String, nullable: true, example: 'VT-ABC' })
  aircraftRegistration: string | null;

  @ApiProperty()
  originName: string;

  @ApiProperty()
  destinationName: string;

  @ApiProperty({ format: 'date-time', description: 'The first departure.' })
  departureAt: string;

  @ApiProperty()
  passengerCount: number;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The operations owner.',
  })
  assignedToId: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class AdminBookingEventDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: BookingEventType, enumName: 'BookingEventType' })
  type: BookingEventType;

  @ApiProperty({
    enum: BookingStatus,
    enumName: 'BookingStatus',
    nullable: true,
  })
  fromStatus: BookingStatus | null;

  @ApiProperty({
    enum: BookingStatus,
    enumName: 'BookingStatus',
    nullable: true,
  })
  toStatus: BookingStatus | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorId: string | null;

  @ApiProperty({ enum: Role, enumName: 'Role', nullable: true })
  actorRole: Role | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The reason of a status override (also in the audit trail).',
  })
  overrideReason: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class AdminBookingPaymentDto {
  @ApiProperty({ example: 'FLY-PY-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: PaymentPurpose, enumName: 'PaymentPurpose' })
  purpose: PaymentPurpose;

  @ApiProperty({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  status: PaymentStatus;

  @ApiProperty({
    type: BookingPriceDto,
    description: 'The amount of the order, always a `CONFIRMED` price.',
  })
  price: BookingPriceDto;

  @ApiProperty({
    enum: PaymentReviewReason,
    enumName: 'PaymentReviewReason',
    nullable: true,
  })
  reviewReason: PaymentReviewReason | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  paidAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class AdminBookingDetailDto extends AdminBookingSummaryDto {
  @ApiProperty({ enum: BookingMode, enumName: 'BookingMode' })
  bookingMode: BookingMode;

  @ApiProperty({ enum: PaymentModel, enumName: 'PaymentModel' })
  paymentModel: PaymentModel;

  @ApiProperty({ type: ItineraryDto })
  itinerary: ItineraryDto;

  @ApiProperty({ type: CancellationTermsDto })
  cancellationTerms: CancellationTermsDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  operatorAcceptedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  confirmedAt: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt: string | null;

  @ApiProperty({
    type: [BookingPassengerDto],
    nullable: true,
    description:
      'Operations and super administrators; null for finance (rule 8). Document numbers show the last four characters only.',
  })
  passengers: BookingPassengerDto[] | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Operations and super administrators; null for finance.',
  })
  specialRequests: string | null;

  @ApiProperty({ type: [AdminBookingEventDto], description: 'Oldest first.' })
  events: AdminBookingEventDto[];

  @ApiProperty({
    type: [BookingNoteDto],
    nullable: true,
    description:
      'Internal notes by operations, oldest first. Operations and super administrators; null for finance.',
  })
  notes: BookingNoteDto[] | null;

  @ApiProperty({ type: [QuoteResponseDto], description: 'Newest first.' })
  quotes: QuoteResponseDto[];

  @ApiProperty({
    type: [ChangeRequestResponseDto],
    description:
      'Newest first. For finance, `details` and `decisionNote` are empty and null.',
  })
  changeRequests: ChangeRequestResponseDto[];

  @ApiProperty({ type: [AdminBookingPaymentDto], description: 'Newest first.' })
  payments: AdminBookingPaymentDto[];
}

export class ChangeRequestQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: ChangeRequestStatus,
    enumName: 'ChangeRequestStatus',
    description: 'Default `REQUESTED`: the requests waiting for an answer.',
  })
  @IsOptional()
  @IsEnum(ChangeRequestStatus)
  status?: ChangeRequestStatus;
}
