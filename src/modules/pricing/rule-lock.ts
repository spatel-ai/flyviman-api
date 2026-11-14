import type { Prisma } from '../../generated/prisma/client.js';

/**
 * Serialises writes to one pricing rule key (type, scope, scopeRef) for the
 * rest of the transaction. Every path that closes a version and creates the
 * next takes this lock before reading what is in force, so two saves at once
 * cannot both build on the same version. The partial unique index
 * `PricingRule_one_active_version` is the backstop.
 */
export async function lockRuleKey(
  tx: Prisma.TransactionClient,
  type: string,
  scope: string,
  scopeRef: string | null,
): Promise<void> {
  const key = `pricing_rule:${type}:${scope}:${scopeRef ?? ''}`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
}
