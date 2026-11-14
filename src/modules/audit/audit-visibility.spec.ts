import { describe, expect, it } from 'vitest';
import { Role } from '../../generated/prisma/enums.js';
import { canReadAuditContents } from './audit-visibility.js';

describe('canReadAuditContents', () => {
  it('keeps pricing rule contents for finance and super admins', () => {
    expect(canReadAuditContents('PricingRule', Role.FINANCE_ADMIN)).toBe(true);
    expect(canReadAuditContents('PricingRule', Role.SUPER_ADMIN)).toBe(true);
    expect(canReadAuditContents('PricingRule', Role.OPS)).toBe(false);
  });

  it('leaves other records readable by every role that reads the log', () => {
    expect(canReadAuditContents('User', Role.OPS)).toBe(true);
    expect(canReadAuditContents('Operator', Role.OPS)).toBe(true);
  });
});
