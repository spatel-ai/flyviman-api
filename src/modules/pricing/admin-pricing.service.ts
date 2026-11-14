import { HttpStatus, Injectable } from '@nestjs/common';
import { jsonEqual } from '../../common/json-equal.js';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  AircraftCategory,
  PricingRuleScope,
  Role,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AircraftService } from '../aircraft/aircraft.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { OperatorsService } from '../operators/operators.service.js';
import {
  ADMIN_RULE_SCOPES,
  checkRuleConfig,
  checkScopeRef,
  isAdminRuleType,
  type AdminRuleType,
} from './admin-rule-config.js';
import type {
  CreatePricingRuleDto,
  ListPriceCalculationsDto,
  ListPricingRulesDto,
  PriceCalculationDetailDto,
  PriceCalculationSummaryDto,
  PricingRuleResponseDto,
} from './dto/admin-pricing.dto.js';
import type { AppliedRule, LineItem } from './engine.js';

/** Roles that see operator payable, platform revenue, rule settings and line bases. */
const FINANCE_VIEW = new Set<Role>([Role.FINANCE_ADMIN, Role.SUPER_ADMIN]);

const CATEGORIES = Object.values(AircraftCategory);

type RuleRecord = Prisma.PricingRuleGetPayload<object>;

const SUMMARY_SELECT = {
  id: true,
  searchId: true,
  aircraftId: true,
  operatorId: true,
  totalMinor: true,
  currency: true,
  priceType: true,
  validUntil: true,
  warnings: true,
  createdAt: true,
} as const satisfies Prisma.PriceCalculationSelect;

/**
 * Flyviman's own pricing settings and the calculation viewer (M5 slice 3).
 * Rules are never edited in place: a change closes the version in force and
 * creates the next, so every stored calculation stays explainable. Each
 * write is audited with a reason (business rule 6).
 */
@Injectable()
export class AdminPricingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly aircraft: AircraftService,
    private readonly operators: OperatorsService,
  ) {}

  // --- Rules --------------------------------------------------------------

  async listRules(query: ListPricingRulesDto): Promise<{
    items: PricingRuleResponseDto[];
    total: number;
  }> {
    const now = new Date();
    const where: Prisma.PricingRuleWhereInput = {
      scope: query.scope ?? { in: [...ADMIN_RULE_SCOPES] },
      type: query.type,
      ...(query.active ? inForceWhere(now) : {}),
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.pricingRule.findMany({
        where,
        orderBy: query.active
          ? [{ type: 'asc' }, { scope: 'asc' }, { scopeRef: 'asc' }]
          : [{ createdAt: 'desc' }, { version: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.pricingRule.count({ where }),
    ]);
    return { items: rows.map((row) => toRuleDto(row, now)), total };
  }

  async createRule(
    user: AuthUser,
    dto: CreatePricingRuleDto,
  ): Promise<PricingRuleResponseDto> {
    const scopeRef = dto.scopeRef ?? null;
    const scopeProblem = checkScopeRef(dto.scope, scopeRef, CATEGORIES);
    if (scopeProblem) throw invalid('scopeRef', scopeProblem);
    const config = configOrThrow(dto.type, dto.config);

    return this.prisma.$transaction(async (tx) => {
      await lockKey(tx, dto.type, dto.scope, scopeRef);
      const now = new Date();
      const existing = await tx.pricingRule.findFirst({
        where: {
          type: dto.type,
          scope: dto.scope,
          scopeRef,
          ...inForceWhere(now),
        },
        select: { id: true },
      });
      if (existing) {
        throw new AppException(
          'PRICING_RULE_EXISTS',
          'A rule of this type is already in force for this scope; change it instead.',
          HttpStatus.CONFLICT,
          [{ field: 'type', issue: `In force: ${existing.id}` }],
        );
      }
      const latest = await tx.pricingRule.findFirst({
        where: { type: dto.type, scope: dto.scope, scopeRef },
        orderBy: { version: 'desc' },
        select: { version: true },
      });
      const created = await tx.pricingRule.create({
        data: {
          type: dto.type,
          scope: dto.scope,
          scopeRef,
          config: config as Prisma.InputJsonValue,
          version: (latest?.version ?? 0) + 1,
          validFrom: now,
          createdById: user.id,
        },
      });
      await this.audit.record(
        {
          action: 'pricing_rule.create',
          entityType: 'PricingRule',
          entityId: created.id,
          after: snapshot(created),
          reason: dto.reason,
        },
        tx,
      );
      return toRuleDto(created, now);
    });
  }

  async changeRule(
    user: AuthUser,
    id: string,
    config: Record<string, unknown>,
    reason: string,
  ): Promise<PricingRuleResponseDto> {
    const rule = await this.editableRule(id);
    const next = configOrThrow(rule.type as AdminRuleType, config);

    return this.prisma.$transaction(async (tx) => {
      await lockKey(tx, rule.type, rule.scope, rule.scopeRef);
      const now = new Date();
      const current = await this.currentOrThrow(tx, id, now);
      if (jsonEqual(current.config, next)) return toRuleDto(current, now);

      await tx.pricingRule.update({
        where: { id },
        data: { isActive: false, validTo: now },
      });
      const created = await tx.pricingRule.create({
        data: {
          type: current.type,
          scope: current.scope,
          scopeRef: current.scopeRef,
          priority: current.priority,
          config: next as Prisma.InputJsonValue,
          version: current.version + 1,
          validFrom: now,
          createdById: user.id,
        },
      });
      await this.audit.record(
        {
          action: 'pricing_rule.change',
          entityType: 'PricingRule',
          entityId: created.id,
          before: snapshot(current),
          after: snapshot(created),
          reason,
        },
        tx,
      );
      return toRuleDto(created, now);
    });
  }

  async deactivateRule(
    id: string,
    reason: string,
  ): Promise<PricingRuleResponseDto> {
    const rule = await this.editableRule(id);
    if (rule.scope === PricingRuleScope.PLATFORM) {
      throw new AppException(
        'PRICING_RULE_REQUIRED',
        'A platform rule cannot be ended, because every price relies on it. Change its value instead.',
        HttpStatus.CONFLICT,
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await lockKey(tx, rule.type, rule.scope, rule.scopeRef);
      const now = new Date();
      const current = await this.currentOrThrow(tx, id, now);
      const ended = await tx.pricingRule.update({
        where: { id },
        data: { isActive: false, validTo: now },
      });
      await this.audit.record(
        {
          action: 'pricing_rule.deactivate',
          entityType: 'PricingRule',
          entityId: id,
          before: snapshot(current),
          reason,
        },
        tx,
      );
      return toRuleDto(ended, now);
    });
  }

  /** A rule this screen may change: an admin type at platform or category scope. */
  private async editableRule(id: string): Promise<RuleRecord> {
    const rule = await this.prisma.pricingRule.findUnique({ where: { id } });
    if (!rule || !isEditable(rule)) {
      throw new AppException(
        'NOT_FOUND',
        'Pricing rule not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    return rule;
  }

  /** Re-read under the key's lock: someone may have changed or ended it meanwhile. */
  private async currentOrThrow(
    tx: Prisma.TransactionClient,
    id: string,
    now: Date,
  ): Promise<RuleRecord> {
    const current = await tx.pricingRule.findFirst({
      where: { id, ...inForceWhere(now) },
    });
    if (!current) {
      throw new AppException(
        'PRICING_RULE_NOT_CURRENT',
        'This rule has been changed or ended since it was loaded. Reload and try again.',
        HttpStatus.CONFLICT,
      );
    }
    return current;
  }

  // --- Calculations -------------------------------------------------------

  async listCalculations(query: ListPriceCalculationsDto): Promise<{
    items: PriceCalculationSummaryDto[];
    total: number;
  }> {
    const where: Prisma.PriceCalculationWhereInput = {
      searchId: query.searchId,
      aircraftId: query.aircraftId,
      operatorId: query.operatorId,
      createdAt:
        query.from || query.to
          ? {
              gte: query.from ? new Date(query.from) : undefined,
              lt: query.to ? new Date(query.to) : undefined,
            }
          : undefined,
    };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.priceCalculation.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
        select: SUMMARY_SELECT,
      }),
      this.prisma.priceCalculation.count({ where }),
    ]);
    const labels = await this.labels(rows);
    return { items: rows.map((row) => toSummary(row, labels)), total };
  }

  async calculation(
    user: AuthUser,
    id: string,
  ): Promise<PriceCalculationDetailDto> {
    const row = await this.prisma.priceCalculation.findUnique({
      where: { id },
    });
    if (!row) {
      throw new AppException(
        'NOT_FOUND',
        'Price calculation not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const finance = FINANCE_VIEW.has(user.role);
    const applied = asArray<AppliedRule>(row.appliedRules);
    const configs = finance
      ? new Map(
          (
            await this.prisma.pricingRule.findMany({
              where: { id: { in: applied.map((rule) => rule.id) } },
              select: { id: true, config: true },
            })
          ).map((rule) => [rule.id, rule.config]),
        )
      : new Map<string, unknown>();
    const labels = await this.labels([row]);

    return Object.assign(toSummary(row, labels), {
      inputs: asObject(row.inputs),
      breakdown: asArray<LineItem>(row.breakdown).map((line) => ({
        code: line.code,
        label: line.label,
        amountMinor: line.amountMinor,
        basis: finance ? (line.basis ?? null) : null,
      })),
      baseMinor: row.baseMinor,
      feesMinor: row.feesMinor,
      taxMinor: row.taxMinor,
      discountMinor: row.discountMinor,
      appliedRules: applied.map((rule) => ({
        id: rule.id,
        type: rule.type,
        scope: rule.scope,
        version: rule.version,
        config: finance
          ? ((configs.get(rule.id) as Record<string, unknown> | undefined) ??
            null)
          : null,
      })),
      assumptions: asArray<string>(row.assumptions),
      exclusions: asArray<string>(row.exclusions),
      warnings: asArray<string>(row.warnings),
      availabilityCheckedAt: row.availabilityCheckedAt.toISOString(),
      overrideReason: row.overrideReason,
      finance: finance
        ? {
            operatorPayableMinor: row.operatorPayableMinor,
            platformRevenueMinor: row.platformRevenueMinor,
          }
        : null,
    });
  }

  private async labels(
    rows: { aircraftId: string; operatorId: string }[],
  ): Promise<{
    aircraft: Map<string, string>;
    operators: Map<string, string>;
  }> {
    const [aircraft, operators] = await Promise.all([
      this.aircraft.registrations([...new Set(rows.map((r) => r.aircraftId))]),
      this.operators.names([...new Set(rows.map((r) => r.operatorId))]),
    ]);
    return { aircraft, operators };
  }
}

// --- Helpers ---------------------------------------------------------------

function inForceWhere(now: Date): Prisma.PricingRuleWhereInput {
  return {
    isActive: true,
    validFrom: { lte: now },
    OR: [{ validTo: null }, { validTo: { gt: now } }],
  };
}

/** One writer at a time per rule key, held until the transaction ends. */
async function lockKey(
  tx: Prisma.TransactionClient,
  type: string,
  scope: string,
  scopeRef: string | null,
): Promise<void> {
  const key = `pricing_rule:${type}:${scope}:${scopeRef ?? ''}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}

function isEditable(rule: { type: string; scope: string }): boolean {
  return (
    isAdminRuleType(rule.type) &&
    (ADMIN_RULE_SCOPES as readonly string[]).includes(rule.scope)
  );
}

function configOrThrow(
  type: AdminRuleType,
  config: unknown,
): Record<string, unknown> {
  const check = checkRuleConfig(type, config);
  if (!check.ok) {
    throw new AppException(
      'VALIDATION_ERROR',
      'The rule settings are not valid.',
      HttpStatus.BAD_REQUEST,
      check.errors.map((e) => ({ field: e.field, issue: e.message })),
    );
  }
  return check.config;
}

function invalid(field: string, issue: string): AppException {
  return new AppException(
    'VALIDATION_ERROR',
    'The rule is not valid.',
    HttpStatus.BAD_REQUEST,
    [{ field, issue }],
  );
}

function snapshot(rule: RuleRecord): Prisma.InputJsonValue {
  return {
    type: rule.type,
    scope: rule.scope,
    scopeRef: rule.scopeRef,
    version: rule.version,
    config: rule.config,
  } as Prisma.InputJsonValue;
}

function toRuleDto(rule: RuleRecord, now: Date): PricingRuleResponseDto {
  return {
    id: rule.id,
    type: rule.type,
    scope: rule.scope,
    scopeRef: rule.scopeRef,
    config: asObject(rule.config),
    priority: rule.priority,
    version: rule.version,
    validFrom: rule.validFrom.toISOString(),
    validTo: rule.validTo?.toISOString() ?? null,
    inForce:
      rule.isActive &&
      rule.validFrom <= now &&
      (rule.validTo === null || rule.validTo > now),
    editable: isEditable(rule),
    createdById: rule.createdById,
    createdAt: rule.createdAt.toISOString(),
  };
}

function toSummary(
  row: Prisma.PriceCalculationGetPayload<{ select: typeof SUMMARY_SELECT }>,
  labels: { aircraft: Map<string, string>; operators: Map<string, string> },
): PriceCalculationSummaryDto {
  return {
    id: row.id,
    searchId: row.searchId,
    aircraftId: row.aircraftId,
    aircraftLabel: labels.aircraft.get(row.aircraftId) ?? null,
    operatorId: row.operatorId,
    operatorName: labels.operators.get(row.operatorId) ?? null,
    totalMinor: row.totalMinor,
    currency: row.currency,
    priceType: row.priceType,
    validUntil: row.validUntil.toISOString(),
    warningCount: asArray(row.warnings).length,
    createdAt: row.createdAt.toISOString(),
  };
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
