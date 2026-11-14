import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  OperatorStatus,
  PricingRuleScope,
  PricingRuleType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { OperatorsService } from '../operators/operators.service.js';
import type {
  AircraftPricingDto,
  AircraftPricingResponseDto,
  OperatorPricingDto,
  OperatorPricingResponseDto,
} from './dto/operator-pricing.dto.js';
import { planRuleChanges } from './rule-changes.js';
import type { RuleConfigs, RuleRow } from './rules.js';
import { lockRuleKey } from './rule-lock.js';

const OPERATOR_TYPES = [
  PricingRuleType.MIN_BILLABLE_HOURS,
  PricingRuleType.POSITIONING,
  PricingRuleType.LANDING,
  PricingRuleType.HANDLING,
] as const;

const AIRCRAFT_TYPES = [
  PricingRuleType.HOURLY_RATE,
  PricingRuleType.MIN_BILLABLE_HOURS,
] as const;

const RULE_SELECT = {
  id: true,
  scope: true,
  scopeRef: true,
  type: true,
  config: true,
  priority: true,
  version: true,
} as const satisfies Prisma.PricingRuleSelect;

/**
 * Pricing inputs an operator administrator sets for their own organisation
 * and aircraft (M5 slice 2; pricing-engine.md, "Who edits what"). Only
 * operator-owned rule types: commission, markup, fees and tax are
 * Flyviman's and are never written here. Every change is a new rule version
 * with an audit record (business rule 6).
 */
@Injectable()
export class OperatorPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly audit: AuditService,
  ) {}

  async getOperator(user: AuthUser): Promise<OperatorPricingResponseDto> {
    const operatorId = await this.operatorOf(user);
    return toOperatorDto(
      await this.inForce(PricingRuleScope.OPERATOR, operatorId, OPERATOR_TYPES),
    );
  }

  async setOperator(
    user: AuthUser,
    dto: OperatorPricingDto,
  ): Promise<OperatorPricingResponseDto> {
    const operatorId = await this.approvedOperatorOf(user);
    const desired = new Map<string, unknown>([
      [
        PricingRuleType.MIN_BILLABLE_HOURS,
        dto.minBillableHours == null ? null : { hours: dto.minBillableHours },
      ],
      [
        PricingRuleType.POSITIONING,
        dto.positioningRateFactor == null
          ? null
          : {
              rateFactor: dto.positioningRateFactor,
              freeWithinKm: dto.freeWithinKm ?? 0,
            },
      ],
      [
        PricingRuleType.LANDING,
        dto.landingFallbackMinor == null
          ? null
          : { amountMinor: dto.landingFallbackMinor },
      ],
      [
        PricingRuleType.HANDLING,
        dto.handlingFallbackMinor == null
          ? null
          : { amountMinor: dto.handlingFallbackMinor },
      ],
    ]);
    await this.save(
      user,
      PricingRuleScope.OPERATOR,
      operatorId,
      OPERATOR_TYPES,
      desired,
    );
    return this.getOperator(user);
  }

  async getAircraft(
    user: AuthUser,
    aircraftId: string,
  ): Promise<AircraftPricingResponseDto> {
    await this.ownAircraft(user, aircraftId);
    return toAircraftDto(
      aircraftId,
      await this.inForce(PricingRuleScope.AIRCRAFT, aircraftId, AIRCRAFT_TYPES),
    );
  }

  async setAircraft(
    user: AuthUser,
    aircraftId: string,
    dto: AircraftPricingDto,
  ): Promise<AircraftPricingResponseDto> {
    await this.approvedOperatorOf(user);
    await this.ownAircraft(user, aircraftId);
    const desired = new Map<string, unknown>([
      [
        PricingRuleType.HOURLY_RATE,
        dto.hourlyRateMinor == null
          ? null
          : {
              amountMinor: dto.hourlyRateMinor,
              currency: 'INR',
              taxInclusive: dto.taxInclusive,
              commissionInclusive: dto.commissionInclusive,
            },
      ],
      [
        PricingRuleType.MIN_BILLABLE_HOURS,
        dto.minBillableHours == null ? null : { hours: dto.minBillableHours },
      ],
    ]);
    await this.save(
      user,
      PricingRuleScope.AIRCRAFT,
      aircraftId,
      AIRCRAFT_TYPES,
      desired,
    );
    return this.getAircraft(user, aircraftId);
  }

  // --- Internals ----------------------------------------------------------

  private async operatorOf(user: AuthUser): Promise<string> {
    const { operator } = await this.operators.accessFor(user);
    return operator.id;
  }

  /**
   * Changing rates needs an approved operator (security-rbac.md); reading
   * stays open, so a suspended operator still sees what it had set.
   */
  private async approvedOperatorOf(user: AuthUser): Promise<string> {
    const { operator } = await this.operators.accessFor(user);
    if (operator.status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can change pricing.',
        HttpStatus.CONFLICT,
      );
    }
    return operator.id;
  }

  /** The aircraft must be the caller's operator's; otherwise it is not found. */
  private async ownAircraft(user: AuthUser, aircraftId: string): Promise<void> {
    const operatorId = await this.operatorOf(user);
    const unknown = await this.operators.unknownAircraft(operatorId, [
      aircraftId,
    ]);
    if (unknown.length > 0) {
      throw new AppException(
        'NOT_FOUND',
        'Aircraft not found.',
        HttpStatus.NOT_FOUND,
      );
    }
  }

  private async inForce(
    scope: PricingRuleScope,
    scopeRef: string,
    types: readonly PricingRuleType[],
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<Map<string, RuleRow>> {
    const now = new Date();
    const rows = await db.pricingRule.findMany({
      where: {
        scope,
        scopeRef,
        type: { in: [...types] },
        isActive: true,
        validFrom: { lte: now },
        OR: [{ validTo: null }, { validTo: { gt: now } }],
      },
      orderBy: { version: 'desc' },
      select: RULE_SELECT,
    });
    const byType = new Map<string, RuleRow>();
    for (const row of rows)
      if (!byType.has(row.type)) byType.set(row.type, row);
    return byType;
  }

  private async save(
    user: AuthUser,
    scope: PricingRuleScope,
    scopeRef: string,
    types: readonly PricingRuleType[],
    desired: Map<string, unknown>,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // One lock per rule key, in a fixed order so two saves never wait on
      // each other in a cycle; the in-force read then sees any save that
      // finished first (security review M2).
      for (const type of [...types].sort()) {
        await lockRuleKey(tx, type, scope, scopeRef);
      }
      const now = new Date();
      const current = await this.inForce(scope, scopeRef, types, tx);
      for (const change of planRuleChanges(current, desired)) {
        if (change.close) {
          await tx.pricingRule.update({
            where: { id: change.close.id },
            data: { isActive: false, validTo: now },
          });
        }
        const created = change.create
          ? await tx.pricingRule.create({
              data: {
                scope,
                scopeRef,
                type: change.type as PricingRuleType,
                config: change.create.config as Prisma.InputJsonValue,
                version: change.create.version,
                validFrom: now,
                createdById: user.id,
              },
              select: { id: true },
            })
          : null;
        await this.audit.record(
          {
            action: 'pricing_rule.change',
            entityType: 'PricingRule',
            entityId: created?.id ?? change.close!.id,
            before: change.close
              ? ({
                  type: change.type,
                  scope,
                  scopeRef,
                  version: change.close.version,
                  config: change.close.config,
                } as Prisma.InputJsonValue)
              : undefined,
            after: change.create
              ? ({
                  type: change.type,
                  scope,
                  scopeRef,
                  version: change.create.version,
                  config: change.create.config,
                } as Prisma.InputJsonValue)
              : undefined,
          },
          tx,
        );
      }
    });
  }
}

function configOf<K extends keyof RuleConfigs>(
  rules: Map<string, RuleRow>,
  type: K,
): RuleConfigs[K] | null {
  return (rules.get(type)?.config as RuleConfigs[K] | undefined) ?? null;
}

function toOperatorDto(
  rules: Map<string, RuleRow>,
): OperatorPricingResponseDto {
  const positioning = configOf(rules, 'POSITIONING');
  return {
    currency: 'INR',
    minBillableHours: configOf(rules, 'MIN_BILLABLE_HOURS')?.hours ?? null,
    positioningRateFactor: positioning?.rateFactor ?? null,
    freeWithinKm: positioning ? (positioning.freeWithinKm ?? 0) : null,
    landingFallbackMinor: configOf(rules, 'LANDING')?.amountMinor ?? null,
    handlingFallbackMinor: configOf(rules, 'HANDLING')?.amountMinor ?? null,
  };
}

function toAircraftDto(
  aircraftId: string,
  rules: Map<string, RuleRow>,
): AircraftPricingResponseDto {
  const rate = configOf(rules, 'HOURLY_RATE');
  return {
    aircraftId,
    currency: 'INR',
    hourlyRateMinor: rate?.amountMinor ?? null,
    taxInclusive: rate?.taxInclusive ?? false,
    commissionInclusive: rate?.commissionInclusive ?? false,
    minBillableHours: configOf(rules, 'MIN_BILLABLE_HOURS')?.hours ?? null,
  };
}
