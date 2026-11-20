import { describe, expect, it } from 'vitest';
import {
  BookingMode,
  PaymentModel,
  ServiceCategory,
} from '../../generated/prisma/enums.js';
import {
  DEFAULT_CATEGORY_CONFIG,
  parseOverride,
  resolveCategoryConfig,
} from './category-config.js';

const MODES = Object.values(BookingMode);
const MODELS = Object.values(PaymentModel);

describe('parseOverride', () => {
  it('reads known categories with known values', () => {
    expect(
      parseOverride(
        { PRIVATE_CHARTER: 'INSTANT', HELICOPTER: 'REQUEST' },
        MODES,
      ),
    ).toEqual({ PRIVATE_CHARTER: 'INSTANT', HELICOPTER: 'REQUEST' });
  });

  it.each([null, undefined, 'INSTANT', 3, true, ['INSTANT']])(
    'grants nothing for a non-object (%j)',
    (raw) => {
      expect(parseOverride(raw, MODES)).toEqual({});
    },
  );

  it('drops unknown categories, unknown values and non-strings', () => {
    expect(
      parseOverride(
        {
          PRIVATE_CHARTER: 'C_DEPOSIT',
          HELICOPTER: 'instant',
          EMPTY_LEG: 1,
          SPACE: 'INSTANT',
          AIR_AMBULANCE: 'B_OPERATOR_CONFIRMED',
        },
        MODELS,
      ),
    ).toEqual({
      PRIVATE_CHARTER: 'C_DEPOSIT',
      AIR_AMBULANCE: 'B_OPERATOR_CONFIRMED',
    });
  });

  it('ignores inherited keys', () => {
    const raw = Object.create({ PRIVATE_CHARTER: 'INSTANT' }) as object;
    expect(parseOverride(raw, MODES)).toEqual({});
  });
});

describe('resolveCategoryConfig', () => {
  const charter = DEFAULT_CATEGORY_CONFIG.PRIVATE_CHARTER;

  it('returns the platform setting with no override', () => {
    expect(
      resolveCategoryConfig(ServiceCategory.PRIVATE_CHARTER, 'IN', charter),
    ).toEqual({
      category: 'PRIVATE_CHARTER',
      region: 'IN',
      isEnabled: true,
      bookingMode: 'REQUEST',
      paymentModel: 'B_OPERATOR_CONFIRMED',
      depositPercent: 25,
    });
  });

  it("applies the operator's override for its category only", () => {
    const override = {
      bookingMode: { PRIVATE_CHARTER: BookingMode.INSTANT },
      paymentModel: { HELICOPTER: PaymentModel.C_DEPOSIT },
    };
    expect(
      resolveCategoryConfig('PRIVATE_CHARTER', 'IN', charter, override),
    ).toMatchObject({
      bookingMode: 'INSTANT',
      paymentModel: 'B_OPERATOR_CONFIRMED',
    });
    expect(
      resolveCategoryConfig(
        'HELICOPTER',
        'IN',
        DEFAULT_CATEGORY_CONFIG.HELICOPTER,
        override,
      ),
    ).toMatchObject({ bookingMode: 'REQUEST', paymentModel: 'C_DEPOSIT' });
  });

  it('never resolves air ambulance to INSTANT (rule 7)', () => {
    const instantRow = {
      isEnabled: true,
      bookingMode: BookingMode.INSTANT,
      paymentModel: PaymentModel.A_INSTANT,
    };
    expect(
      resolveCategoryConfig('AIR_AMBULANCE', 'IN', instantRow).bookingMode,
    ).toBe('REQUEST');
    expect(
      resolveCategoryConfig(
        'AIR_AMBULANCE',
        'IN',
        DEFAULT_CATEGORY_CONFIG.AIR_AMBULANCE,
        { bookingMode: { AIR_AMBULANCE: 'INSTANT' }, paymentModel: {} },
      ).bookingMode,
    ).toBe('REQUEST');
  });

  it('is disabled and on request when the platform has no row', () => {
    expect(
      resolveCategoryConfig('SCHEDULED_AIRLINE', 'AE', null, {
        bookingMode: { SCHEDULED_AIRLINE: 'INSTANT' },
        paymentModel: {},
      }),
    ).toEqual({
      category: 'SCHEDULED_AIRLINE',
      region: 'AE',
      isEnabled: false,
      bookingMode: 'REQUEST',
      paymentModel: 'B_OPERATOR_CONFIRMED',
      depositPercent: 25,
    });
  });

  it('never enables a category the platform disabled', () => {
    expect(
      resolveCategoryConfig('EMPTY_LEG', 'IN', { ...charter, isEnabled: false })
        .isEnabled,
    ).toBe(false);
  });

  it('seeds the assumed defaults of decisions 5 and 7', () => {
    expect(DEFAULT_CATEGORY_CONFIG.SCHEDULED_AIRLINE).toMatchObject({
      bookingMode: 'INSTANT',
      paymentModel: 'A_INSTANT',
    });
    for (const category of [
      'PRIVATE_CHARTER',
      'HELICOPTER',
      'EMPTY_LEG',
      'AIR_AMBULANCE',
    ] as const) {
      expect(DEFAULT_CATEGORY_CONFIG[category]).toMatchObject({
        bookingMode: 'REQUEST',
        paymentModel: 'B_OPERATOR_CONFIRMED',
      });
    }
  });
});
