import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { IsDateOnly } from '../../../common/validation/formats.js';
import { ServiceCategory } from '../../../generated/prisma/enums.js';

/**
 * The period of every report: calendar days in India, both included (IST
 * day boundaries, D-186). Defaults to the last 30 days; at most 366 days.
 */
export class ReportPeriodQueryDto {
  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-01',
    description:
      'First day, `YYYY-MM-DD`, in India. Defaults to 29 days before `to`.',
  })
  @IsOptional()
  @IsDateOnly()
  from?: string;

  @ApiPropertyOptional({
    format: 'date',
    example: '2026-11-30',
    description:
      'Last day, included, `YYYY-MM-DD`, in India. Defaults to today in India.',
  })
  @IsOptional()
  @IsDateOnly()
  to?: string;
}

export class ReportCategoryQueryDto extends ReportPeriodQueryDto {
  @ApiPropertyOptional({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  @IsOptional()
  @IsEnum(ServiceCategory)
  category?: ServiceCategory;
}

export class ReportOperatorQueryDto extends ReportPeriodQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  operatorId?: string;
}

export class ReportScopedQueryDto extends ReportCategoryQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  operatorId?: string;
}

/**
 * The export takes every filter; one the report does not take is refused
 * (400 `VALIDATION_ERROR`), as on the report's own route.
 */
export class ReportExportQueryDto extends ReportScopedQueryDto {}
