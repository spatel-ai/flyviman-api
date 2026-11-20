import { ApiProperty } from '@nestjs/swagger';
import {
  BookingMode,
  PaymentModel,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';

export class CategoryConfigResponseDto {
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
