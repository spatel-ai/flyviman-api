import { describe, expect, it } from 'vitest';
import { planRuleChanges } from './rule-changes.js';
import type { RuleRow } from './rules.js';

const row = (type: string, config: unknown, version = 1): RuleRow =>
  ({
    id: `${type}-${version}`,
    scope: 'AIRCRAFT',
    scopeRef: 'a',
    type,
    config,
    priority: 0,
    version,
  }) as RuleRow;

describe('planRuleChanges', () => {
  it('creates the first version of a new input', () => {
    expect(
      planRuleChanges(
        new Map(),
        new Map([['HOURLY_RATE', { amountMinor: 1 }]]),
      ),
    ).toEqual([
      {
        type: 'HOURLY_RATE',
        close: null,
        create: { config: { amountMinor: 1 }, version: 1 },
      },
    ]);
  });

  it('closes the rule in force and creates the next version on a change', () => {
    const current = row('HOURLY_RATE', { amountMinor: 1 }, 3);
    const [change] = planRuleChanges(
      new Map([['HOURLY_RATE', current]]),
      new Map([['HOURLY_RATE', { amountMinor: 2 }]]),
    );
    expect(change.close).toBe(current);
    expect(change.create).toEqual({ config: { amountMinor: 2 }, version: 4 });
  });

  it('does nothing when the input is unchanged, whatever the key order', () => {
    const current = row('POSITIONING', { rateFactor: 0.8, freeWithinKm: 50 });
    expect(
      planRuleChanges(
        new Map([['POSITIONING', current]]),
        new Map([['POSITIONING', { freeWithinKm: 50, rateFactor: 0.8 }]]),
      ),
    ).toEqual([]);
  });

  it('only closes a cleared input, and ignores clearing what is not set', () => {
    const current = row('MIN_BILLABLE_HOURS', { hours: 2 });
    expect(
      planRuleChanges(
        new Map([['MIN_BILLABLE_HOURS', current]]),
        new Map([
          ['MIN_BILLABLE_HOURS', null],
          ['LANDING', null],
        ]),
      ),
    ).toEqual([{ type: 'MIN_BILLABLE_HOURS', close: current, create: null }]);
  });
});
