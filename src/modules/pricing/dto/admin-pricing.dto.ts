import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDefined,
  IsIn,
  IsInt,
  IsISO8601,
  IsObject,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../../common/dto/page-query.dto.js';
import { PriceType } from '../../../generated/prisma/enums.js';
import {
  ADMIN_RULE_SCOPES,
  ADMIN_RULE_TYPES,
  type AdminRuleScope,
  type AdminRuleType,
} from '../admin-rule-config.js';
import { IsPlainText } from '../../../common/validation/text.js';

const trim = () =>
  Transform(({ value }) => (typeof value === 'string' ? value.trim() : value));

const bool = () =>
  Transform(({ value }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  );

/** Why a commercial setting changed; kept in the audit record. */
class ReasonDto {
  @ApiProperty({
    minLength: 3,
    maxLength: 500,
    description: 'Why the change is made. Kept in the audit record.',
  })
  @trim()
  @IsString()
  @IsPlainText()
  @MinLength(3)
  @MaxLength(500)
  reason!: string;
}

// --- Pricing rules -------------------------------------------------------

export class ListPricingRulesDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: ADMIN_RULE_SCOPES })
  @IsOptional()
  @IsIn(ADMIN_RULE_SCOPES)
  scope?: AdminRuleScope;

  @ApiPropertyOptional({ enum: ADMIN_RULE_TYPES })
  @IsOptional()
  @IsIn(ADMIN_RULE_TYPES)
  type?: AdminRuleType;

  @ApiPropertyOptional({
    type: Boolean,
    default: true,
    description:
      'true (the default): rules in force now. false: every version, newest first, ended ones included.',
  })
  @IsOptional()
  @bool()
  @IsBoolean()
  active: boolean = true;
}

export class CreatePricingRuleDto extends ReasonDto {
  @ApiProperty({ enum: ADMIN_RULE_TYPES })
  @IsIn(ADMIN_RULE_TYPES)
  type!: AdminRuleType;

  @ApiProperty({ enum: ADMIN_RULE_SCOPES })
  @IsIn(ADMIN_RULE_SCOPES)
  scope!: AdminRuleScope;

  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description: 'The aircraft category of a CATEGORY rule; none for PLATFORM.',
  })
  @IsOptional()
  @ValidateIf((_, value) => value !== null)
  @IsString()
  @MaxLength(40)
  scopeRef?: string | null;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description:
      'Settings of the rule type, checked exactly: COMMISSION { percent, mode }, TAX { name, percent }, MIN_CHARGE { amountMinor }, ROUTING_FACTOR { factor }, TIME_ALLOWANCE { minutes }, VALIDITY { minutes }, MIN_BILLABLE_HOURS { hours }, POSITIONING { rateFactor, freeWithinKm? }.',
  })
  @IsDefined()
  @IsObject()
  config!: Record<string, unknown>;
}

export class UpdatePricingRuleDto extends ReasonDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'The complete new settings; checked as on create.',
  })
  @IsDefined()
  @IsObject()
  config!: Record<string, unknown>;
}

export class DeactivatePricingRuleDto extends ReasonDto {}

export class PricingRuleResponseDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() scope!: string;
  @ApiProperty({ type: String, nullable: true }) scopeRef!: string | null;
  @ApiProperty({ type: 'object', additionalProperties: true })
  config!: Record<string, unknown>;
  @ApiProperty() priority!: number;
  @ApiProperty() version!: number;
  @ApiProperty({ format: 'date-time' }) validFrom!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  validTo!: string | null;
  @ApiProperty({ description: 'Applied to new prices now.' })
  inForce!: boolean;
  @ApiProperty({
    description:
      'Whether this screen may change it (types the engine applies, platform or category scope).',
  })
  editable!: boolean;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  createdById!: string | null;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

// --- Price calculations --------------------------------------------------

export class ListPriceCalculationsDto extends PageQueryDto {
  // Every search writes calculations, so the table grows quickly; deep pages
  // would scan far. Narrow by date, aircraft or operator to go further back.
  @ApiPropertyOptional({
    minimum: 1,
    maximum: 100,
    default: 1,
    description:
      'At most 100; narrow with from, to or an id to look further back.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  override page: number = 1;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  searchId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  aircraftId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  operatorId?: string;

  @ApiPropertyOptional({
    format: 'date-time',
    description: 'Made at or after.',
  })
  @IsOptional()
  @IsISO8601({ strict: true })
  from?: string;

  @ApiPropertyOptional({ format: 'date-time', description: 'Made before.' })
  @IsOptional()
  @IsISO8601({ strict: true })
  to?: string;
}

export class PriceCalculationSummaryDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  searchId!: string | null;
  @ApiProperty({ format: 'uuid' }) aircraftId!: string;
  @ApiProperty({ type: String, nullable: true, description: 'Registration.' })
  aircraftLabel!: string | null;
  @ApiProperty({ format: 'uuid' }) operatorId!: string;
  @ApiProperty({ type: String, nullable: true }) operatorName!: string | null;
  @ApiProperty() totalMinor!: number;
  @ApiProperty() currency!: string;
  @ApiProperty({ enum: PriceType, enumName: 'PriceType' })
  priceType!: PriceType;
  @ApiProperty({ format: 'date-time' }) validUntil!: string;
  @ApiProperty() warningCount!: number;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
}

export class CalculationLineDto {
  @ApiProperty() code!: string;
  @ApiProperty() label!: string;
  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'The line amount. Finance and super administrators see every line; operations see the tax line only, since the other amounts give away operator payable and platform revenue.',
  })
  amountMinor!: number | null;
  @ApiPropertyOptional({
    type: String,
    nullable: true,
    description:
      'How the line was worked out (hours × rate). Finance and super administrators only; null for operations.',
  })
  basis!: string | null;
}

export class AppliedRuleDto {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty() type!: string;
  @ApiProperty() scope!: string;
  @ApiProperty() version!: number;
  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'The rule version as applied. Finance and super administrators only; null for operations.',
  })
  config!: Record<string, unknown> | null;
}

/** Figures restricted to finance and super administrators (pricing-engine.md, output). */
export class CalculationFinanceDto {
  @ApiProperty() operatorPayableMinor!: number;
  @ApiProperty() platformRevenueMinor!: number;
}

export class PriceCalculationDetailDto extends PriceCalculationSummaryDto {
  @ApiProperty({ type: 'object', additionalProperties: true })
  inputs!: Record<string, unknown>;
  @ApiProperty({ type: [CalculationLineDto] })
  breakdown!: CalculationLineDto[];
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Operator charges. Finance and super administrators only.',
  })
  baseMinor!: number | null;
  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Platform fees. Finance and super administrators only.',
  })
  feesMinor!: number | null;
  @ApiProperty() taxMinor!: number;
  @ApiProperty() discountMinor!: number;
  @ApiProperty({ type: [AppliedRuleDto] })
  appliedRules!: AppliedRuleDto[];
  @ApiProperty({ type: [String] }) assumptions!: string[];
  @ApiProperty({ type: [String] }) exclusions!: string[];
  @ApiProperty({ type: [String] }) warnings!: string[];
  @ApiProperty({ format: 'date-time' }) availabilityCheckedAt!: string;
  @ApiProperty({ type: String, nullable: true }) overrideReason!: string | null;
  @ApiProperty({
    type: CalculationFinanceDto,
    nullable: true,
    description: 'Finance and super administrators only; null for operations.',
  })
  finance!: CalculationFinanceDto | null;
}
