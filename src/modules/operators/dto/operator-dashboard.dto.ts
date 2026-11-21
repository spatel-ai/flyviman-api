import { ApiProperty } from '@nestjs/swagger';
import {
  BookingPaymentStatus,
  BookingStatus,
  OperatorStatus,
} from '../../../generated/prisma/enums.js';

export class DashboardRequestsDto {
  @ApiProperty({
    description:
      'Booking requests waiting in the inbox (`OPERATOR_PENDING`, `CLARIFICATION_REQUESTED`).',
  })
  open: number;
}

export class DashboardQuotesDto {
  @ApiProperty({ description: 'Quotes sent and not yet answered or expired.' })
  sent: number;

  @ApiProperty({ description: 'Of those, valid for less than 48 hours more.' })
  expiringSoon: number;
}

export class DashboardTripDto {
  @ApiProperty() reference: string;
  @ApiProperty({ enum: BookingStatus, enumName: 'BookingStatus' })
  status: BookingStatus;
  @ApiProperty({
    enum: BookingPaymentStatus,
    enumName: 'BookingPaymentStatus',
  })
  paymentStatus: BookingPaymentStatus;
  @ApiProperty() originName: string;
  @ApiProperty() destinationName: string;
  @ApiProperty({ description: 'ISO 8601 UTC.' }) departureAt: string;
}

export class DashboardTripsDto {
  @ApiProperty({
    description: 'Confirmed trips departing in the next 14 days.',
  })
  upcomingCount: number;

  @ApiProperty({
    type: [DashboardTripDto],
    description: 'The next five, soonest first. No passenger data.',
  })
  upcoming: DashboardTripDto[];
}

export class DashboardFleetDto {
  @ApiProperty() approved: number;
  @ApiProperty() pendingReview: number;
  @ApiProperty({ description: 'Draft, rejected or suspended listings.' })
  other: number;
  @ApiProperty({ description: 'Aircraft documents waiting for verification.' })
  documentsPending: number;
  @ApiProperty({
    description: 'Aircraft documents (not rejected) expiring within 30 days.',
  })
  documentsExpiring: number;
  @ApiProperty({
    description: 'Aircraft documents (not rejected) past expiry.',
  })
  documentsExpired: number;
}

export class DashboardEmptyLegsDto {
  @ApiProperty({ description: 'Published and not yet expired.' })
  live: number;

  @ApiProperty({ description: 'Of those, expiring within 48 hours.' })
  expiringSoon: number;
}

/**
 * Each section is `null` when the caller's capabilities do not cover it
 * (staff see only what they may open); counts cover the aircraft in reach.
 */
export class OperatorDashboardResponseDto {
  @ApiProperty({ enum: OperatorStatus, enumName: 'OperatorStatus' })
  status: OperatorStatus;

  @ApiProperty({ type: DashboardRequestsDto, nullable: true })
  requests: DashboardRequestsDto | null;

  @ApiProperty({ type: DashboardQuotesDto, nullable: true })
  quotes: DashboardQuotesDto | null;

  @ApiProperty({ type: DashboardTripsDto, nullable: true })
  trips: DashboardTripsDto | null;

  @ApiProperty({ type: DashboardFleetDto, nullable: true })
  fleet: DashboardFleetDto | null;

  @ApiProperty({ type: DashboardEmptyLegsDto, nullable: true })
  emptyLegs: DashboardEmptyLegsDto | null;
}
