import { describe, expect, it, vi } from 'vitest';
import type { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type { PrismaService } from '../../prisma/prisma.service.js';
import { CancellationTermsService } from './cancellation-terms.service.js';

const STARTING = [
  { minHoursBeforeDeparture: 72, chargePercent: 10 },
  { minHoursBeforeDeparture: 24, chargePercent: 50 },
  { minHoursBeforeDeparture: 0, chargePercent: 100 },
];

const CURRENT = {
  id: 'rule-1',
  type: 'CANCELLATION_TIERS',
  scope: 'PLATFORM',
  scopeRef: null,
  config: { tiers: STARTING },
  priority: 0,
  validFrom: new Date('2026-11-20T00:00:00.000Z'),
  validTo: null,
  isActive: true,
  version: 1,
  createdById: null,
  createdAt: new Date('2026-11-20T00:00:00.000Z'),
};

const FINANCE = { id: 'finance-1', role: 'FINANCE_ADMIN' } as AuthUser;

function setup() {
  const tx = {
    $executeRaw: vi.fn(),
    pricingRule: {
      findFirst: vi.fn().mockResolvedValue(CURRENT),
      update: vi.fn(),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        ...CURRENT,
        ...data,
        id: 'rule-2',
      })),
    },
  };
  const prisma = {
    $transaction: vi.fn((fn: (client: typeof tx) => unknown) => fn(tx)),
  } as unknown as PrismaService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  return { tx, audit, service: new CancellationTermsService(prisma, audit) };
}

describe('CancellationTermsService.change', () => {
  it('closes the version in force, creates the next under the lock and audits before, after and reason', async () => {
    const { tx, audit, service } = setup();
    const tiers = [
      { minHoursBeforeDeparture: 96, chargePercent: 0 },
      { minHoursBeforeDeparture: 0, chargePercent: 100 },
    ];
    const result = await service.change(FINANCE, {
      tiers,
      baseVersion: 1,
      reason: 'Owner decision',
    });

    expect(tx.$executeRaw).toHaveBeenCalledOnce();
    expect(tx.pricingRule.update).toHaveBeenCalledWith({
      where: { id: 'rule-1' },
      data: { isActive: false, validTo: expect.any(Date) },
    });
    expect(tx.pricingRule.create.mock.calls[0][0].data).toMatchObject({
      type: 'CANCELLATION_TIERS',
      scope: 'PLATFORM',
      scopeRef: null,
      version: 2,
      config: { tiers },
      createdById: 'finance-1',
    });
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'pricing_rule.change',
        entityType: 'PricingRule',
        entityId: 'rule-2',
        before: expect.objectContaining({
          version: 1,
          config: { tiers: STARTING },
        }),
        after: expect.objectContaining({ version: 2, config: { tiers } }),
        reason: 'Owner decision',
      }),
      tx,
    );
    expect(result).toMatchObject({ version: 2, tiers });
    expect(result.summary).toContain('96 hours or more before departure: 0%');
  });

  it('writes nothing for identical tiers', async () => {
    const { tx, audit, service } = setup();
    const result = await service.change(FINANCE, {
      tiers: STARTING,
      baseVersion: 1,
      reason: 'No change',
    });
    expect(result.version).toBe(1);
    expect(tx.pricingRule.create).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('refuses a stale base version', async () => {
    const { tx, service } = setup();
    await expect(
      service.change(FINANCE, {
        tiers: STARTING,
        baseVersion: 3,
        reason: 'Old screen',
      }),
    ).rejects.toMatchObject({ code: 'PRICING_RULE_NOT_CURRENT' });
    expect(tx.pricingRule.create).not.toHaveBeenCalled();
  });

  it('refuses tiers out of order before opening a transaction', async () => {
    const { tx, service } = setup();
    await expect(
      service.change(FINANCE, {
        tiers: [STARTING[1], STARTING[0], STARTING[2]],
        baseVersion: 1,
        reason: 'Bad',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' });
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });
});
