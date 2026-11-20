import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, Matches } from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { BOOKING_REFERENCE } from '../../../common/reference.js';
import {
  PaymentPurpose,
  PaymentReviewReason,
  PaymentStatus,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';
import { PaymentPriceDto, PaymentResponseDto } from './payment.dto.js';
import { RefundSummaryDto } from './refund.dto.js';

/** How the customer paid: the method type only, never card data (rule 10). */
export class PaymentMethodDto {
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'upi',
    description:
      'The gateway’s method type (`card`, `upi`, `netbanking`, `wallet`, …); null when it did not say.',
  })
  type: string | null;

  @ApiProperty({ example: 'UPI', description: 'For display.' })
  label: string;
}

/** One payment with its refunds (`GET /payments/:reference`). */
export class PaymentDetailDto extends PaymentResponseDto {
  @ApiProperty({ type: PaymentMethodDto })
  method: PaymentMethodDto;

  @ApiProperty({ description: 'Paise returned so far (completed refunds).' })
  refundedMinor: number;

  @ApiProperty({ type: [RefundSummaryDto], description: 'Oldest first.' })
  refunds: RefundSummaryDto[];
}

export class ReceiptIssuerDto {
  @ApiProperty({ example: 'Flyviman' })
  name: string;

  @ApiProperty({ type: String, nullable: true })
  address: string | null;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({ type: String, nullable: true })
  phone: string | null;
}

/**
 * A payment receipt (W4-1): what was paid, how and when, and what came back.
 * Explicitly not a GST tax invoice: the invoice format is not decided yet
 * (open decision 13).
 */
export class PaymentReceiptDto {
  @ApiProperty({ enum: ['PAYMENT_RECEIPT'] })
  documentType: 'PAYMENT_RECEIPT';

  @ApiProperty({
    example: 'This is a payment receipt, not a GST tax invoice.',
    description: 'Shown on every receipt, word for word.',
  })
  notice: string;

  @ApiProperty({
    example: 'FLY-PY-7K2M9Q',
    description: 'The payment reference.',
  })
  receiptNumber: string;

  @ApiProperty({ format: 'date-time' })
  issuedAt: string;

  @ApiProperty({ type: ReceiptIssuerDto })
  issuer: ReceiptIssuerDto;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;

  @ApiProperty({
    enum: PaymentPurpose,
    enumName: 'PaymentPurpose',
    description: '`FULL`, `DEPOSIT` or `BALANCE`.',
  })
  purpose: PaymentPurpose;

  @ApiProperty({
    type: PaymentPriceDto,
    description: 'What was paid, labelled `CONFIRMED` (rule 1).',
  })
  amount: PaymentPriceDto;

  @ApiProperty({ type: PaymentMethodDto })
  method: PaymentMethodDto;

  @ApiProperty({ format: 'date-time' })
  paidAt: string;

  @ApiProperty({ type: [RefundSummaryDto], description: 'Oldest first.' })
  refunds: RefundSummaryDto[];

  @ApiProperty({ description: 'Paise returned so far (completed refunds).' })
  refundedMinor: number;

  @ApiProperty({ description: 'Paise kept: the amount less refunds returned.' })
  netPaidMinor: number;
}

/** A booking's payment with its receipt (`GET /bookings/:reference/payments`). */
export class BookingPaymentDto extends PaymentDetailDto {
  @ApiProperty({
    type: PaymentReceiptDto,
    nullable: true,
    description: 'Null until the payment has succeeded.',
  })
  receipt: PaymentReceiptDto | null;
}

/** A payment as finance sees it (`GET /admin/payments`). */
export class AdminPaymentDto extends PaymentDetailDto {
  @ApiProperty({
    enum: PaymentReviewReason,
    enumName: 'PaymentReviewReason',
    nullable: true,
    description:
      'Set when a verified event needs a person: `BOOKING_CLOSED`, `ALREADY_PAID`, `AMOUNT_MISMATCH`, `DUPLICATE_CAPTURE`.',
  })
  reviewReason: PaymentReviewReason | null;
}

export class AdminPaymentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({
    enum: PaymentReviewReason,
    enumName: 'PaymentReviewReason',
  })
  @IsOptional()
  @IsEnum(PaymentReviewReason)
  reviewReason?: PaymentReviewReason;

  @ApiPropertyOptional({ example: 'FLY-BK-7K2M9Q' })
  @IsOptional()
  @Matches(BOOKING_REFERENCE)
  bookingReference?: string;
}
