import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  PaymentPurpose,
  PaymentStatus,
  PriceType,
} from '../../../generated/prisma/enums.js';

/** ₹10 crore in paise: far above any charter, far below 2^53. */
const MAX_AMOUNT_MINOR = 10_000_000_000;

/** Gateway references: letters, digits, `_` and `-` only. */
const GATEWAY_ID = /^[A-Za-z0-9_-]+$/;

export class CreatePaymentDto {
  @ApiProperty({
    description:
      'Paise: the amount due that the customer was shown and agrees to pay. If it is not what is due now, 409 `PAYMENT_AMOUNT_MISMATCH` carries the amount due.',
  })
  @IsInt()
  @Min(1)
  @Max(MAX_AMOUNT_MINOR)
  expectedAmountMinor: number;

  @ApiProperty({ enum: ['INR'], example: 'INR' })
  @IsIn(['INR'])
  currency: 'INR';
}

/** What the gateway's checkout handed the browser after a payment. */
export class VerifyPaymentDto {
  @ApiProperty({ example: 'order_mock_000001' })
  @IsString()
  @MaxLength(64)
  @Matches(GATEWAY_ID)
  providerOrderId: string;

  @ApiProperty({ example: 'pay_mock_000002' })
  @IsString()
  @MaxLength(64)
  @Matches(GATEWAY_ID)
  providerPaymentId: string;

  @ApiProperty({ description: 'The checkout signature (hex HMAC-SHA256).' })
  @IsString()
  @MaxLength(128)
  @Matches(/^[0-9a-f]+$/)
  signature: string;
}

export class PaymentPriceDto {
  @ApiProperty({
    enum: [PriceType.CONFIRMED],
    enumName: 'PriceType',
    description: 'Only a confirmed price is ever charged (rule 1).',
  })
  priceType: PriceType;

  @ApiProperty({ description: 'Paise.' })
  amountMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;
}

/** The customer's own details for the gateway's checkout form. */
export class PaymentPrefillDto {
  @ApiProperty({ type: String, nullable: true })
  name: string | null;

  @ApiProperty({ type: String, nullable: true })
  email: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The phone on file (E.164); null when there is none.',
  })
  contact: string | null;
}

export class PaymentCheckoutDto {
  @ApiProperty({
    example: 'mock',
    description: 'The gateway the checkout is opened with.',
  })
  provider: string;

  @ApiProperty({ description: 'The public key ID. Never a secret.' })
  keyId: string;

  @ApiProperty({ example: 'order_mock_000001' })
  orderId: string;

  @ApiPropertyOptional({
    type: PaymentPrefillDto,
    description:
      'Only in the answer to `POST /bookings/:reference/payments`, to the booking’s owner: their own name, email and phone, to fill the checkout form.',
  })
  prefill?: PaymentPrefillDto;
}

/** One payment attempt, as the customer who owes it sees it. */
export class PaymentResponseDto {
  @ApiProperty({ example: 'FLY-PY-7K2M9Q' })
  reference: string;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty({
    enum: PaymentStatus,
    enumName: 'PaymentStatus',
    description:
      'Only a verified gateway notice makes it `SUCCEEDED` or `FAILED`; the checkout result makes it `PENDING` at most.',
  })
  status: PaymentStatus;

  @ApiProperty({
    enum: PaymentPurpose,
    enumName: 'PaymentPurpose',
    description:
      '`FULL` (models A and B), `DEPOSIT` (model C) or `BALANCE` (the rest after a model C deposit).',
  })
  purpose: PaymentPurpose;

  @ApiProperty({ type: PaymentPriceDto })
  price: PaymentPriceDto;

  @ApiProperty({ type: PaymentCheckoutDto })
  checkout: PaymentCheckoutDto;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  paidAt: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}
