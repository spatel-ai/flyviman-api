import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsUUID,
  Matches,
  Max,
  Min,
} from 'class-validator';
import { CHARTER_CATEGORIES, SearchPriceDto } from './search.dto.js';

export class FareCalendarQueryDto {
  @ApiProperty({ enum: ['PRIVATE_CHARTER', 'HELICOPTER'] })
  @IsIn(['PRIVATE_CHARTER', 'HELICOPTER'])
  category: 'PRIVATE_CHARTER' | 'HELICOPTER';

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  originId: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  destinationId: string;

  @ApiProperty({ example: '2026-12', description: 'YYYY-MM.' })
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, { message: 'month must be YYYY-MM' })
  month: string;

  @ApiProperty({ minimum: 1, maximum: 50 })
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  passengerCount: number;

  @ApiPropertyOptional({
    enum: CHARTER_CATEGORIES,
    enumName: 'CharterCategory',
  })
  @IsOptional()
  @IsIn(CHARTER_CATEGORIES)
  aircraftCategory?: (typeof CHARTER_CATEGORIES)[number];
}

export class FareCalendarDayDto {
  @ApiProperty({ example: '2026-12-05' })
  date: string;

  @ApiProperty({
    description: 'Aircraft that can fly the route at 10:00 India time.',
  })
  availableCount: number;

  @ApiProperty({
    type: SearchPriceDto,
    nullable: true,
    description: 'The lowest estimate that day. Null when none is priced.',
  })
  lowest: SearchPriceDto | null;
}

export class FareCalendarResponseDto {
  @ApiProperty({ example: '2026-12' })
  month: string;

  @ApiProperty({
    type: [FareCalendarDayDto],
    description: 'Days inside the minimum notice are left out.',
  })
  days: FareCalendarDayDto[];
}
