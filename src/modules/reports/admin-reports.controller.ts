import { Controller, Get, HttpStatus, Param, Query, Res } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiProduces,
  ApiTags,
} from '@nestjs/swagger';
import type { Response } from 'express';
import { AppException } from '../../common/errors/app.exception.js';
import { Role } from '../../generated/prisma/enums.js';
import type { AuthUser } from '../auth/auth-user.js';
import { CurrentUser, Roles } from '../auth/auth.decorators.js';
import {
  AirAmbulanceReportDto,
  BookingReportDto,
  EmptyLegReportDto,
  OperatorReportDto,
  OverviewReportDto,
  PaymentReportDto,
  RevenueReportDto,
  SearchReportDto,
} from './dto/report.dto.js';
import {
  ReportCategoryQueryDto,
  ReportExportQueryDto,
  ReportOperatorQueryDto,
  ReportPeriodQueryDto,
  ReportScopedQueryDto,
} from './dto/report-query.dto.js';
import { toCsv } from './report-csv.js';
import { resolvePeriod } from './report-period.js';
import { ReportsService } from './reports.service.js';

const { OPS, FINANCE_ADMIN: FIN, SUPER_ADMIN: SA } = Role;

type Filter = 'category' | 'operatorId';

/**
 * Each report's roles and filters (security-rbac.md: View reports;
 * api-routes.md). The JSON routes and the CSV export read the same table,
 * so an export is never open to more roles than its report.
 */
const REPORTS = {
  overview: { roles: [OPS, FIN, SA], filters: [] },
  search: { roles: [OPS, SA], filters: ['category'] },
  bookings: { roles: [OPS, FIN, SA], filters: ['category', 'operatorId'] },
  revenue: { roles: [FIN, SA], filters: ['category', 'operatorId'] },
  payments: { roles: [FIN, SA], filters: [] },
  operators: { roles: [OPS, SA], filters: ['operatorId'] },
  'empty-legs': { roles: [OPS, SA], filters: ['operatorId'] },
  'air-ambulance': { roles: [OPS, SA], filters: [] },
} as const satisfies Record<
  string,
  { roles: readonly Role[]; filters: readonly Filter[] }
>;

type ReportName = keyof typeof REPORTS;

const FILTER_TEXT =
  '`from` and `to` are calendar days in India (`YYYY-MM-DD`, both included; IST day boundaries); by default the last 30 days, at most 366 days (400 `VALIDATION_ERROR` otherwise, also for `from` after `to`).';

@ApiTags('admin: reports')
@ApiCookieAuth()
@Controller('admin/reports')
export class AdminReportsController {
  constructor(private readonly reports: ReportsService) {}

  @Get('overview')
  @Roles(...REPORTS.overview.roles)
  @ApiOperation({
    summary: 'Headline figures for the admin dashboard',
    description: `${FILTER_TEXT} \`inPeriod\` counts what happened in the period; \`now\` is the current state whatever the period. \`finance\` (payments taken, refunds due, confirmed booking value, Flyviman's revenue) is for finance and the super administrator only and is omitted for operations.`,
  })
  @ApiOkResponse({ type: OverviewReportDto })
  overview(
    @CurrentUser() user: AuthUser,
    @Query() query: ReportPeriodQueryDto,
  ): Promise<OverviewReportDto> {
    return this.reports.overview(user, query);
  }

  @Get('search')
  @Roles(...REPORTS.search.roles)
  @ApiOperation({
    summary: 'Search volume and search-to-request conversion',
    description: `${FILTER_TEXT} Filter: \`category\`. Conversion is booking requests made in the period per search, by category; a request is not traced to its search.`,
  })
  @ApiOkResponse({ type: SearchReportDto })
  search(@Query() query: ReportCategoryQueryDto): Promise<SearchReportDto> {
    return this.reports.search(query);
  }

  @Get('bookings')
  @Roles(...REPORTS.bookings.roles)
  @ApiOperation({
    summary: 'Booking requests, confirmations and cancellations',
    description: `${FILTER_TEXT} Filters: \`category\`, \`operatorId\`. The requests made in the period, by their current booking status (never the payment status). Each figures block has \`finance\` (confirmed value, Flyviman's revenue) for finance and the super administrator only; omitted for operations.`,
  })
  @ApiOkResponse({ type: BookingReportDto })
  bookings(
    @CurrentUser() user: AuthUser,
    @Query() query: ReportScopedQueryDto,
  ): Promise<BookingReportDto> {
    return this.reports.bookingReport(user, query);
  }

  @Get('revenue')
  @Roles(...REPORTS.revenue.roles)
  @ApiOperation({
    summary: 'Gross booking value, operator payable and Flyviman revenue',
    description: `${FILTER_TEXT} Filters: \`category\`, \`operatorId\`. Bookings confirmed in the period and still confirmed, scheduled or completed; amounts from each booking's price calculation (the accepted quote's, else the booking's own), per currency.`,
  })
  @ApiOkResponse({ type: RevenueReportDto })
  revenue(@Query() query: ReportScopedQueryDto): Promise<RevenueReportDto> {
    return this.reports.revenue(query);
  }

  @Get('payments')
  @Roles(...REPORTS.payments.roles)
  @ApiOperation({
    summary: 'Payment success, failure and refund rates',
    description: `${FILTER_TEXT} Payment attempts and refunds started in the period. No card data or gateway references.`,
  })
  @ApiOkResponse({ type: PaymentReportDto })
  payments(@Query() query: ReportPeriodQueryDto): Promise<PaymentReportDto> {
    return this.reports.paymentReport(query);
  }

  @Get('operators')
  @Roles(...REPORTS.operators.roles)
  @ApiOperation({
    summary: 'Operator response time, declines and outcomes',
    description: `${FILTER_TEXT} Filter: \`operatorId\`. Booking requests made to each operator in the period; the response time is to the first accept, reject or quote by the operator's staff.`,
  })
  @ApiOkResponse({ type: OperatorReportDto })
  operators(
    @Query() query: ReportOperatorQueryDto,
  ): Promise<OperatorReportDto> {
    return this.reports.operatorReport(query);
  }

  @Get('empty-legs')
  @Roles(...REPORTS['empty-legs'].roles)
  @ApiOperation({
    summary: 'Empty-leg listing performance and conversion',
    description: `${FILTER_TEXT} Filter: \`operatorId\`. Offers created in the period.`,
  })
  @ApiOkResponse({ type: EmptyLegReportDto })
  emptyLegs(
    @Query() query: ReportOperatorQueryDto,
  ): Promise<EmptyLegReportDto> {
    return this.reports.emptyLegReport(query);
  }

  @Get('air-ambulance')
  @Roles(...REPORTS['air-ambulance'].roles)
  @ApiOperation({
    summary: 'Air ambulance volumes, response time and fulfilment',
    description: `${FILTER_TEXT} Requests made in the period. Counts and timings only: never patient, medical or contact data.`,
  })
  @ApiOkResponse({ type: AirAmbulanceReportDto })
  airAmbulance(
    @Query() query: ReportPeriodQueryDto,
  ): Promise<AirAmbulanceReportDto> {
    return this.reports.airAmbulanceReport(query);
  }

  @Get(':report/export')
  @Roles(OPS, FIN, SA)
  @ApiOperation({
    summary: 'A report as CSV',
    description: `The same report, filters and role gate as \`GET /admin/reports/:report\`: a role the report is not open to gets 403 \`FORBIDDEN\`, a filter the report does not take 400 \`VALIDATION_ERROR\`, an unknown report 404. ${FILTER_TEXT} \`text/csv\` as an attachment, one figure per row: \`section,dimension,metric,currency,value\` (money in paise). Finance fields appear only for finance and the super administrator. Text that a spreadsheet would read as a formula is prefixed with \`'\`.`,
  })
  @ApiParam({ name: 'report', enum: Object.keys(REPORTS) })
  @ApiProduces('text/csv')
  @ApiOkResponse({ schema: { type: 'string' } })
  async export(
    @CurrentUser() user: AuthUser,
    @Param('report') name: string,
    @Query() query: ReportExportQueryDto,
    @Res() response: Response,
  ): Promise<void> {
    if (!Object.hasOwn(REPORTS, name)) {
      throw new AppException(
        'NOT_FOUND',
        'Report not found.',
        HttpStatus.NOT_FOUND,
      );
    }
    const report = name as ReportName;
    const config = REPORTS[report];
    if (!(config.roles as readonly Role[]).includes(user.role)) {
      throw new AppException(
        'FORBIDDEN',
        'You do not have access to this.',
        HttpStatus.FORBIDDEN,
      );
    }
    const refused = (['category', 'operatorId'] as const).filter(
      (filter) =>
        query[filter] !== undefined &&
        !(config.filters as readonly Filter[]).includes(filter),
    );
    if (refused.length > 0) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The request is not valid.',
        HttpStatus.BAD_REQUEST,
        refused.map((field) => ({
          field,
          issue: 'not a filter of this report',
        })),
      );
    }
    const period = resolvePeriod(query);
    const data = await this.build(report, user, query);
    response.setHeader('Content-Type', 'text/csv; charset=utf-8');
    response.setHeader(
      'Content-Disposition',
      `attachment; filename="flyviman-${report}-${period.from}-to-${period.to}.csv"`,
    );
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cache-Control', 'private, no-store');
    response.status(HttpStatus.OK).send(toCsv(data));
  }

  private build(
    report: ReportName,
    user: AuthUser,
    query: ReportExportQueryDto,
  ): Promise<object> {
    const period = { from: query.from, to: query.to };
    switch (report) {
      case 'overview':
        return this.reports.overview(user, period);
      case 'search':
        return this.reports.search({ ...period, category: query.category });
      case 'bookings':
        return this.reports.bookingReport(user, query);
      case 'revenue':
        return this.reports.revenue(query);
      case 'payments':
        return this.reports.paymentReport(period);
      case 'operators':
        return this.reports.operatorReport({
          ...period,
          operatorId: query.operatorId,
        });
      case 'empty-legs':
        return this.reports.emptyLegReport({
          ...period,
          operatorId: query.operatorId,
        });
      case 'air-ambulance':
        return this.reports.airAmbulanceReport(period);
    }
  }
}
