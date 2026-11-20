import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsOptional,
  IsIn,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  BookingPaymentStatus,
  BookingStatus,
  PaymentStatus,
  RefundStatus,
} from '../../../generated/prisma/enums.js';

/** ₹10 crore in paise, as for payments. */
const MAX_AMOUNT_MINOR = 10_000_000_000;

export class CreateRefundDto {
  @ApiProperty({
    description:
      'Paise to return: the whole refundable remainder for a full refund, or less for a partial one. More than the remainder is 409 `REFUND_EXCEEDS_REMAINDER`.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_MINOR)
  amountMinor: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency: 'INR';

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description:
      'Why the money goes back, for the audit trail (rule 6). Not shown to the customer. No personal or card details.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @IsPlainText()
  reason: string;
}

/** A refund as the customer sees it: no reason, no gateway references. */
export class RefundSummaryDto {
  @ApiProperty({ example: 'FLY-RF-7K2M9Q' })
  reference: string;

  @ApiProperty({ description: 'Paise.' })
  amountMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    enum: RefundStatus,
    enumName: 'RefundStatus',
    description:
      '`REQUESTED` (recorded, the gateway not yet answered), `PENDING` (the gateway is returning it), `COMPLETED` or `FAILED`.',
  })
  status: RefundStatus;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When it last changed: completion or failure once settled.',
  })
  updatedAt: string;
}

/** A refund as finance sees it after starting one. */
export class RefundResponseDto extends RefundSummaryDto {
  @ApiProperty({ example: 'FLY-PY-7K2M9Q' })
  paymentReference: string;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty()
  reason: string;

  @ApiProperty({
    enum: PaymentStatus,
    enumName: 'PaymentStatus',
    description: 'The payment after this refund was recorded.',
  })
  paymentStatus: PaymentStatus;

  @ApiProperty({
    description:
      'Paise still refundable from the payment after this refund (refunds completed or under way count).',
  })
  refundableMinor: number;
}

export const REFUND_DUE_KINDS = [
  'CANCELLATION',
  'BOOKING_CLOSED',
  'ALREADY_PAID',
] as const;
export type RefundDueKind = (typeof REFUND_DUE_KINDS)[number];

/** One payment finance should refund, and how much. */
export class RefundDueItemDto {
  @ApiProperty({
    enum: REFUND_DUE_KINDS,
    enumName: 'RefundDueKind',
    description:
      '`CANCELLATION`: a cancellation left money due back (paid less the charge); `BOOKING_CLOSED`: a payment succeeded after the booking expired or was cancelled; `ALREADY_PAID`: a second payment for a paid booking.',
  })
  kind: RefundDueKind;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  bookingStatus: BookingStatus;

  @ApiProperty({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
  })
  bookingPaymentStatus: BookingPaymentStatus;

  @ApiProperty({ example: 'FLY-PY-7K2M9Q' })
  paymentReference: string;

  @ApiProperty({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  paymentStatus: PaymentStatus;

  @ApiProperty({ description: 'Paise the payment took.' })
  paymentAmountMinor: number;

  @ApiProperty({
    description: 'Paise still refundable from this payment.',
  })
  refundableMinor: number;

  @ApiProperty({
    description:
      'Paise to refund from this payment: the cancellation’s outstanding refund due (spread over its payments, newest first), or the whole remainder of a flagged payment.',
  })
  dueMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    format: 'date-time',
    description: 'When it became due: the cancellation, or the payment.',
  })
  since: string;
}

export class AdminRefundsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: RefundStatus, enumName: 'RefundStatus' })
  @IsOptional()
  @IsEnum(RefundStatus)
  status?: RefundStatus;
}
