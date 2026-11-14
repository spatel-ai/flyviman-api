import { Role } from '../../generated/prisma/enums.js';

/**
 * Audit records whose contents are commercial: pricing rules carry the
 * commission, markup, fee and tax settings, which security-rbac.md keeps for
 * finance and super admins. Other internal roles still see that such a record
 * exists (who, what, when) but not its before, after or reason.
 */
const COMMERCIAL_ENTITIES: ReadonlySet<string> = new Set(['PricingRule']);
const COMMERCIAL_READERS: ReadonlySet<Role> = new Set([
  Role.FINANCE_ADMIN,
  Role.SUPER_ADMIN,
]);

export function canReadAuditContents(entityType: string, role: Role): boolean {
  return !COMMERCIAL_ENTITIES.has(entityType) || COMMERCIAL_READERS.has(role);
}
