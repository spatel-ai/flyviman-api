import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEnum,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  BookingStatus,
  SettlementStatus,
} from '../../../generated/prisma/enums.js';

/** ₹10 crore in paise, as for payments and refunds. */
const MAX_AMOUNT_MINOR = 10_000_000_000;

export class AdminSettlementsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: SettlementStatus, enumName: 'SettlementStatus' })
  @IsOptional()
  @IsEnum(SettlementStatus)
  status?: SettlementStatus;
}

/** A settlement as finance sees it. */
export class AdminSettlementDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  bookingStatus: BookingStatus;

  @ApiProperty({ format: 'uuid' })
  operatorId: string;

  @ApiProperty()
  operatorName: string;

  @ApiProperty({
    description:
      'Paise owed to the operator: the money kept towards the booking less commission and tax.',
  })
  payableMinor: number;

  @ApiProperty({
    description:
      'Paise: Flyviman’s revenue on the price (commission, markup and service fee, less its discount).',
  })
  commissionMinor: number;

  @ApiProperty({ description: 'Paise of tax collected on the price.' })
  taxMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({
    enum: SettlementStatus,
    enumName: 'SettlementStatus',
    description:
      '`NOT_DUE` (the trip is not flown or not paid in full, a refund is on its way or the money kept does not cover the figures), `DUE`, `ON_HOLD` (held by finance) or `PAID` (paid out by hand; never changes again).',
  })
  status: SettlementStatus;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  paidAt: string | null;

  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The bank transfer reference of the payout.',
  })
  paymentReference: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/** A settlement as its operator sees it: what it is owed, not the split. */
export class OperatorSettlementDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ example: 'FLY-BK-7K2M9Q' })
  bookingReference: string;

  @ApiProperty({ description: 'Paise owed to the operator.' })
  payableMinor: number;

  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({ enum: SettlementStatus, enumName: 'SettlementStatus' })
  status: SettlementStatus;

  @ApiProperty({ format: 'date-time', nullable: true, type: String })
  paidAt: string | null;

  @ApiProperty({ nullable: true, type: String })
  paymentReference: string | null;

  @ApiProperty({ format: 'date-time' })
  createdAt: string;
}

export class UpdateSettlementDto {
  @ApiProperty({
    enum: [
      SettlementStatus.DUE,
      SettlementStatus.PAID,
      SettlementStatus.ON_HOLD,
    ],
    description:
      '`ON_HOLD` from `NOT_DUE` or `DUE`; `DUE` from `ON_HOLD` (releases a hold, only when the booking is due); `PAID` from `DUE`.',
  })
  @IsIn([SettlementStatus.DUE, SettlementStatus.PAID, SettlementStatus.ON_HOLD])
  status: 'DUE' | 'PAID' | 'ON_HOLD';

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description:
      'Why, for the audit trail (rule 6). No personal or bank account details.',
  })
  @IsString()
  @MinLength(3)
  @MaxLength(500)
  @IsPlainText()
  reason: string;

  @ApiPropertyOptional({
    maxLength: 64,
    description:
      'Required for `PAID`: the bank transfer reference of the payout (letters, digits, spaces, `-`, `_`, `/`, `.`).',
  })
  @ValidateIf((dto: UpdateSettlementDto) => dto.status === 'PAID')
  @IsString()
  @MinLength(3)
  @MaxLength(64)
  @Matches(/^[A-Za-z0-9][A-Za-z0-9 ._/-]*$/)
  paymentReference?: string;

  @ApiPropertyOptional({
    description:
      'Required for `PAID`: the payable finance paid out, as shown. Another amount than the record’s is 409 `SETTLEMENT_CHANGED`.',
  })
  @ValidateIf((dto: UpdateSettlementDto) => dto.status === 'PAID')
  @IsInt()
  @Min(0)
  @Max(MAX_AMOUNT_MINOR)
  expectedPayableMinor?: number;
}
