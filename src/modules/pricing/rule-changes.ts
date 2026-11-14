import { jsonEqual } from '../../common/json-equal.js';
import type { RuleRow } from './rules.js';

/** One rule type's change: close the rule in force, create its next version. */
export interface RuleChange {
  type: string;
  close: RuleRow | null;
  create: { config: unknown; version: number } | null;
}

/**
 * What saving a set of pricing inputs changes (pricing-engine.md, rule
 * model). Rules are never edited in place: a changed input closes the rule
 * in force and creates the next version; a cleared input only closes it;
 * an unchanged input does nothing, so saving twice writes nothing twice.
 */
export function planRuleChanges(
  current: Map<string, RuleRow>,
  desired: Map<string, unknown>,
): RuleChange[] {
  const changes: RuleChange[] = [];
  for (const [type, config] of desired) {
    const existing = current.get(type) ?? null;
    if (config == null) {
      if (existing) changes.push({ type, close: existing, create: null });
      continue;
    }
    if (existing && jsonEqual(existing.config, config)) continue;
    changes.push({
      type,
      close: existing,
      create: { config, version: (existing?.version ?? 0) + 1 },
    });
  }
  return changes;
}
