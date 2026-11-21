import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
import type { AuditService } from '../audit/audit.service.js';
import type { OperatorsService } from '../operators/operators.service.js';
import { DEFAULT_CATEGORY_CONFIG } from './category-config.js';
import { CategoryConfigService } from './category-config.service.js';

const ROWS = Object.entries(DEFAULT_CATEGORY_CONFIG).map(
  ([category, setting]) => ({
    category,
    region: 'IN',
    ...setting,
    updatedAt: new Date(),
  }),
);

function build(overrides: unknown = null) {
  const findMany = vi.fn().mockResolvedValue(ROWS);
  const modeOverrides = vi.fn().mockResolvedValue(overrides);
  const service = new CategoryConfigService(
    { serviceCategoryConfig: { findMany } } as unknown as PrismaService,
    { modeOverrides } as unknown as OperatorsService,
    { record: vi.fn() } as unknown as AuditService,
  );
  return { service, findMany, modeOverrides };
}

describe('CategoryConfigService.resolve', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('reads the table once per 30 seconds', async () => {
    const { service, findMany } = build();
    await service.resolve('PRIVATE_CHARTER');
    await service.resolve('HELICOPTER');
    expect(findMany).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(30_001);
    await service.resolve('HELICOPTER');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('defaults to region IN and reads no operator without an id', async () => {
    const { service, modeOverrides } = build();
    expect(await service.resolve('SCHEDULED_AIRLINE')).toEqual({
      category: 'SCHEDULED_AIRLINE',
      region: 'IN',
      isEnabled: true,
      bookingMode: 'INSTANT',
      paymentModel: 'A_INSTANT',
      depositPercent: 25,
    });
    expect(modeOverrides).not.toHaveBeenCalled();
  });

  it('is disabled and on request in a region with no row', async () => {
    const { service } = build();
    expect(
      await service.resolve('SCHEDULED_AIRLINE', { region: 'AE' }),
    ).toMatchObject({
      isEnabled: false,
      bookingMode: 'REQUEST',
      paymentModel: 'B_OPERATOR_CONFIRMED',
    });
  });

  it("applies the operator's override", async () => {
    const { service, modeOverrides } = build({
      bookingMode: { PRIVATE_CHARTER: 'INSTANT', AIR_AMBULANCE: 'INSTANT' },
      paymentModel: { PRIVATE_CHARTER: 'C_DEPOSIT' },
    });
    expect(
      await service.resolve('PRIVATE_CHARTER', { operatorId: 'op-1' }),
    ).toMatchObject({ bookingMode: 'INSTANT', paymentModel: 'C_DEPOSIT' });
    expect(modeOverrides).toHaveBeenCalledWith('op-1');
    expect(
      (await service.resolve('AIR_AMBULANCE', { operatorId: 'op-1' }))
        .bookingMode,
    ).toBe('REQUEST');
  });

  it.each([
    ['malformed overrides', { bookingMode: 'INSTANT', paymentModel: [1] }],
    ['an unknown operator', null],
  ])('gives the platform values for %s', async (_, raw) => {
    const { service } = build(raw);
    expect(
      await service.resolve('PRIVATE_CHARTER', { operatorId: 'op-1' }),
    ).toMatchObject({
      bookingMode: 'REQUEST',
      paymentModel: 'B_OPERATOR_CONFIRMED',
    });
  });
});

describe('CategoryConfigService.update', () => {
  const updatedAt = new Date('2026-11-21T10:00:00.000Z');
  const current = {
    id: 'cfg-1',
    category: 'PRIVATE_CHARTER',
    region: 'IN',
    ...DEFAULT_CATEGORY_CONFIG.PRIVATE_CHARTER,
    updatedAt,
  };

  function buildUpdate(row: unknown = current) {
    const update = vi.fn().mockImplementation(({ data }) => ({
      ...current,
      ...data,
      updatedAt: new Date('2026-11-21T11:00:00.000Z'),
    }));
    const tx = {
      $queryRaw: vi.fn(),
      serviceCategoryConfig: {
        findUnique: vi.fn().mockResolvedValue(row),
        update,
      },
    };
    const record = vi.fn();
    const findMany = vi.fn().mockResolvedValue(ROWS);
    const service = new CategoryConfigService(
      {
        $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
        serviceCategoryConfig: { findMany },
      } as unknown as PrismaService,
      { modeOverrides: vi.fn() } as unknown as OperatorsService,
      { record } as unknown as AuditService,
    );
    return { service, update, record, findMany };
  }

  const base = {
    expectedUpdatedAt: updatedAt.toISOString(),
    reason: 'Pause charter',
  };

  it('writes the change with an audit record holding before and after', async () => {
    const { service, update, record } = buildUpdate();
    const row = await service.update('cfg-1', { ...base, isEnabled: false });
    expect(row.isEnabled).toBe(false);
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ isEnabled: false }),
      }),
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'category_config.update',
        entityType: 'ServiceCategoryConfig',
        entityId: 'cfg-1',
        reason: 'Pause charter',
        before: expect.objectContaining({ isEnabled: true }),
        after: expect.objectContaining({ isEnabled: false }),
      }),
      expect.anything(),
    );
  });

  it('refuses a stale editor with 409 CATEGORY_CONFIG_CHANGED', async () => {
    const { service, update } = buildUpdate();
    await expect(
      service.update('cfg-1', {
        ...base,
        expectedUpdatedAt: '2026-11-21T09:00:00.000Z',
        isEnabled: false,
      }),
    ).rejects.toMatchObject({ code: 'CATEGORY_CONFIG_CHANGED' });
    expect(update).not.toHaveBeenCalled();
  });

  it('refuses air ambulance on INSTANT with 422, not a database error', async () => {
    const { service, update } = buildUpdate({
      ...current,
      category: 'AIR_AMBULANCE',
    });
    await expect(
      service.update('cfg-1', { ...base, bookingMode: 'INSTANT' }),
    ).rejects.toMatchObject({ code: 'CATEGORY_CONFIG_INVALID' });
    expect(update).not.toHaveBeenCalled();
  });

  it('answers 404 for an unknown row', async () => {
    const { service } = buildUpdate(null);
    await expect(
      service.update('cfg-1', { ...base, isEnabled: false }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('writes and audits nothing when nothing changes', async () => {
    const { service, update, record } = buildUpdate();
    await service.update('cfg-1', { ...base, isEnabled: true });
    expect(update).not.toHaveBeenCalled();
    expect(record).not.toHaveBeenCalled();
  });

  it('drops the cached rows, so resolve reads the change at once', async () => {
    const { service, findMany } = buildUpdate();
    await service.resolve('PRIVATE_CHARTER');
    await service.update('cfg-1', { ...base, isEnabled: false });
    await service.resolve('PRIVATE_CHARTER');
    expect(findMany).toHaveBeenCalledTimes(2);
  });
});
