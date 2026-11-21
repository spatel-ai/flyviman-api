import { Injectable } from '@nestjs/common';
import { minorToNumber } from '../../common/money.js';
import {
  AirAmbulanceStatus,
  BookingStatus,
  EmptyLegStatus,
  PaymentStatus,
  RefundStatus,
  Role,
  type ServiceCategory,
} from '../../generated/prisma/enums.js';
import { AirAmbulanceReportsService } from '../air-ambulance/air-ambulance-reports.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import {
  BookingReportsService,
  type BookingReportFilter,
  type BookingValueRow,
} from '../bookings/booking-reports.service.js';
import { MONEY_IN } from '../bookings/paid-amount.js';
import { EmptyLegReportsService } from '../empty-legs/empty-leg-reports.service.js';
import { OperatorReportsService } from '../operators/operator-reports.service.js';
import {
  PaymentReportsService,
  type CurrencyAmount,
} from '../payments/payment-reports.service.js';
import {
  PricingReportsService,
  type CalculationSplit,
} from '../pricing/pricing-reports.service.js';
import { SearchReportsService } from '../search/search-reports.service.js';
import type {
  AirAmbulanceReportDto,
  BookingCategoryFiguresDto,
  BookingFiguresDto,
  BookingFinanceDto,
  BookingReportDto,
  EmptyLegReportDto,
  MoneyTotalDto,
  OperatorPerformanceRowDto,
  OperatorReportDto,
  OverviewReportDto,
  PaymentReportDto,
  ReportFiltersDto,
  ReportPeriodDto,
  RevenueFiguresDto,
  RevenueReportDto,
  SearchFiguresDto,
  SearchReportDto,
} from './dto/report.dto.js';
import type {
  ReportCategoryQueryDto,
  ReportOperatorQueryDto,
  ReportPeriodQueryDto,
  ReportScopedQueryDto,
} from './dto/report-query.dto.js';
import { resolvePeriod, type ReportPeriod } from './report-period.js';

const B = BookingStatus;
/** Confirmed and not undone: the only bookings that carry value (rule 1). */
const CONFIRMED: readonly BookingStatus[] = [
  B.CONFIRMED,
  B.SCHEDULED,
  B.COMPLETED,
];
const OPEN: readonly BookingStatus[] = [
  B.REQUESTED,
  B.OPERATOR_PENDING,
  B.CLARIFICATION_REQUESTED,
  B.PRICE_CONFIRMED,
  B.AWAITING_PAYMENT,
];
const DECLINED: readonly BookingStatus[] = [
  B.OPERATOR_UNAVAILABLE,
  B.QUOTE_DECLINED,
];

const FINANCE_ROLES: readonly Role[] = [Role.FINANCE_ADMIN, Role.SUPER_ADMIN];

/** Whether the caller sees money and commission (security-rbac.md: View reports). */
export function seesFinance(user: AuthUser): boolean {
  return FINANCE_ROLES.includes(user.role);
}

function rate(part: number, whole: number): number | null {
  return whole === 0 ? null : Math.round((part / whole) * 10_000) / 10_000;
}

function average(values: number[]): number | null {
  return values.length === 0
    ? null
    : values.reduce((total, v) => total + v, 0) / values.length;
}

function minutes(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 60_000;
}

function roundOrNull(value: number | null, digits = 0): number | null {
  if (value === null) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function periodDto(period: ReportPeriod): ReportPeriodDto {
  return {
    from: period.from,
    to: period.to,
    timeZone: 'Asia/Kolkata',
    startsAt: period.range.gte.toISOString(),
    endsBefore: period.range.lt.toISOString(),
  };
}

function filtersDto(query: {
  category?: ServiceCategory;
  operatorId?: string;
}): ReportFiltersDto {
  return {
    category: query.category ?? null,
    operatorId: query.operatorId ?? null,
  };
}

/** Sums per currency, in first-seen order, as JSON integers. */
function totals(items: CurrencyAmount[]): MoneyTotalDto[] {
  const sums = new Map<string, bigint>();
  for (const item of items) {
    sums.set(item.currency, (sums.get(item.currency) ?? 0n) + item.amountMinor);
  }
  return [...sums].map(([currency, amountMinor]) => ({
    currency,
    amountMinor: minorToNumber(amountMinor),
  }));
}

function countOf<S extends string>(
  rows: { status: S; count: number }[],
  statuses: readonly S[],
): number {
  return rows
    .filter((row) => statuses.includes(row.status))
    .reduce((total, row) => total + row.count, 0);
}

@Injectable()
export class ReportsService {
  constructor(
    private readonly searches: SearchReportsService,
    private readonly bookings: BookingReportsService,
    private readonly payments: PaymentReportsService,
    private readonly pricing: PricingReportsService,
    private readonly operators: OperatorReportsService,
    private readonly emptyLegs: EmptyLegReportsService,
    private readonly airAmbulance: AirAmbulanceReportsService,
  ) {}

  async overview(
    user: AuthUser,
    query: ReportPeriodQueryDto,
  ): Promise<OverviewReportDto> {
    const period = resolvePeriod(query);
    const { range } = period;
    const [
      searches,
      statusCounts,
      airAmbulanceRequests,
      openBookingRequests,
      operatorsPendingReview,
      airAmbulanceOpen,
    ] = await Promise.all([
      this.searches.count(range),
      this.bookings.statusCounts(range),
      this.airAmbulance.count(range),
      this.bookings.openRequestCount(),
      this.operators.pendingReviewCount(),
      this.airAmbulance.openCount(),
    ]);
    const report: OverviewReportDto = {
      period: periodDto(period),
      inPeriod: {
        searches,
        bookingRequests: statusCounts.reduce((t, row) => t + row.count, 0),
        bookingsByStatus: this.byBookingStatus(statusCounts),
        airAmbulanceRequests,
      },
      now: { openBookingRequests, operatorsPendingReview, airAmbulanceOpen },
    };
    if (seesFinance(user)) {
      const [taken, due, confirmed] = await Promise.all([
        this.payments.taken(range),
        this.payments.refundsDue(),
        this.bookings.valueRows({ confirmedAt: range }, CONFIRMED),
      ]);
      const finance = await this.bookingFinance(confirmed);
      report.finance = {
        paymentsTaken: { count: taken.count, amounts: totals(taken.amounts) },
        refundsDue: { count: due.count, amounts: totals(due.amounts) },
        confirmedBookingValue: finance.confirmedValue,
        platformRevenue: finance.platformRevenue,
      };
    }
    return report;
  }

  async search(query: ReportCategoryQueryDto): Promise<SearchReportDto> {
    const period = resolvePeriod(query);
    const [rows, statusCounts] = await Promise.all([
      this.searches.byCategory(period.range, query.category),
      this.bookings.statusCounts(period.range, { category: query.category }),
    ]);
    const requestsIn = (category: ServiceCategory): number =>
      statusCounts
        .filter((row) => row.category === category)
        .reduce((total, row) => total + row.count, 0);

    const byCategory = rows.map((row) => {
      const bookingRequests = requestsIn(row.category);
      return {
        category: row.category,
        searches: row.searches,
        withoutResults: row.withoutResults,
        averageResults: roundOrNull(row.averageResults, 1),
        averageDurationMs: roundOrNull(row.averageDurationMs),
        bookingRequests,
        conversionRate: rate(bookingRequests, row.searches),
      };
    });
    const searches = rows.reduce((t, row) => t + row.searches, 0);
    const weighted = (pick: (row: (typeof rows)[number]) => number | null) =>
      searches === 0
        ? null
        : rows.reduce((t, row) => t + (pick(row) ?? 0) * row.searches, 0) /
          searches;
    const bookingRequests = byCategory.reduce(
      (t, row) => t + row.bookingRequests,
      0,
    );
    const totalsRow: SearchFiguresDto = {
      searches,
      withoutResults: rows.reduce((t, row) => t + row.withoutResults, 0),
      averageResults: roundOrNull(
        weighted((row) => row.averageResults),
        1,
      ),
      averageDurationMs: roundOrNull(weighted((row) => row.averageDurationMs)),
      bookingRequests,
      conversionRate: rate(bookingRequests, searches),
    };
    return {
      period: periodDto(period),
      filters: filtersDto({ category: query.category }),
      totals: totalsRow,
      byCategory,
    };
  }

  async bookingReport(
    user: AuthUser,
    query: ReportScopedQueryDto,
  ): Promise<BookingReportDto> {
    const period = resolvePeriod(query);
    const filter: BookingReportFilter = {
      category: query.category,
      operatorId: query.operatorId,
    };
    const finance = seesFinance(user);
    const [statusCounts, confirmedRows] = await Promise.all([
      this.bookings.statusCounts(period.range, filter),
      finance
        ? this.bookings.valueRows(
            { createdAt: period.range },
            CONFIRMED,
            filter,
          )
        : Promise.resolve([]),
    ]);
    const splits = finance ? await this.splitsFor(confirmedRows) : new Map();

    const figures = (
      rows: typeof statusCounts,
      valueRows: BookingValueRow[],
    ): BookingFiguresDto => {
      const requested = rows.reduce((t, row) => t + row.count, 0);
      const confirmed = countOf(rows, CONFIRMED);
      return {
        requested,
        open: countOf(rows, OPEN),
        confirmed,
        declined: countOf(rows, DECLINED),
        expired: countOf(rows, [B.EXPIRED]),
        cancelled: countOf(rows, [B.CANCELLED]),
        confirmationRate: rate(confirmed, requested),
        ...(finance ? { finance: financeOf(valueRows, splits) } : {}),
      };
    };

    const categories = [...new Set(statusCounts.map((row) => row.category))];
    const byCategory: BookingCategoryFiguresDto[] = categories.map(
      (category) => ({
        category,
        ...figures(
          statusCounts.filter((row) => row.category === category),
          confirmedRows.filter((row) => row.category === category),
        ),
      }),
    );
    return {
      period: periodDto(period),
      filters: filtersDto(query),
      totals: figures(statusCounts, confirmedRows),
      byStatus: this.byBookingStatus(statusCounts),
      byCategory,
    };
  }

  async revenue(query: ReportScopedQueryDto): Promise<RevenueReportDto> {
    const period = resolvePeriod(query);
    const filter: BookingReportFilter = {
      category: query.category,
      operatorId: query.operatorId,
    };
    const [rows, cancelledAfterConfirmation] = await Promise.all([
      this.bookings.valueRows({ confirmedAt: period.range }, CONFIRMED, filter),
      this.bookings.countConfirmedIn(period.range, [B.CANCELLED], filter),
    ]);
    const splits = await this.splitsFor(rows);
    const names = await this.operators.names(
      rows.flatMap((row) => (row.operatorId ? [row.operatorId] : [])),
    );

    const grouped = <K extends string>(
      key: (row: BookingValueRow) => K,
    ): Map<string, { key: K; currency: string; rows: BookingValueRow[] }> => {
      const groups = new Map<
        string,
        { key: K; currency: string; rows: BookingValueRow[] }
      >();
      for (const row of rows) {
        const k = key(row);
        const id = `${k}|${row.currency}`;
        const group = groups.get(id) ?? {
          key: k,
          currency: row.currency,
          rows: [],
        };
        group.rows.push(row);
        groups.set(id, group);
      }
      return groups;
    };
    const figures = (
      currency: string,
      group: BookingValueRow[],
    ): RevenueFiguresDto => {
      const sum = { gross: 0n, tax: 0n, payable: 0n, platform: 0n };
      let withoutCalculation = 0;
      for (const row of group) {
        sum.gross += row.totalMinor;
        const split = row.calculationId
          ? splits.get(row.calculationId)
          : undefined;
        if (!split) {
          withoutCalculation += 1;
          continue;
        }
        sum.tax += split.taxMinor;
        sum.payable += split.operatorPayableMinor;
        sum.platform += split.platformRevenueMinor;
      }
      return {
        currency,
        bookings: group.length,
        grossValueMinor: minorToNumber(sum.gross),
        taxMinor: minorToNumber(sum.tax),
        operatorPayableMinor: minorToNumber(sum.payable),
        platformRevenueMinor: minorToNumber(sum.platform),
        withoutCalculation,
      };
    };

    return {
      period: periodDto(period),
      filters: filtersDto(query),
      totals: [...grouped(() => '').values()].map((g) =>
        figures(g.currency, g.rows),
      ),
      byCategory: [...grouped((row) => row.category).values()].map((g) => ({
        category: g.key,
        ...figures(g.currency, g.rows),
      })),
      byOperator: [...grouped((row) => row.operatorId ?? '').values()]
        .map((g) => ({
          operatorId: g.key || null,
          operatorName: g.key ? (names.get(g.key)?.name ?? null) : null,
          ...figures(g.currency, g.rows),
        }))
        .sort((a, b) => b.grossValueMinor - a.grossValueMinor),
      cancelledAfterConfirmation,
    };
  }

  async paymentReport(query: ReportPeriodQueryDto): Promise<PaymentReportDto> {
    const period = resolvePeriod(query);
    const summary = await this.payments.summary(period.range);
    const statusCounts = new Map<PaymentStatus, number>();
    for (const row of summary.byStatus) {
      statusCounts.set(
        row.status,
        (statusCounts.get(row.status) ?? 0) + row.count,
      );
    }
    const moneyIn = summary.byStatus.filter((row) =>
      MONEY_IN.includes(row.status),
    );
    const succeeded = moneyIn.reduce((t, row) => t + row.count, 0);
    const failed = statusCounts.get(PaymentStatus.FAILED) ?? 0;
    const collected = totals(moneyIn);

    const methods = new Map<
      string | null,
      { succeeded: number; failed: number }
    >();
    for (const row of summary.byMethod) {
      const entry = methods.get(row.method) ?? { succeeded: 0, failed: 0 };
      if (MONEY_IN.includes(row.status)) entry.succeeded += row.count;
      if (row.status === PaymentStatus.FAILED) entry.failed += row.count;
      methods.set(row.method, entry);
    }

    const refundCounts = new Map<RefundStatus, number>();
    for (const row of summary.refunds) {
      refundCounts.set(
        row.status,
        (refundCounts.get(row.status) ?? 0) + row.count,
      );
    }
    const refunded = totals(
      summary.refunds.filter((row) => row.status === RefundStatus.COMPLETED),
    );
    return {
      period: periodDto(period),
      attempts: summary.byStatus.reduce((t, row) => t + row.count, 0),
      byStatus: [...statusCounts].map(([status, count]) => ({ status, count })),
      succeeded,
      failed,
      successRate: rate(succeeded, succeeded + failed),
      collected,
      byMethod: [...methods].map(([method, counts]) => ({ method, ...counts })),
      flagged: summary.flagged,
      refunds: {
        count: summary.refunds.reduce((t, row) => t + row.count, 0),
        byStatus: [...refundCounts].map(([status, count]) => ({
          status,
          count,
        })),
        refunded,
        inProgress: totals(
          summary.refunds.filter(
            (row) =>
              row.status === RefundStatus.REQUESTED ||
              row.status === RefundStatus.PENDING,
          ),
        ),
        refundRate: collected.map(({ currency, amountMinor }) => ({
          currency,
          rate: rate(
            refunded.find((r) => r.currency === currency)?.amountMinor ?? 0,
            amountMinor,
          ),
        })),
      },
    };
  }

  async operatorReport(
    query: ReportOperatorQueryDto,
  ): Promise<OperatorReportDto> {
    const period = resolvePeriod(query);
    const [byStatus, rows] = await Promise.all([
      this.operators.statusCounts(),
      this.bookings.responseRows(period.range, query.operatorId),
    ]);
    const names = await this.operators.names(rows.map((row) => row.operatorId));
    const groups = new Map<string, typeof rows>();
    for (const row of rows) {
      groups.set(row.operatorId, [...(groups.get(row.operatorId) ?? []), row]);
    }
    const operators: OperatorPerformanceRowDto[] = [];
    for (const [operatorId, group] of groups) {
      const operator = names.get(operatorId);
      if (!operator) continue;
      const answered = group.filter((row) => row.firstResponseAt !== null);
      const declined = group.filter(
        (row) => row.status === B.OPERATOR_UNAVAILABLE,
      ).length;
      operators.push({
        operatorId,
        operatorName: operator.name,
        status: operator.status,
        requests: group.length,
        responded: answered.length,
        responseRate: rate(answered.length, group.length),
        averageResponseMinutes: roundOrNull(
          average(
            answered.map((row) =>
              minutes(row.createdAt, row.firstResponseAt as Date),
            ),
          ),
        ),
        declined,
        declineRate: rate(declined, group.length),
        expired: group.filter((row) => row.status === B.EXPIRED).length,
        confirmed: group.filter((row) => CONFIRMED.includes(row.status)).length,
        cancelled: group.filter((row) => row.status === B.CANCELLED).length,
      });
    }
    operators.sort(
      (a, b) =>
        b.requests - a.requests || a.operatorName.localeCompare(b.operatorName),
    );
    return {
      period: periodDto(period),
      filters: filtersDto({ operatorId: query.operatorId }),
      byStatus,
      operators,
    };
  }

  async emptyLegReport(
    query: ReportOperatorQueryDto,
  ): Promise<EmptyLegReportDto> {
    const period = resolvePeriod(query);
    const summary = await this.emptyLegs.summary(
      period.range,
      query.operatorId,
    );
    const S = EmptyLegStatus;
    const booked = countOf(summary.byStatus, [S.BOOKED]);
    return {
      period: periodDto(period),
      filters: filtersDto({ operatorId: query.operatorId }),
      created: summary.byStatus.reduce((t, row) => t + row.count, 0),
      byStatus: summary.byStatus,
      published: summary.published,
      booked,
      withdrawn: countOf(summary.byStatus, [S.WITHDRAWN]),
      expired: countOf(summary.byStatus, [S.EXPIRED]),
      interests: summary.interests,
      bookingRate: rate(booked, summary.published),
    };
  }

  async airAmbulanceReport(
    query: ReportPeriodQueryDto,
  ): Promise<AirAmbulanceReportDto> {
    const period = resolvePeriod(query);
    const rows = await this.airAmbulance.rows(period.range);
    const S = AirAmbulanceStatus;
    const byStatus = new Map<AirAmbulanceStatus, number>();
    for (const row of rows)
      byStatus.set(row.status, (byStatus.get(row.status) ?? 0) + 1);
    const count = (status: AirAmbulanceStatus) => byStatus.get(status) ?? 0;
    const completed = count(S.COMPLETED);
    const declined = count(S.DECLINED);
    const cancelled = count(S.CANCELLED);
    const quoted = rows.filter((row) => row.quotedAt !== null);
    const confirmed = rows.filter((row) => row.confirmedAt !== null);
    return {
      period: periodDto(period),
      requests: rows.length,
      byStatus: [...byStatus].map(([status, n]) => ({ status, count: n })),
      open: rows.length - completed - declined - cancelled,
      quoted: quoted.length,
      confirmed: confirmed.length,
      completed,
      declined,
      cancelled,
      averageMinutesToQuote: roundOrNull(
        average(
          quoted.map((row) => minutes(row.createdAt, row.quotedAt as Date)),
        ),
      ),
      averageMinutesToConfirm: roundOrNull(
        average(
          confirmed.map((row) =>
            minutes(row.createdAt, row.confirmedAt as Date),
          ),
        ),
      ),
      fulfilmentRate: rate(completed, completed + declined + cancelled),
    };
  }

  private byBookingStatus(
    rows: { status: BookingStatus; count: number }[],
  ): { status: BookingStatus; count: number }[] {
    return Object.values(BookingStatus).map((status) => ({
      status,
      count: countOf(rows, [status]),
    }));
  }

  private splitsFor(
    rows: BookingValueRow[],
  ): Promise<Map<string, CalculationSplit>> {
    return this.pricing.splits(
      rows.flatMap((row) => (row.calculationId ? [row.calculationId] : [])),
    );
  }

  private async bookingFinance(
    rows: BookingValueRow[],
  ): Promise<BookingFinanceDto> {
    return financeOf(rows, await this.splitsFor(rows));
  }
}

/** Value and Flyviman's revenue of confirmed bookings. */
function financeOf(
  rows: BookingValueRow[],
  splits: Map<string, CalculationSplit>,
): BookingFinanceDto {
  const revenue: CurrencyAmount[] = [];
  let withoutCalculation = 0;
  for (const row of rows) {
    const split = row.calculationId ? splits.get(row.calculationId) : undefined;
    if (split) {
      revenue.push({
        currency: split.currency,
        amountMinor: split.platformRevenueMinor,
      });
    } else {
      withoutCalculation += 1;
    }
  }
  return {
    confirmedValue: totals(
      rows.map((row) => ({
        currency: row.currency,
        amountMinor: row.totalMinor,
      })),
    ),
    platformRevenue: totals(revenue),
    withoutCalculation,
  };
}
