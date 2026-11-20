import { describe, expect, it } from 'vitest';
import { Role } from '../../generated/prisma/enums.js';
import {
  canReadAuditContents,
  presentAuditContents,
  redactRestricted,
} from './audit-visibility.js';

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

describe('redactRestricted', () => {
  const record = {
    reference: 'FLY-BK-7K2M9Q',
    passengerCount: 2,
    medicalDetails: { diagnosis: 'x' },
    specialAssistance: 'wheelchair',
    passengers: [{ firstName: 'Asha', documentNumber: 'P1234567' }],
    lead: { documentNumber: 'P7654321', dateOfBirth: '1990-01-01' },
    specialRequests: 'note',
  };

  it('hides medical fields from everyone but the super admin', () => {
    for (const role of [Role.OPS, Role.FINANCE_ADMIN]) {
      const { value, redacted } = redactRestricted(record, role);
      expect(redacted).toBe(true);
      expect(value).toMatchObject({
        medicalDetails: null,
        specialAssistance: null,
      });
    }
    const admin = redactRestricted(record, Role.SUPER_ADMIN).value;
    expect(admin).toMatchObject({
      medicalDetails: { diagnosis: 'x' },
      specialAssistance: 'wheelchair',
    });
  });

  it('hides identity document numbers from every role, at any depth', () => {
    const admin = redactRestricted(
      { lead: { documentNumber: 'P7654321', documentExpiry: '2030-01-01' } },
      Role.SUPER_ADMIN,
    );
    expect(admin).toEqual({
      value: { lead: { documentNumber: null, documentExpiry: null } },
      redacted: true,
    });
  });

  it('shows passenger details to operations and the super admin, not finance', () => {
    const ops = redactRestricted(record, Role.OPS).value as typeof record;
    expect(ops.passengers).toEqual([
      { firstName: 'Asha', documentNumber: null },
    ]);
    expect(ops.lead.dateOfBirth).toBe('1990-01-01');
    expect(ops.lead.documentNumber).toBeNull();
    const finance = redactRestricted(record, Role.FINANCE_ADMIN)
      .value as Record<string, unknown>;
    expect(finance).toMatchObject({
      passengers: null,
      specialRequests: null,
      lead: { dateOfBirth: null, documentNumber: null },
    });
  });

  it('keeps everything else, including counts, and flags nothing', () => {
    expect(
      redactRestricted(
        { reference: 'R', passengerCount: 2, documentNumber: null },
        Role.FINANCE_ADMIN,
      ),
    ).toEqual({
      value: { reference: 'R', passengerCount: 2, documentNumber: null },
      redacted: false,
    });
    expect(redactRestricted(null, Role.OPS)).toEqual({
      value: null,
      redacted: false,
    });
  });
});

describe('presentAuditContents', () => {
  it('flags a withheld pricing rule record', () => {
    const shown = presentAuditContents(
      { ...rule('COMMISSION'), reason: 'r' },
      Role.OPS,
    );
    expect(shown).toEqual({
      before: null,
      after: null,
      reason: null,
      restricted: true,
    });
  });

  it('flags a redacted record and leaves a plain one unflagged', () => {
    const log = {
      entityType: 'Booking',
      before: null,
      after: { documentNumber: 'P1' },
      reason: 'why',
    };
    expect(presentAuditContents(log, Role.SUPER_ADMIN)).toEqual({
      before: null,
      after: { documentNumber: null },
      reason: 'why',
      restricted: true,
    });
    expect(
      presentAuditContents(
        {
          entityType: 'User',
          before: null,
          after: { role: 'OPS' },
          reason: null,
        },
        Role.OPS,
      ).restricted,
    ).toBe(false);
  });
});
