import { Injectable } from '@nestjs/common';
import {
  BookingMode,
  PaymentModel,
  type ServiceCategory,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { OperatorsService } from '../operators/operators.service.js';
import {
  DEFAULT_REGION,
  parseOverride,
  type PlatformSetting,
  type ResolvedCategoryConfig,
  resolveCategoryConfig,
} from './category-config.js';

/** How long platform rows are kept in memory. */
const CACHE_TTL_MS = 30_000;

export interface CategoryConfigRow extends PlatformSetting {
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

  /** Every platform row, by region then category, read from the database. */
  list(region?: string): Promise<CategoryConfigRow[]> {
    return this.prisma.serviceCategoryConfig.findMany({
      where: region ? { region } : undefined,
      orderBy: [{ region: 'asc' }, { category: 'asc' }],
      select: {
        category: true,
        region: true,
        isEnabled: true,
        bookingMode: true,
        paymentModel: true,
        depositPercent: true,
        updatedAt: true,
      },
    });
  }

  private async cachedRows(): Promise<CategoryConfigRow[]> {
    const now = Date.now();
    if (this.cache && this.cache.expiresAt > now) return this.cache.rows;
    const rows = await this.list();
    this.cache = { rows, expiresAt: now + CACHE_TTL_MS };
    return rows;
  }
}
