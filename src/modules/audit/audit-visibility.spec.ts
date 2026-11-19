import { describe, expect, it } from 'vitest';
import { Role } from '../../generated/prisma/enums.js';
import { canReadAuditContents } from './audit-visibility.js';

const rule = (type: string | null, withBefore = true) => ({
  entityType: 'PricingRule',
  before: withBefore ? { type, config: {} } : null,
  after: { type, config: {} },
});

describe('canReadAuditContents', () => {
  it('keeps pricing rule contents for finance and super admins', () => {
    expect(canReadAuditContents(rule('COMMISSION'), Role.FINANCE_ADMIN)).toBe(
      true,
    );
    expect(canReadAuditContents(rule('COMMISSION'), Role.SUPER_ADMIN)).toBe(
      true,
    );
    expect(canReadAuditContents(rule('COMMISSION'), Role.OPS)).toBe(false);
  });

  it('shows operations the contents of matching limits records only', () => {
    expect(canReadAuditContents(rule('MATCHING_LIMITS'), Role.OPS)).toBe(true);
    expect(canReadAuditContents(rule('MATCHING_LIMITS', false), Role.OPS)).toBe(
      true,
    );
    expect(canReadAuditContents(rule('MARKUP'), Role.OPS)).toBe(false);
    expect(
      canReadAuditContents(
        {
          entityType: 'PricingRule',
          before: { type: 'MATCHING_LIMITS' },
          after: { type: 'COMMISSION' },
        },
        Role.OPS,
      ),
    ).toBe(false);
    expect(
      canReadAuditContents(
        { entityType: 'PricingRule', before: null, after: null },
        Role.OPS,
      ),
    ).toBe(false);
  });

  it('leaves other records readable by every role that reads the log', () => {
    const other = { before: null, after: null };
    expect(
      canReadAuditContents({ entityType: 'User', ...other }, Role.OPS),
    ).toBe(true);
    expect(
      canReadAuditContents({ entityType: 'Operator', ...other }, Role.OPS),
    ).toBe(true);
  });
});
