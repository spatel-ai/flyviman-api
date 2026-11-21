import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AirAmbulanceStatus,
  BookingStatus,
  EmptyLegStatus,
  OperatorStatus,
  PaymentReviewReason,
  PaymentStatus,
  RefundStatus,
  ServiceCategory,
} from '../../../generated/prisma/enums.js';

const RATE =
  'A share from 0 to 1, rounded to 4 decimals; null when there is nothing to divide by.';

// --- Shared -----------------------------------------------------------------

export class ReportPeriodDto {
  @ApiProperty({ format: 'date', example: '2026-11-01' })
  from: string;

  @ApiProperty({ format: 'date', example: '2026-11-30' })
  to: string;

  @ApiProperty({ example: 'Asia/Kolkata' })
  timeZone: string;

  @ApiProperty({
    format: 'date-time',
    description: 'The start of `from` in India, UTC.',
  })
  startsAt: string;

  @ApiProperty({
    format: 'date-time',
    description: 'The start of the day after `to` in India, UTC (excluded).',
  })
  endsBefore: string;
}

export class ReportFiltersDto {
  @ApiProperty({
    enum: ServiceCategory,
    enumName: 'ServiceCategory',
    nullable: true,
  })
  category: ServiceCategory | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  operatorId: string | null;
}

/** An amount in one currency. Never a float (paise). */
export class MoneyTotalDto {
  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({ description: 'Minor units (paise).' })
  amountMinor: number;
}

export class CountWithAmountsDto {
  @ApiProperty()
  count: number;

  @ApiProperty({ type: [MoneyTotalDto] })
  amounts: MoneyTotalDto[];
}

export class BookingStatusCountDto {
  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;

  @ApiProperty()
  count: number;
}

// --- Overview -----------------------------------------------------------------

export class OverviewPeriodFiguresDto {
  @ApiProperty({ description: 'Searches made in the period.' })
  searches: number;

  @ApiProperty({ description: 'Booking requests made in the period.' })
  bookingRequests: number;

  @ApiProperty({
    type: [BookingStatusCountDto],
    description:
      'The booking requests made in the period, by their current booking status (not the payment status).',
  })
  bookingsByStatus: BookingStatusCountDto[];

  @ApiProperty({ description: 'Air ambulance requests made in the period.' })
  airAmbulanceRequests: number;
}

export class OverviewCurrentFiguresDto {
  @ApiProperty({
    description:
      'Booking requests waiting on the operator now (`REQUESTED`, `OPERATOR_PENDING`, `CLARIFICATION_REQUESTED`).',
  })
  openBookingRequests: number;

  @ApiProperty({ description: 'Operators waiting for review now.' })
  operatorsPendingReview: number;

  @ApiProperty({
    description:
      'Air ambulance requests not yet `COMPLETED`, `DECLINED` or `CANCELLED`.',
  })
  airAmbulanceOpen: number;
}

export class OverviewFinanceDto {
  @ApiProperty({
    type: CountWithAmountsDto,
    description:
      'In the period: payments whose money arrived (`paidAt`), counted at their full amount even if refunded since.',
  })
  paymentsTaken: CountWithAmountsDto;

  @ApiProperty({
    type: CountWithAmountsDto,
    description:
      'Now: the finance refunds-due queue (`GET /admin/refunds/due`), its rows and the amounts due.',
  })
  refundsDue: CountWithAmountsDto;

  @ApiProperty({
    type: [MoneyTotalDto],
    description:
      'In the period: the total of bookings confirmed (`confirmedAt`) and still `CONFIRMED`, `SCHEDULED` or `COMPLETED`.',
  })
  confirmedBookingValue: MoneyTotalDto[];

  @ApiProperty({
    type: [MoneyTotalDto],
    description:
      "Flyviman's revenue on those bookings (commission, markup and fees, less discounts, before tax), from their price calculations.",
  })
  platformRevenue: MoneyTotalDto[];
}

export class OverviewReportDto {
  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ type: OverviewPeriodFiguresDto })
  inPeriod: OverviewPeriodFiguresDto;

  @ApiProperty({
    type: OverviewCurrentFiguresDto,
    description: 'Figures as they are now, whatever the period.',
  })
  now: OverviewCurrentFiguresDto;

  @ApiPropertyOptional({
    type: OverviewFinanceDto,
    description: 'Finance and super administrator only; omitted otherwise.',
  })
  finance?: OverviewFinanceDto;
}

// --- Search -------------------------------------------------------------------

export class SearchFiguresDto {
  @ApiProperty()
  searches: number;

  @ApiProperty({ description: 'Searches that offered nothing.' })
  withoutResults: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Results offered per search, 1 decimal.',
  })
  averageResults: number | null;

  @ApiProperty({ type: Number, nullable: true, description: 'Whole ms.' })
  averageDurationMs: number | null;

  @ApiProperty({
    description:
      'Booking requests made in the period in the same categories. Not traced to the search they came from.',
  })
  bookingRequests: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: `Booking requests per search. ${RATE}`,
  })
  conversionRate: number | null;
}

export class SearchCategoryFiguresDto extends SearchFiguresDto {
  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;
}

export class SearchReportDto {
  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ type: ReportFiltersDto })
  filters: ReportFiltersDto;

  @ApiProperty({ type: SearchFiguresDto })
  totals: SearchFiguresDto;

  @ApiProperty({ type: [SearchCategoryFiguresDto] })
  byCategory: SearchCategoryFiguresDto[];
}

// --- Bookings -----------------------------------------------------------------

export class BookingFinanceDto {
  @ApiProperty({
    type: [MoneyTotalDto],
    description:
      'The total of the confirmed bookings (`CONFIRMED`, `SCHEDULED`, `COMPLETED`). Estimates of open requests are never added.',
  })
  confirmedValue: MoneyTotalDto[];

  @ApiProperty({
    type: [MoneyTotalDto],
    description:
      "Flyviman's revenue on them (commission, markup and fees, less discounts, before tax).",
  })
  platformRevenue: MoneyTotalDto[];

  @ApiProperty({
    description:
      'Confirmed bookings with no price calculation (for example scheduled fares): in `confirmedValue`, not in `platformRevenue`.',
  })
  withoutCalculation: number;
}

export class BookingFiguresDto {
  @ApiProperty({ description: 'Requests made in the period.' })
  requested: number;

  @ApiProperty({
    description:
      'Still in progress: `REQUESTED`, `OPERATOR_PENDING`, `CLARIFICATION_REQUESTED`, `PRICE_CONFIRMED`, `AWAITING_PAYMENT`.',
  })
  open: number;

  @ApiProperty({ description: '`CONFIRMED`, `SCHEDULED` or `COMPLETED`.' })
  confirmed: number;

  @ApiProperty({ description: '`OPERATOR_UNAVAILABLE` or `QUOTE_DECLINED`.' })
  declined: number;

  @ApiProperty()
  expired: number;

  @ApiProperty()
  cancelled: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: `Confirmed per request. ${RATE}`,
  })
  confirmationRate: number | null;

  @ApiPropertyOptional({
    type: BookingFinanceDto,
    description: 'Finance and super administrator only; omitted otherwise.',
  })
  finance?: BookingFinanceDto;
}

export class BookingCategoryFiguresDto extends BookingFiguresDto {
  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;
}

export class BookingReportDto {
  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ type: ReportFiltersDto })
  filters: ReportFiltersDto;

  @ApiProperty({
    type: BookingFiguresDto,
    description:
      'The requests made in the period, by their current booking status.',
  })
  totals: BookingFiguresDto;

  @ApiProperty({ type: [BookingStatusCountDto] })
  byStatus: BookingStatusCountDto[];

  @ApiProperty({ type: [BookingCategoryFiguresDto] })
  byCategory: BookingCategoryFiguresDto[];
}

// --- Revenue ------------------------------------------------------------------

export class RevenueFiguresDto {
  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty()
  bookings: number;

  @ApiProperty({
    description: 'Paise: what customers pay (gross booking value).',
  })
  grossValueMinor: number;

  @ApiProperty({ description: 'Paise: tax in the priced bookings.' })
  taxMinor: number;

  @ApiProperty({ description: 'Paise: what Flyviman pays operators.' })
  operatorPayableMinor: number;

  @ApiProperty({
    description:
      "Paise: Flyviman's net revenue (commission, markup and fees, less discounts, before tax). Can be negative.",
  })
  platformRevenueMinor: number;

  @ApiProperty({
    description:
      'Bookings with no price calculation: in `grossValueMinor` only.',
  })
  withoutCalculation: number;
}

export class RevenueCategoryRowDto extends RevenueFiguresDto {
  @ApiProperty({ enum: ServiceCategory, enumName: 'ServiceCategory' })
  category: ServiceCategory;
}

export class RevenueOperatorRowDto extends RevenueFiguresDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Null for scheduled airline bookings.',
  })
  operatorId: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Trading name, else legal name.',
  })
  operatorName: string | null;
}

export class RevenueReportDto {
  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ type: ReportFiltersDto })
  filters: ReportFiltersDto;

  @ApiProperty({
    type: [RevenueFiguresDto],
    description:
      'Bookings confirmed in the period (`confirmedAt`) and still `CONFIRMED`, `SCHEDULED` or `COMPLETED`, one row per currency.',
  })
  totals: RevenueFiguresDto[];

  @ApiProperty({ type: [RevenueCategoryRowDto] })
  byCategory: RevenueCategoryRowDto[];

  @ApiProperty({ type: [RevenueOperatorRowDto] })
  byOperator: RevenueOperatorRowDto[];

  @ApiProperty({
    description:
      'Bookings confirmed in the period and cancelled since: not in the figures.',
  })
  cancelledAfterConfirmation: number;
}

// --- Payments -----------------------------------------------------------------

export class PaymentStatusCountDto {
  @ApiProperty({ enum: PaymentStatus, enumName: 'PaymentStatus' })
  status: PaymentStatus;

  @ApiProperty()
  count: number;
}

export class PaymentMethodRowDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description: 'As the gateway reports it (`card`, `upi`, …); null if none.',
  })
  method: string | null;

  @ApiProperty()
  succeeded: number;

  @ApiProperty()
  failed: number;
}

export class PaymentFlagCountDto {
  @ApiProperty({ enum: PaymentReviewReason, enumName: 'PaymentReviewReason' })
  reason: PaymentReviewReason;

  @ApiProperty()
  count: number;
}

export class RefundStatusCountDto {
  @ApiProperty({ enum: RefundStatus, enumName: 'RefundStatus' })
  status: RefundStatus;

  @ApiProperty()
  count: number;
}

export class CurrencyRateDto {
  @ApiProperty({ example: 'INR' })
  currency: string;

  @ApiProperty({ type: Number, nullable: true, description: RATE })
  rate: number | null;
}

export class RefundFiguresDto {
  @ApiProperty({ description: 'Refunds started in the period.' })
  count: number;

  @ApiProperty({ type: [RefundStatusCountDto] })
  byStatus: RefundStatusCountDto[];

  @ApiProperty({ type: [MoneyTotalDto], description: '`COMPLETED`.' })
  refunded: MoneyTotalDto[];

  @ApiProperty({
    type: [MoneyTotalDto],
    description: '`REQUESTED` or `PENDING`.',
  })
  inProgress: MoneyTotalDto[];

  @ApiProperty({
    type: [CurrencyRateDto],
    description:
      'Completed refunds started in the period, per amount collected on payments started in the period.',
  })
  refundRate: CurrencyRateDto[];
}

export class PaymentReportDto {
  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ description: 'Payment attempts started in the period.' })
  attempts: number;

  @ApiProperty({ type: [PaymentStatusCountDto] })
  byStatus: PaymentStatusCountDto[];

  @ApiProperty({
    description:
      'Attempts whose money arrived (`SUCCEEDED`, `REFUND_PENDING`, `PARTIALLY_REFUNDED`, `REFUNDED`).',
  })
  succeeded: number;

  @ApiProperty()
  failed: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: `Succeeded per finished attempt (succeeded or failed). ${RATE}`,
  })
  successRate: number | null;

  @ApiProperty({
    type: [MoneyTotalDto],
    description: 'The amount of the succeeded attempts.',
  })
  collected: MoneyTotalDto[];

  @ApiProperty({ type: [PaymentMethodRowDto] })
  byMethod: PaymentMethodRowDto[];

  @ApiProperty({
    type: [PaymentFlagCountDto],
    description: 'Attempts flagged for operations to look at.',
  })
  flagged: PaymentFlagCountDto[];

  @ApiProperty({ type: RefundFiguresDto })
  refunds: RefundFiguresDto;
}

// --- Operators ----------------------------------------------------------------

export class OperatorStatusCountDto {
  @ApiProperty({ enum: OperatorStatus, enumName: 'OperatorStatus' })
  status: OperatorStatus;

  @ApiProperty()
  count: number;
}

export class OperatorPerformanceRowDto {
  @ApiProperty({ format: 'uuid' })
  operatorId: string;

  @ApiProperty({ description: 'Trading name, else legal name.' })
  operatorName: string;

  @ApiProperty({ enum: OperatorStatus, enumName: 'OperatorStatus' })
  status: OperatorStatus;

  @ApiProperty({ description: 'Booking requests made to it in the period.' })
  requests: number;

  @ApiProperty({
    description: 'Requests its staff answered (accepted, rejected or quoted).',
  })
  responded: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: `Responded per request. ${RATE}`,
  })
  responseRate: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Whole minutes from the request to its first answer.',
  })
  averageResponseMinutes: number | null;

  @ApiProperty({
    description:
      '`OPERATOR_UNAVAILABLE`: the aircraft could not fly although the calendar offered it.',
  })
  declined: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: `Declined per request, a measure of availability accuracy (lower is better). ${RATE}`,
  })
  declineRate: number | null;

  @ApiProperty()
  expired: number;

  @ApiProperty({ description: '`CONFIRMED`, `SCHEDULED` or `COMPLETED`.' })
  confirmed: number;

  @ApiProperty()
  cancelled: number;
}

export class OperatorReportDto {
  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ type: ReportFiltersDto })
  filters: ReportFiltersDto;

  @ApiProperty({
    type: [OperatorStatusCountDto],
    description: 'Every operator, by status now.',
  })
  byStatus: OperatorStatusCountDto[];

  @ApiProperty({
    type: [OperatorPerformanceRowDto],
    description: 'Operators with requests in the period, most requests first.',
  })
  operators: OperatorPerformanceRowDto[];
}

// --- Empty legs ---------------------------------------------------------------

export class EmptyLegStatusCountDto {
  @ApiProperty({ enum: EmptyLegStatus, enumName: 'EmptyLegStatus' })
  status: EmptyLegStatus;

  @ApiProperty()
  count: number;
}

export class EmptyLegReportDto {
  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ type: ReportFiltersDto })
  filters: ReportFiltersDto;

  @ApiProperty({ description: 'Offers created in the period.' })
  created: number;

  @ApiProperty({
    type: [EmptyLegStatusCountDto],
    description: 'Those offers by status now.',
  })
  byStatus: EmptyLegStatusCountDto[];

  @ApiProperty({ description: 'Those offers that were ever published.' })
  published: number;

  @ApiProperty()
  booked: number;

  @ApiProperty()
  withdrawn: number;

  @ApiProperty()
  expired: number;

  @ApiProperty({ description: 'Customers following those offers.' })
  interests: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: `Booked per published offer. ${RATE}`,
  })
  bookingRate: number | null;
}

// --- Air ambulance ------------------------------------------------------------

export class AirAmbulanceStatusCountDto {
  @ApiProperty({ enum: AirAmbulanceStatus, enumName: 'AirAmbulanceStatus' })
  status: AirAmbulanceStatus;

  @ApiProperty()
  count: number;
}

/** Counts and timings only: never patient, medical or contact data (rule 8). */
export class AirAmbulanceReportDto {
  @ApiProperty({ type: ReportPeriodDto })
  period: ReportPeriodDto;

  @ApiProperty({ description: 'Requests made in the period.' })
  requests: number;

  @ApiProperty({
    type: [AirAmbulanceStatusCountDto],
    description: 'Those requests by status now.',
  })
  byStatus: AirAmbulanceStatusCountDto[];

  @ApiProperty({ description: 'Not yet completed, declined or cancelled.' })
  open: number;

  @ApiProperty({ description: 'Those that were sent a quotation.' })
  quoted: number;

  @ApiProperty({ description: 'Those that were confirmed by operations.' })
  confirmed: number;

  @ApiProperty()
  completed: number;

  @ApiProperty()
  declined: number;

  @ApiProperty()
  cancelled: number;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Whole minutes from the request to its quotation.',
  })
  averageMinutesToQuote: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: 'Whole minutes from the request to its confirmation.',
  })
  averageMinutesToConfirm: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    description: `Completed per closed request (completed, declined or cancelled). ${RATE}`,
  })
  fulfilmentRate: number | null;
}
