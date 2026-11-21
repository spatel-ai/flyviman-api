import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsISO8601,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { IsPlainText } from '../../../common/validation/text.js';
import {
  BookingMode,
  PaymentModel,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';

export class CategoryConfigResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;

  @ApiProperty({ example: 'IN' })
  region: string;

  @ApiProperty()
  isEnabled: boolean;

  @ApiProperty({
    enum: BookingMode,
    enumName: 'BookingMode',
    description:
      'Platform setting. Operators may override it per category; air ambulance is always REQUEST.',
  })
  bookingMode: BookingMode;

  @ApiProperty({
    enum: PaymentModel,
    enumName: 'PaymentModel',
    description: 'Platform setting. Operators may override it per category.',
  })
  paymentModel: PaymentModel;

  @ApiProperty({
    example: 25,
    minimum: 1,
    maximum: 100,
    description:
      'The deposit taken under payment model C, in whole percent of the confirmed total, rounded up to the next paisa.',
  })
  depositPercent: number;

  @ApiProperty({ format: 'date-time' })
  updatedAt: string;
}

/**
 * A change to one category's platform row. A field left out stays as it is;
 * `null` is refused. Applies to bookings made from now on: a booking keeps
 * the booking mode and payment model it was made with.
 */
export class UpdateCategoryConfigDto {
  @ApiPropertyOptional({
    description:
      'Whether the category is offered. A disabled category is hidden from search and takes no new bookings or requests.',
  })
  @OptionalNotNull()
  @IsBoolean()
  isEnabled?: boolean;

  @ApiPropertyOptional({
    enum: BookingMode,
    enumName: 'BookingMode',
    description:
      'Air ambulance is always REQUEST (422 `CATEGORY_CONFIG_INVALID`).',
  })
  @OptionalNotNull()
  @IsEnum(BookingMode)
  bookingMode?: BookingMode;

  @ApiPropertyOptional({ enum: PaymentModel, enumName: 'PaymentModel' })
  @OptionalNotNull()
  @IsEnum(PaymentModel)
  paymentModel?: PaymentModel;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    description:
      'The model C deposit, whole percent. Also used when an operator overrides the payment model to C.',
  })
  @OptionalNotNull()
  @IsInt()
  @Min(1)
  @Max(100)
  depositPercent?: number;

  @ApiProperty({
    format: 'date-time',
    description:
      "The row's `updatedAt` as the editor loaded it. 409 `CATEGORY_CONFIG_CHANGED` if it has changed since.",
  })
  @IsISO8601({ strict: true })
  expectedUpdatedAt: string;

  @ApiProperty({ description: 'Why the configuration is changed. Audited.' })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsPlainText()
  @MinLength(3)
  @MaxLength(500)
  reason: string;
}
