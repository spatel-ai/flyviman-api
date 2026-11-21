import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';
import {
  BookingPaymentStatus,
  BookingStatus,
  ChangeRequestStatus,
} from '../../../generated/prisma/enums.js';
import { BookingAmountDueDto, BookingPriceDto } from './booking.dto.js';

/** What the customer's timeline shows (`GET /bookings/:reference/events`). */
export const CUSTOMER_EVENT_KINDS = [
  'STATUS_CHANGED',
  'QUOTE_SENT',
  'PAYMENT_UPDATED',
  'QUESTION_ASKED',
  'QUESTION_ANSWERED',
  'CHANGE_REQUESTED',
  'CHANGE_REQUEST_ANSWERED',
] as const;
export type CustomerEventKind = (typeof CUSTOMER_EVENT_KINDS)[number];

/** Who did it, coarsely: never a person's ID or a staff role. */
export const EVENT_ACTORS = ['YOU', 'OPERATOR', 'FLYVIMAN', 'SYSTEM'] as const;
export type EventActor = (typeof EVENT_ACTORS)[number];

/**
 * One entry of the customer's own timeline: a fixed list of fields, never
 * the stored payload. Internal notes, the operator's reasons and override
 * reasons are left out.
 */
export class CustomerBookingEventDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: CUSTOMER_EVENT_KINDS, enumName: 'CustomerEventKind' })
  kind: CustomerEventKind;

  @ApiProperty({ enum: EVENT_ACTORS, enumName: 'BookingEventActor' })
  by: EventActor;

  @ApiProperty({
    enum: BookingStatus,
    enumName: 'BookingStatus',
    nullable: true,
    description: '`STATUS_CHANGED` only; null for the request being made.',
  })
  fromStatus: BookingStatus | null;

  @ApiProperty({
    enum: BookingStatus,
    enumName: 'BookingStatus',
    nullable: true,
    description: '`STATUS_CHANGED` only.',
  })
  toStatus: BookingStatus | null;

  @ApiProperty({
    type: BookingPriceDto,
    nullable: true,
    description: '`QUOTE_SENT` only: the quoted total (`QUOTE`).',
  })
  price: BookingPriceDto | null;

  @ApiProperty({ type: String, nullable: true, example: 'FLY-QT-7K2M9Q' })
  quoteReference: string | null;

  @ApiProperty({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
    nullable: true,
    description: '`PAYMENT_UPDATED` only: the payment status it moved to.',
  })
  paymentStatus: BookingPaymentStatus | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'The change request, for `CHANGE_REQUEST*` entries.',
  })
  changeRequestId: string | null;

  @ApiProperty({
    enum: [ChangeRequestStatus.APPROVED, ChangeRequestStatus.REJECTED],
    enumName: 'ChangeRequestStatus',
    nullable: true,
    description: '`CHANGE_REQUEST_ANSWERED` only.',
  })
  decision: ChangeRequestStatus | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The note written for the customer with a change request’s answer.',
  })
  note: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

/** `PUT /bookings/:reference/passengers`: the booking's passengers, replaced. */
export class ReplacePassengersDto {
  @ApiProperty({
    type: [String],
    format: 'uuid',
    description:
      'Saved passengers (`/me/passengers`): at least one and at most the trip’s passenger count. Their details are copied onto the booking as they are now.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  passengerIds: string[];
}

/**
 * What the passenger change answers: no passenger data, since an idempotent
 * answer is kept for replay (`GET /bookings/:reference` has the details).
 */
export class PassengersReplacedDto {
  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  reference: string;

  @ApiProperty()
  passengerCount: number;
}

/** Why a booking cannot be flown as booked now, for the customer. */
export const UNAVAILABLE_REASONS = [
  'CLOSED',
  'DEPARTED',
  'OPERATOR_NOT_APPROVED',
  'AIRCRAFT_NOT_AVAILABLE',
  'TIME_TAKEN',
  'UNAVAILABLE',
] as const;
export type UnavailableReason = (typeof UNAVAILABLE_REASONS)[number];

/** `POST /bookings/:reference/revalidate`: the booking checked again (rule 3). */
export class BookingRevalidationDto {
  @ApiProperty({
    description:
      'Whether the trip can still be flown as booked: the trip ahead, the operator and aircraft approved and in service, the held time free.',
  })
  available: boolean;

  @ApiProperty({
    enum: UNAVAILABLE_REASONS,
    enumName: 'BookingUnavailableReason',
    nullable: true,
  })
  reason: UnavailableReason | null;

  @ApiProperty({
    type: BookingPriceDto,
    nullable: true,
    description:
      'The booking’s price, labelled. A `CONFIRMED` price is fixed once agreed and never repriced; null for a request priced on request.',
  })
  price: BookingPriceDto | null;

  @ApiProperty({
    description:
      'True for an `ESTIMATE` past its `validUntil`: the operator’s answer prices the trip again. Always false for a `CONFIRMED` price.',
  })
  priceExpired: boolean;

  @ApiProperty({
    type: BookingAmountDueDto,
    nullable: true,
    description:
      'What the booking owes now, by the rule payment creation applies; null when nothing is due or the trip is not available.',
  })
  amountDue: BookingAmountDueDto | null;

  @ApiProperty({ format: 'date-time' })
  checkedAt: string;
}
