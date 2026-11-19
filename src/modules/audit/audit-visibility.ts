import { PricingRuleType, Role } from '../../generated/prisma/enums.js';

/**
 * Audit records whose contents are commercial: pricing rules carry the
 * commission, markup, fee and tax settings, which security-rbac.md keeps for
 * finance and super admins. Other internal roles still see that such a record
 * exists (who, what, when) but not its before, after or reason.
 *
 * Exception: operations set the matching limits (MATCHING_LIMITS), so they
 * see the contents of those records, and of no other pricing rule.
 */
const COMMERCIAL_ENTITIES: ReadonlySet<string> = new Set(['PricingRule']);
const COMMERCIAL_READERS: ReadonlySet<Role> = new Set([
  Role.FINANCE_ADMIN,
  Role.SUPER_ADMIN,
]);

export interface AuditContents {
  entityType: string;
  before: unknown;
  after: unknown;
}

export function canReadAuditContents(log: AuditContents, role: Role): boolean {
  if (!COMMERCIAL_ENTITIES.has(log.entityType)) return true;
  if (COMMERCIAL_READERS.has(role)) return true;
  return role === Role.OPS && isMatchingLimitsRecord(log);
}

/** Every snapshot present names MATCHING_LIMITS, and at least one is present. */
function isMatchingLimitsRecord(log: AuditContents): boolean {
  const types = [log.before, log.after]
    .filter((s) => s !== null && s !== undefined)
    .map((s) =>
      typeof s === 'object' ? (s as { type?: unknown }).type : null,
    );
  return (
    types.length > 0 &&
    types.every((t) => t === PricingRuleType.MATCHING_LIMITS)
  );
}
