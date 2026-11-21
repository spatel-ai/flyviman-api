import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import {
  BookingMode,
  PaymentModel,
  type ServiceCategory,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { OperatorsService } from '../operators/operators.service.js';
import {
  applyPlatformChange,
  DEFAULT_REGION,
  parseOverride,
  type PlatformSetting,
  type PlatformSettingChange,
  type ResolvedCategoryConfig,
  resolveCategoryConfig,
} from './category-config.js';

/** How long platform rows are kept in memory. */
const CACHE_TTL_MS = 30_000;

export interface CategoryConfigRow extends PlatformSetting {
  id: string;
  category: ServiceCategory;
  region: string;
  updatedAt: Date;
}

const BOOKING_MODES = Object.values(BookingMode);
const PAYMENT_MODELS = Object.values(PaymentModel);

@Injectable()
export class CategoryConfigService {
  private cache: { rows: CategoryConfigRow[]; expiresAt: number } | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * How `category` is booked and paid for in `region` (default IN), with the
   * operator's override applied when `operatorId` is given. Air ambulance is
   * never INSTANT (rule 7). Platform rows are cached for 30 seconds; operator
   * overrides are read on every call.
   */
  async resolve(
    category: ServiceCategory,
    options: { region?: string; operatorId?: string } = {},
  ): Promise<ResolvedCategoryConfig> {
    const region = options.region ?? DEFAULT_REGION;
    const platform =
      (await this.cachedRows()).find(
        (row) => row.category === category && row.region === region,
      ) ?? null;
    const raw = options.operatorId
      ? await this.operators.modeOverrides(options.operatorId)
      : null;
    return resolveCategoryConfig(category, region, platform, {
      bookingMode: parseOverride(raw?.bookingMode, BOOKING_MODES),
      paymentModel: parseOverride(raw?.paymentModel, PAYMENT_MODELS),
    });
  }

  /** Whether the platform offers `category` in the default region. */
  async isEnabled(category: ServiceCategory): Promise<boolean> {
    return (await this.resolve(category)).isEnabled;
  }

  /**
   * Refuses work in a category the platform has disabled: 422
   * `CATEGORY_DISABLED` (searches and requests; bookings answer
   * `BOOKING_CATEGORY_DISABLED`).
   */
  async assertEnabled(category: ServiceCategory): Promise<void> {
    if (!(await this.isEnabled(category))) {
      throw new AppException(
        'CATEGORY_DISABLED',
        'This service is not available at the moment.',
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  /** Every platform row, by region then category, read from the database. */
  list(region?: string): Promise<CategoryConfigRow[]> {
    return this.prisma.serviceCategoryConfig.findMany({
      where: region ? { region } : undefined,
      orderBy: [{ region: 'asc' }, { category: 'asc' }],
      select: ROW_SELECT,
    });
  }

  /**
   * Changes one platform row (super administrators, M10), audited with the
   * reason, before and after. Checked under the row's lock: 404 for an
   * unknown row, 409 `CATEGORY_CONFIG_CHANGED` when it changed since the
   * editor loaded it, 422 `CATEGORY_CONFIG_INVALID` for air ambulance on
   * INSTANT (rule 7). A change that alters nothing writes nothing. Bookings
   * already made keep the booking mode and payment model they snapshotted.
   */
  async update(
    id: string,
    input: PlatformSettingChange & {
      expectedUpdatedAt: string;
      reason: string;
    },
  ): Promise<CategoryConfigRow> {
    const { expectedUpdatedAt, reason, ...change } = input;
    const row = await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM "ServiceCategoryConfig" WHERE "id" = ${id}::uuid FOR UPDATE`;
      const current = await tx.serviceCategoryConfig.findUnique({
        where: { id },
        select: ROW_SELECT,
      });
      if (!current) {
        throw new AppException(
          'NOT_FOUND',
          'Category configuration not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (
        current.updatedAt.getTime() !== new Date(expectedUpdatedAt).getTime()
      ) {
        throw new AppException(
          'CATEGORY_CONFIG_CHANGED',
          'This configuration was changed after you opened it. Reload it and make your change again.',
          HttpStatus.CONFLICT,
          [
            {
              field: 'expectedUpdatedAt',
              issue: current.updatedAt.toISOString(),
            },
          ],
        );
      }
      const outcome = applyPlatformChange(current.category, current, change);
      if (!outcome.ok) {
        throw new AppException(
          'CATEGORY_CONFIG_INVALID',
          'Air ambulance is always booked on request.',
          HttpStatus.UNPROCESSABLE_ENTITY,
          [{ field: outcome.field, issue: outcome.issue }],
        );
      }
      if (!outcome.changed) return current;
      const updated = await tx.serviceCategoryConfig.update({
        where: { id },
        data: outcome.next,
        select: ROW_SELECT,
      });
      await this.audit.record(
        {
          action: 'category_config.update',
          entityType: 'ServiceCategoryConfig',
          entityId: id,
          before: auditSnapshot(current),
          after: auditSnapshot(updated),
          reason,
        },
        tx,
      );
      return updated;
    });
    // This process reads the change at once; others within 30 seconds.
    this.cache = null;
    return row;
  }

  private async cachedRows(): Promise<CategoryConfigRow[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.rows;
    const rows = await this.list();
    this.cache = { rows, expiresAt: now + CACHE_TTL_MS };
    return rows;
  }
}

const ROW_SELECT = {
  id: true,
  category: true,
  region: true,
  isEnabled: true,
  bookingMode: true,
  paymentModel: true,
  depositPercent: true,
  updatedAt: true,
} as const;

function auditSnapshot(row: CategoryConfigRow) {
  return {
    category: row.category,
    region: row.region,
    isEnabled: row.isEnabled,
    bookingMode: row.bookingMode,
    paymentModel: row.paymentModel,
    depositPercent: row.depositPercent,
  };
}
