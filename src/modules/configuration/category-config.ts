import {
  BookingMode,
  PaymentModel,
  ServiceCategory,
} from '../../generated/prisma/enums.js';

/** The platform region used until another is configured. */
export const DEFAULT_REGION = 'IN';

/** How a category is booked and paid for, after every rule is applied. */
export interface ResolvedCategoryConfig {
  category: ServiceCategory;
  region: string;
  isEnabled: boolean;
  bookingMode: BookingMode;
  paymentModel: PaymentModel;
  /** The Model C deposit, whole percent of the confirmed total. */
  depositPercent: number;
}

/** The platform row's settings, or `null` when no row exists. */
export interface PlatformSetting {
  isEnabled: boolean;
  bookingMode: BookingMode;
  paymentModel: PaymentModel;
  depositPercent: number;
}

/** The Model C deposit until configured otherwise (owner, 2026-11-20). */
export const DEFAULT_DEPOSIT_PERCENT = 25;

/**
 * An operator's overrides, per category, as stored in
 * `Operator.bookingMode` and `Operator.paymentModel`:
 * `{ "PRIVATE_CHARTER": "INSTANT" }` and `{ "PRIVATE_CHARTER": "C_DEPOSIT" }`.
 */
export type CategoryOverride<T> = Partial<Record<ServiceCategory, T>>;

/**
 * The assumed defaults of open decisions 5 and 7, seeded for region IN.
 * Air ambulance is a request verified by operations and the operator (rule 7).
 */
export const DEFAULT_CATEGORY_CONFIG: Record<ServiceCategory, PlatformSetting> =
  {
    SCHEDULED_AIRLINE: {
      isEnabled: true,
      bookingMode: BookingMode.INSTANT,
      paymentModel: PaymentModel.A_INSTANT,
      depositPercent: DEFAULT_DEPOSIT_PERCENT,
    },
    PRIVATE_CHARTER: {
      isEnabled: true,
      bookingMode: BookingMode.REQUEST,
      paymentModel: PaymentModel.B_OPERATOR_CONFIRMED,
      depositPercent: DEFAULT_DEPOSIT_PERCENT,
    },
    HELICOPTER: {
      isEnabled: true,
      bookingMode: BookingMode.REQUEST,
      paymentModel: PaymentModel.B_OPERATOR_CONFIRMED,
      depositPercent: DEFAULT_DEPOSIT_PERCENT,
    },
    EMPTY_LEG: {
      isEnabled: true,
      bookingMode: BookingMode.REQUEST,
      paymentModel: PaymentModel.B_OPERATOR_CONFIRMED,
      depositPercent: DEFAULT_DEPOSIT_PERCENT,
    },
    AIR_AMBULANCE: {
      isEnabled: true,
      bookingMode: BookingMode.REQUEST,
      paymentModel: PaymentModel.B_OPERATOR_CONFIRMED,
      depositPercent: DEFAULT_DEPOSIT_PERCENT,
    },
  };

/**
 * Reads a stored per-category override. Anything malformed grants nothing:
 * a value that is not an object gives no overrides, and an unknown category
 * or value is dropped (fail closed, as `parsePermissions`).
 */
export function parseOverride<T extends string>(
  raw: unknown,
  allowed: readonly T[],
): CategoryOverride<T> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {};
  }
  const source = raw as Record<string, unknown>;
  const result: CategoryOverride<T> = {};
  for (const category of Object.values(ServiceCategory)) {
    if (!Object.hasOwn(source, category)) continue;
    const value = source[category];
    if (typeof value === 'string' && allowed.includes(value as T)) {
      result[category] = value as T;
    }
  }
  return result;
}

/** A change to a platform row; a field left out stays as it is. */
export type PlatformSettingChange = Partial<PlatformSetting>;

/**
 * The row after `change`, whether anything differs, or why it is refused:
 * air ambulance can never be INSTANT (rule 7, and the database CHECK).
 */
export function applyPlatformChange(
  category: ServiceCategory,
  current: PlatformSetting,
  change: PlatformSettingChange,
):
  | { ok: true; next: PlatformSetting; changed: boolean }
  | { ok: false; field: 'bookingMode'; issue: string } {
  const next: PlatformSetting = {
    isEnabled: change.isEnabled ?? current.isEnabled,
    bookingMode: change.bookingMode ?? current.bookingMode,
    paymentModel: change.paymentModel ?? current.paymentModel,
    depositPercent: change.depositPercent ?? current.depositPercent,
  };
  if (
    category === ServiceCategory.AIR_AMBULANCE &&
    next.bookingMode === BookingMode.INSTANT
  ) {
    return {
      ok: false,
      field: 'bookingMode',
      issue: 'air ambulance is always booked on request',
    };
  }
  const changed = (Object.keys(next) as (keyof PlatformSetting)[]).some(
    (key) => next[key] !== current[key],
  );
  return { ok: true, next, changed };
}

/**
 * The platform setting, then the operator's override for the category, then
 * rule 7: air ambulance never resolves to INSTANT, whatever is stored. With no
 * platform row the category is disabled and booked on request, and overrides
 * are ignored. An override never enables a category the platform disabled.
 */
export function resolveCategoryConfig(
  category: ServiceCategory,
  region: string,
  platform: PlatformSetting | null,
  override: {
    bookingMode: CategoryOverride<BookingMode>;
    paymentModel: CategoryOverride<PaymentModel>;
  } = { bookingMode: {}, paymentModel: {} },
): ResolvedCategoryConfig {
  if (!platform) {
    return {
      category,
      region,
      isEnabled: false,
      bookingMode: BookingMode.REQUEST,
      paymentModel: PaymentModel.B_OPERATOR_CONFIRMED,
      depositPercent: DEFAULT_DEPOSIT_PERCENT,
    };
  }
  let bookingMode = override.bookingMode[category] ?? platform.bookingMode;
  if (category === ServiceCategory.AIR_AMBULANCE) {
    bookingMode = BookingMode.REQUEST;
  }
  return {
    category,
    region,
    isEnabled: platform.isEnabled,
    bookingMode,
    paymentModel: override.paymentModel[category] ?? platform.paymentModel,
    depositPercent: platform.depositPercent,
  };
}
