import { ApiProperty } from '@nestjs/swagger';
import { IsISO8601 } from 'class-validator';

export class ReconciliationQueryDto {
  @ApiProperty({
    format: 'date-time',
    example: '2026-11-01T00:00:00.000Z',
    description: 'Start of the period, inclusive.',
  })
  @IsISO8601({ strict: true })
  from: string;

  @ApiProperty({
    format: 'date-time',
    example: '2026-12-01T00:00:00.000Z',
    description:
      'End of the period, exclusive. At most 92 days after `from` (400 otherwise).',
  })
  @IsISO8601({ strict: true })
  to: string;
}

export const MISMATCH_KINDS = [
  'PAYMENT_SUMMARY_MISMATCH',
  'PAYMENT_FLAGGED',
  'EXTRA_MONEY_UNREFUNDED',
  'PAYMENT_STUCK',
  'REFUND_STUCK',
  'KEPT_EXCEEDS_TOTAL',
  'SETTLEMENT_MISSING',
  'SETTLEMENT_AMOUNT_MISMATCH',
  'SETTLEMENT_BOOKING_NOT_COMPLETED',
  'SETTLEMENT_REFERENCE_REUSED',
] as const;
export type MismatchKind = (typeof MISMATCH_KINDS)[number];

/** One currency's totals for the period. */
export class ReconciliationTotalsDto {
  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    description:
      'Payments whose money arrived (`SUCCEEDED` or later), by `paidAt` in the period.',
  })
  paymentsCount: number;

  @ApiProperty({ description: 'Paise: their amounts.' })
  paymentsInMinor: number;

  @ApiProperty({
    description:
      'Paise of those that were not towards a booking (paid after it closed, or paid twice): owed back.',
  })
  extraMoneyMinor: number;

  @ApiProperty({
    description: 'Paise of refunds started in the period that completed.',
  })
  refundsCompletedMinor: number;

  @ApiProperty({
    description:
      'Paise of refunds started in the period still on their way (`REQUESTED`, `PENDING`).',
  })
  refundsOpenMinor: number;

  @ApiProperty({
    description:
      'Bookings with a payment created in the period whose money arrived.',
  })
  bookingsCount: number;

  @ApiProperty({
    description:
      'Paise kept towards those bookings now: credited less refunds (extra money left out).',
  })
  bookingsKeptMinor: number;

  @ApiProperty({ description: 'Settlements created in the period.' })
  settlementsCount: number;

  @ApiProperty({ description: 'Paise payable to operators on them.' })
  settlementsPayableMinor: number;

  @ApiProperty({ description: 'Paise of commission on them.' })
  settlementsCommissionMinor: number;

  @ApiProperty({ description: 'Paise of tax on them.' })
  settlementsTaxMinor: number;

  @ApiProperty({
    description: 'Paise paid out to operators, by `paidAt` in the period.',
  })
  settlementsPaidMinor: number;
}

export class ReconciliationMismatchDto {
  @ApiProperty({
    enum: MISMATCH_KINDS,
    enumName: 'ReconciliationMismatchKind',
    description:
      '`PAYMENT_SUMMARY_MISMATCH` (the booking’s payment status is not what its payments say); `PAYMENT_FLAGGED` (another amount or a second capture at the gateway: check its dashboard); `EXTRA_MONEY_UNREFUNDED` (money paid after closing or twice, not yet refunded); `PAYMENT_STUCK` and `REFUND_STUCK` (no final answer after 24 hours); `KEPT_EXCEEDS_TOTAL`; `SETTLEMENT_MISSING` (a completed booking with money kept and no settlement); `SETTLEMENT_AMOUNT_MISMATCH` (the settlement’s figures do not add up to the money kept now); `SETTLEMENT_BOOKING_NOT_COMPLETED` (a due or paid settlement whose booking is no longer `COMPLETED`); `SETTLEMENT_REFERENCE_REUSED` (a payout reference, ignoring case, on more than one paid settlement, one of them paid in the period; one row per settlement, the reference in `detail`).',
  })
  kind: MismatchKind;

  @ApiProperty({ nullable: true, type: String })
  bookingReference: string | null;

  @ApiProperty({ nullable: true, type: String })
  paymentReference: string | null;

  @ApiProperty({ nullable: true, type: String })
  refundReference: string | null;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  settlementId: string | null;

  @ApiProperty({ description: 'What is wrong, for finance.' })
  detail: string;

  @ApiProperty({
    nullable: true,
    type: Number,
    description: 'Paise at stake, when there is one amount.',
  })
  amountMinor: number | null;

  @ApiProperty({ nullable: true, type: String })
  currency: string | null;
}

export class ReconciliationReportDto {
  @ApiProperty({ format: 'date-time' })
  from: string;

  @ApiProperty({ format: 'date-time' })
  to: string;

  @ApiProperty({ format: 'date-time' })
  generatedAt: string;

  @ApiProperty({ type: [ReconciliationTotalsDto] })
  totals: ReconciliationTotalsDto[];

  @ApiProperty({
    type: [ReconciliationMismatchDto],
    description: 'At most 200, bookings first by reference.',
  })
  mismatches: ReconciliationMismatchDto[];

  @ApiProperty({ description: 'Mismatches found, including any not listed.' })
  mismatchTotal: number;
}
