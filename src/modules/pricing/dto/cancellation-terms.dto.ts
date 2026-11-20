import { ApiProperty } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsInt,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { IsPlainText } from '../../../common/validation/text.js';
import { MAX_NOTICE_HOURS, MAX_TIERS } from '../cancellation-tiers.js';

export class CancellationTierDto {
  @ApiProperty({
    minimum: 0,
    maximum: MAX_NOTICE_HOURS,
    description:
      'Applies when cancelling at least this many hours before departure (a boundary falls in the cheaper tier).',
  })
  @IsInt()
  @Min(0)
  @Max(MAX_NOTICE_HOURS)
  minHoursBeforeDeparture!: number;

  @ApiProperty({
    minimum: 0,
    maximum: 100,
    description: 'Whole percent of the confirmed price.',
  })
  @IsInt()
  @Min(0)
  @Max(100)
  chargePercent!: number;
}

/** Flyviman's cancellation tiers as everyone sees them (rule 9). */
export class CancellationTierTableDto {
  @ApiProperty({
    description:
      'The version in force. Send it back as `cancellationTermsVersion` when making a booking request, and as `baseVersion` when changing the tiers.',
  })
  version!: number;

  @ApiProperty({
    type: [CancellationTierDto],
    description: 'Longest notice first; the last tier starts at 0 hours.',
  })
  tiers!: CancellationTierDto[];

  @ApiProperty({
    description:
      'The terms in words, shown to the customer and snapshotted on a booking request word for word.',
  })
  summary!: string;

  @ApiProperty({ format: 'date-time' })
  validFrom!: string;
}

export class ChangeCancellationTermsDto {
  @ApiProperty({
    type: [CancellationTierDto],
    minItems: 1,
    maxItems: MAX_TIERS,
    description:
      'Longest notice first, each notice once, ending with a tier at 0 hours; a charge never falls as the notice shortens.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(MAX_TIERS)
  @ValidateNested({ each: true })
  @Type(() => CancellationTierDto)
  tiers!: CancellationTierDto[];

  @ApiProperty({
    description:
      'The `version` the change was made from. 409 `PRICING_RULE_NOT_CURRENT` when another change came first.',
  })
  @IsInt()
  @Min(1)
  baseVersion!: number;

  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description: 'Why the change is made. Kept in the audit record.',
  })
  @Transform(({ value }) => (typeof value === 'string' ? value.trim() : value))
  @IsString()
  @IsPlainText()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}
