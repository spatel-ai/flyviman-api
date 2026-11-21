import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service.js';
import {
  BookingEventType,
  Role,
  type BookingStatus,
  type ServiceCategory,
} from '../../generated/prisma/enums.js';
import { OPEN_STATUSES } from './bookings.service.js';

type Range = { gte: Date; lt: Date };

export interface BookingReportFilter {
  category?: ServiceCategory;
  operatorId?: string;
}

/** A booking's value and the calculation that priced it. Paise. */
export interface BookingValueRow {
  category: ServiceCategory;
  operatorId: string | null;
  totalMinor: bigint;
  currency: string;
  /** The accepted quote's calculation, else the booking's own; may be null. */
  calculationId: string | null;
}

/** A request to an operator and when the operator first answered it. */
export interface BookingResponseRow {
  operatorId: string;
  status: BookingStatus;
  createdAt: Date;
  firstResponseAt: Date | null;
}

const OPERATOR_ROLES = [Role.OPERATOR_ADMIN, Role.OPERATOR_STAFF];

/**
 * Read-only aggregates over bookings for the reports module (W5-1), which
 * may not read this module's tables itself. No customer or passenger data.
 */
@Injectable()
export class BookingReportsService {
  constructor(private readonly prisma: PrismaService) {}

  /** Bookings requested in the period, by category and current status. */
  async statusCounts(
    createdAt: Range,
    filter: BookingReportFilter = {},
  ): Promise<
    { category: ServiceCategory; status: BookingStatus; count: number }[]
  > {
    const rows = await this.prisma.booking.groupBy({
      by: ['category', 'status'],
      where: { createdAt, ...where(filter) },
      _count: { _all: true },
    });
    return rows.map((row) => ({
      category: row.category,
      status: row.status,
      count: row._count._all,
    }));
  }

  /** Requests waiting on the operator now (the bookings module's own set). */
  openRequestCount(): Promise<number> {
    return this.prisma.booking.count({
      where: { status: { in: OPEN_STATUSES } },
    });
  }

  /**
   * Bookings in the given statuses, requested (`createdAt`) or confirmed
   * (`confirmedAt`) in the period, with their value and calculation.
   */
  async valueRows(
    period: { createdAt: Range } | { confirmedAt: Range },
    statuses: readonly BookingStatus[],
    filter: BookingReportFilter = {},
  ): Promise<BookingValueRow[]> {
    const rows = await this.prisma.booking.findMany({
      where: { ...period, status: { in: [...statuses] }, ...where(filter) },
      select: {
        category: true,
        operatorId: true,
        totalMinor: true,
        currency: true,
        calculationId: true,
        acceptedQuote: { select: { calculationId: true } },
      },
    });
    return rows.map(({ acceptedQuote, calculationId, ...row }) => ({
      ...row,
      calculationId: acceptedQuote?.calculationId ?? calculationId,
    }));
  }

  /** Bookings in the given statuses confirmed in the period. */
  countConfirmedIn(
    confirmedAt: Range,
    statuses: readonly BookingStatus[],
    filter: BookingReportFilter = {},
  ): Promise<number> {
    return this.prisma.booking.count({
      where: { confirmedAt, status: { in: [...statuses] }, ...where(filter) },
    });
  }

  /**
   * Requests made to operators in the period, each with the time of the
   * operator's first answer (accept, reject or quote) by operator staff.
   */
  async responseRows(
    createdAt: Range,
    operatorId?: string,
  ): Promise<BookingResponseRow[]> {
    const rows = await this.prisma.booking.findMany({
      where: {
        createdAt,
        operatorId: operatorId ?? { not: null },
      },
      select: {
        operatorId: true,
        status: true,
        createdAt: true,
        events: {
          where: {
            type: {
              in: [
                BookingEventType.OPERATOR_RESPONSE,
                BookingEventType.QUOTE_ISSUED,
              ],
            },
            actorRole: { in: OPERATOR_ROLES },
          },
          orderBy: { createdAt: 'asc' },
          take: 1,
          select: { createdAt: true },
        },
      },
    });
    return rows.map((row) => ({
      operatorId: row.operatorId as string,
      status: row.status,
      createdAt: row.createdAt,
      firstResponseAt: row.events[0]?.createdAt ?? null,
    }));
  }
}

function where(filter: BookingReportFilter) {
  return {
    ...(filter.category ? { category: filter.category } : {}),
    ...(filter.operatorId ? { operatorId: filter.operatorId } : {}),
  };
}
