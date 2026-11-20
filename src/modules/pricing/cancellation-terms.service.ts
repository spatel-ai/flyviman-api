import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { jsonEqual } from '../../common/json-equal.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  PricingRuleScope,
  PricingRuleType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import {
  type CancellationTier,
  checkTiers,
  tiersSummary,
} from './cancellation-tiers.js';
import type { CancellationTierTableDto } from './dto/cancellation-terms.dto.js';
import { lockRuleKey } from './rule-lock.js';

const TYPE = PricingRuleType.CANCELLATION_TIERS;
const SCOPE = PricingRuleScope.PLATFORM;

type RuleRecord = Prisma.PricingRuleGetPayload<object>;

/** The cancellation terms in force, with the rule they come from. */
export interface CurrentCancellationTerms extends CancellationTierTableDto {
  ruleId: string;
}

/**
 * Flyviman's cancellation tier table (D-172): one platform rule of type
 * `CANCELLATION_TIERS`, read by search (shown with every result) and
 * bookings (snapshotted on each request), changed by finance. A change is a
 * new version under the rule key's lock, audited with before, after and the
 * reason (rule 6); bookings already made keep the terms they snapshotted.
 */
@Injectable()
export class CancellationTermsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The table in force. The migration inserts one, so none is a fault. */
  async current(
    db: Prisma.TransactionClient = this.prisma,
    now = new Date(),
  ): Promise<CurrentCancellationTerms> {
    const rule = await db.pricingRule.findFirst({
      where: { type: TYPE, scope: SCOPE, scopeRef: null, ...inForce(now) },
      orderBy: { version: 'desc' },
    });
    if (!rule) throw new Error('No cancellation tier table is in force');
    return toTerms(rule);
  }

  async change(
    user: AuthUser,
    input: { tiers: CancellationTier[]; baseVersion: number; reason: string },
  ): Promise<CurrentCancellationTerms> {
    const check = checkTiers({ tiers: input.tiers });
    if (!check.ok) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The cancellation tiers are not valid.',
        HttpStatus.BAD_REQUEST,
        check.errors.map((e) => ({ field: e.field, issue: e.message })),
      );
    }
    return this.prisma.$transaction(async (tx) => {
      await lockRuleKey(tx, TYPE, SCOPE, null);
      const now = new Date();
      const current = await tx.pricingRule.findFirst({
        where: { type: TYPE, scope: SCOPE, scopeRef: null, ...inForce(now) },
        orderBy: { version: 'desc' },
      });
      if (!current || current.version !== input.baseVersion) {
        throw new AppException(
          'PRICING_RULE_NOT_CURRENT',
          'The cancellation tiers have been changed since they were loaded. Reload and try again.',
          HttpStatus.CONFLICT,
        );
      }
      if (jsonEqual(current.config, check.config)) return toTerms(current);
      await tx.pricingRule.update({
        where: { id: current.id },
        data: { isActive: false, validTo: now },
      });
      const created = await tx.pricingRule.create({
        data: {
          type: TYPE,
          scope: SCOPE,
          scopeRef: null,
          priority: current.priority,
          config: check.config as unknown as Prisma.InputJsonValue,
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
          reason: input.reason,
        },
        tx,
      );
      return toTerms(created);
    });
  }
}

function inForce(now: Date): Prisma.PricingRuleWhereInput {
  return {
    isActive: true,
    validFrom: { lte: now },
    OR: [{ validTo: null }, { validTo: { gt: now } }],
  };
}

function toTerms(rule: RuleRecord): CurrentCancellationTerms {
  const check = checkTiers(rule.config);
  // A stored table is checked on write; one that fails now is a fault, never
  // shown to a customer as terms.
  if (!check.ok) throw new Error('The stored cancellation tiers are invalid');
  const { tiers } = check.config;
  return {
    ruleId: rule.id,
    version: rule.version,
    tiers,
    summary: tiersSummary(tiers),
    validFrom: rule.validFrom.toISOString(),
  };
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

/** The public shape, without the internal rule id. */
export function publicTerms(
  terms: CurrentCancellationTerms,
): CancellationTierTableDto {
  return {
    version: terms.version,
    tiers: terms.tiers,
    summary: terms.summary,
    validFrom: terms.validFrom,
  };
}
