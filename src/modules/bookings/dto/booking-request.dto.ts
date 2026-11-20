import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  BookingStatus,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';
import { QuoteResponseDto } from '../../quotes/dto/quote.dto.js';
import {
  BookingPriceDto,
  CancellationTermsDto,
  ChangeRequestResponseDto,
  ItineraryDto,
  ItineraryLegDto,
} from './booking.dto.js';

export class OperatorBookingRequestQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    enum: BookingStatus,
    enumName: 'BookingStatus',
    description:
      'Left out: the requests waiting for you (`OPERATOR_PENDING`, `CLARIFICATION_REQUESTED`).',
  })
  @IsOptional()
  @IsEnum(BookingStatus)
  status?: BookingStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  aircraftId?: string;
}

export class RejectBookingRequestDto {
  @ApiProperty({
    maxLength: 1000,
    description:
      'Why the request cannot be taken. Kept with the booking for the operator and Flyviman; the customer is told the request was not accepted.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(1000)
  @IsPlainText()
  reason: string;
}

export class BookingMessageInputDto {
  @ApiProperty({ maxLength: 2000 })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @IsPlainText()
  message: string;
}

export class BookingNoteInputDto {
  @ApiProperty({
    maxLength: 2000,
    description: 'An internal note: never shown to the customer.',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  @IsPlainText()
  note: string;
}

export class BookingRequestAircraftDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'VT-ABC' })
  registration: string;

  @ApiProperty()
  manufacturer: string;

  @ApiProperty()
  model: string;
}

export class BookingMessageDto {
  @ApiProperty({ enum: ['OPERATOR', 'CUSTOMER'] })
  from: 'OPERATOR' | 'CUSTOMER';

  @ApiProperty()
  body: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class BookingNoteDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  body: string;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

/** A booking request as the operator's inbox lists it: no passenger data. */
export class OperatorBookingRequestDto {
  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  reference: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;

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
      'The proposed price (an `ESTIMATE` from the search), or the confirmed one. Null for a request priced on request: send a quote.',
  })
  price: BookingPriceDto | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'When the hold on the aircraft lapses: answer before then, or the request closes as `OPERATOR_UNAVAILABLE`.',
  })
  holdExpiresAt: string | null;

  @ApiProperty({
    type: QuoteResponseDto,
    nullable: true,
    description: 'The newest quote sent, if any.',
  })
  quote: QuoteResponseDto | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

export class OperatorBookingRequestDetailDto extends OperatorBookingRequestDto {
  @ApiProperty({ type: ItineraryDto })
  itinerary: ItineraryDto;

  @ApiProperty({ type: CancellationTermsDto })
  cancellationTerms: CancellationTermsDto;

  @ApiProperty({ type: String, nullable: true })
  specialRequests: string | null;

  @ApiProperty({ type: [QuoteResponseDto], description: 'Newest first.' })
  quotes: QuoteResponseDto[];

  @ApiProperty({
    type: [BookingMessageDto],
    description: 'Questions and answers, oldest first.',
  })
  messages: BookingMessageDto[];

  @ApiProperty({
    type: [BookingNoteDto],
    description: 'Internal notes, oldest first.',
  })
  notes: BookingNoteDto[];

  @ApiProperty({
    type: [ChangeRequestResponseDto],
    description:
      'Change and cancellation requests, newest first; answer an open one (`REQUESTED`) with `POST /operator/change-requests/:id/decide`.',
  })
  changeRequests: ChangeRequestResponseDto[];
}
