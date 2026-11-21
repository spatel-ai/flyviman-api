import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import type {
  PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
} from '../../generated/prisma/enums.js';
import { MONEY_IN } from '../bookings/paid-amount.js';
import { RefundsService } from './refunds.service.js';

type Range = { gte: Date; lt: Date };

/** An amount per currency. Paise. */
export interface CurrencyAmount {
  currency: string;
  amountMinor: bigint;
}

/**
 * Read-only payment and refund figures for the reports module (W5-1),
 * which may not read this module's tables itself. Finance figures: callers
 * gate them to finance and the super administrator. No card data exists to
 * read (rule 10); gateway references are not returned.
 */
@Injectable()
export class PaymentReportsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly refunds: RefundsService,
  ) {}

  /** Payments whose money arrived (`paidAt`) in the period. */
  async taken(
    paidAt: Range,
  ): Promise<{ count: number; amounts: CurrencyAmount[] }> {
    const rows = await this.prisma.payment.groupBy({
      by: ['currency'],
      where: { paidAt, status: { in: [...MONEY_IN] } },
      _count: { _all: true },
      _sum: { amountMinor: true },
    });
    return {
      count: rows.reduce((total, row) => total + row._count._all, 0),
      amounts: rows.map((row) => ({
        currency: row.currency,
        amountMinor: row._sum.amountMinor ?? 0n,
      })),
    };
  }

  /** The finance refunds-due queue now, totalled (the same rows as the queue). */
  async refundsDue(): Promise<{ count: number; amounts: CurrencyAmount[] }> {
    const { items, total } = await this.refunds.due(1, Number.MAX_SAFE_INTEGER);
    const sums = new Map<string, bigint>();
    for (const item of items) {
      sums.set(
        item.currency,
        (sums.get(item.currency) ?? 0n) + BigInt(item.dueMinor),
      );
    }
    return {
      count: total,
      amounts: [...sums].map(([currency, amountMinor]) => ({
        currency,
        amountMinor,
      })),
    };
  }

  /** Payment attempts and refunds created in the period. */
  async summary(createdAt: Range): Promise<{
    byStatus: {
      status: PaymentStatus;
      currency: string;
      count: number;
      amountMinor: bigint;
    }[];
    byMethod: { method: string | null; status: PaymentStatus; count: number }[];
    flagged: { reason: PaymentReviewReason; count: number }[];
    refunds: {
      status: RefundStatus;
      currency: string;
      count: number;
      amountMinor: bigint;
    }[];
  }> {
    const [byStatus, byMethod, flagged, refunds] = await Promise.all([
      this.prisma.payment.groupBy({
        by: ['status', 'currency'],
        where: { createdAt },
        _count: { _all: true },
        _sum: { amountMinor: true },
      }),
      this.prisma.payment.groupBy({
        by: ['method', 'status'],
        where: { createdAt },
        _count: { _all: true },
      }),
      this.prisma.payment.groupBy({
        by: ['reviewReason'],
        where: { createdAt, reviewReason: { not: null } },
        _count: { _all: true },
      }),
      this.prisma.refund.groupBy({
        by: ['status', 'currency'],
        where: { createdAt },
        _count: { _all: true },
        _sum: { amountMinor: true },
      }),
    ]);
    return {
      byStatus: byStatus.map((row) => ({
        status: row.status,
        currency: row.currency,
        count: row._count._all,
        amountMinor: row._sum.amountMinor ?? 0n,
      })),
      byMethod: byMethod.map((row) => ({
        method: row.method,
        status: row.status,
        count: row._count._all,
      })),
      flagged: flagged.map((row) => ({
        reason: row.reviewReason as PaymentReviewReason,
        count: row._count._all,
      })),
      refunds: refunds.map((row) => ({
        status: row.status,
        currency: row.currency,
        count: row._count._all,
        amountMinor: row._sum.amountMinor ?? 0n,
      })),
    };
  }
}
