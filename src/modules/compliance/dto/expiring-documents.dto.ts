import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, Max, Min } from 'class-validator';
import { OptionalNotNull } from '../../../common/dto/optional.js';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';

export const EXPIRY_KINDS = ['OPERATOR', 'AIRCRAFT'] as const;

export class ExpiringDocumentsQueryDto extends PageQueryDto {
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 90,
    default: 30,
    description:
      'Documents expiring within this many days; expired ones are always included.',
  })
  @OptionalNotNull()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(90)
  withinDays: number = 30;

  @ApiPropertyOptional({ enum: EXPIRY_KINDS })
  @OptionalNotNull()
  @IsIn(EXPIRY_KINDS)
  kind?: (typeof EXPIRY_KINDS)[number];
}

export class ExpiringDocumentDto {
  @ApiProperty({ enum: EXPIRY_KINDS, enumName: 'ExpiryDocumentKind' })
  kind: (typeof EXPIRY_KINDS)[number];

  @ApiProperty({ format: 'uuid' })
  documentId: string;

  @ApiProperty({
    description:
      'OperatorDocumentType for an operator document, AircraftDocumentType for an aircraft one.',
  })
  type: string;

  @ApiProperty({ format: 'date', example: '2026-12-01' })
  expiresAt: string;

  @ApiProperty({
    description: 'Days from today (India); negative once expired.',
  })
  daysLeft: number;

  @ApiProperty()
  verificationStatus: string;

  @ApiProperty({ format: 'uuid' })
  operatorId: string;

  @ApiProperty()
  operatorName: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  aircraftId: string | null;

  @ApiProperty({ type: String, nullable: true })
  registration: string | null;
}

export class ExpiryRunDto {
  @ApiProperty()
  alerted: number;

  @ApiProperty()
  skipped: boolean;
}
