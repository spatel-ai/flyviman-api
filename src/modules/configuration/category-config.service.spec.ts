import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PrismaService } from '../../prisma/prisma.service.js';
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
