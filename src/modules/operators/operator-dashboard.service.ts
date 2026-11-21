import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  AircraftListingStatus,
  BookingStatus,
  DocumentVerificationStatus,
  EmptyLegStatus,
  QuoteStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { parseItinerary } from '../bookings/booking-json.js';
import type {
  DashboardEmptyLegsDto,
  DashboardFleetDto,
  DashboardQuotesDto,
  DashboardRequestsDto,
  DashboardTripsDto,
  OperatorDashboardResponseDto,
} from './dto/operator-dashboard.dto.js';
import { aircraftWhere, can, type OperatorAccess } from './operator-access.js';
import { OperatorsService } from './operators.service.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
/** Confirmed bookings read to find the next trips; a busy fleet has fewer. */
const TRIP_SCAN = 200;

/**
 * The operator portal's dashboard: counts only, each section limited to the
 * capability that opens its list and to the aircraft in the caller's reach
 * (D-049). Read-only, so a suspended operator still sees it.
 */
@Injectable()
export class OperatorDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
  ) {}

  async dashboard(user: AuthUser): Promise<OperatorDashboardResponseDto> {
    const { operator, access } = await this.operators.accessFor(user);
    const now = new Date();
    const bookings = can(access, 'MANAGE_BOOKINGS');
    const fleet = can(access, 'MANAGE_AIRCRAFT', 'MANAGE_AVAILABILITY');
    const legs = can(access, 'MANAGE_EMPTY_LEGS');
    const [requests, quotes, trips, fleetCounts, emptyLegs] = await Promise.all(
      [
        bookings ? this.requests(access) : null,
        bookings ? this.quotes(access, now) : null,
        bookings ? this.trips(access, now) : null,
        fleet ? this.fleet(access, now) : null,
        legs ? this.emptyLegs(access, now) : null,
      ],
    );
    return {
      status: operator.status,
      requests,
      quotes,
      trips,
      fleet: fleetCounts,
      emptyLegs,
    };
  }

  private bookingScope(access: OperatorAccess): Prisma.BookingWhereInput {
    return {
      operatorId: access.operatorId,
      aircraft: aircraftWhere(access),
    };
  }

  private async requests(
    access: OperatorAccess,
  ): Promise<DashboardRequestsDto> {
    const open = await this.prisma.booking.count({
      where: {
        ...this.bookingScope(access),
        status: {
          in: [
            BookingStatus.OPERATOR_PENDING,
            BookingStatus.CLARIFICATION_REQUESTED,
          ],
        },
      },
    });
    return { open };
  }

  private async quotes(
    access: OperatorAccess,
    now: Date,
  ): Promise<DashboardQuotesDto> {
    const where: Prisma.QuoteWhereInput = {
      operatorId: access.operatorId,
      status: QuoteStatus.SENT,
      validUntil: { gt: now },
      booking: { is: { aircraft: aircraftWhere(access) } },
    };
    const [sent, expiringSoon] = await Promise.all([
      this.prisma.quote.count({ where }),
      this.prisma.quote.count({
        where: {
          ...where,
          validUntil: { gt: now, lte: new Date(now.getTime() + 48 * HOUR) },
        },
      }),
    ]);
    return { sent, expiringSoon };
  }

  private async trips(
    access: OperatorAccess,
    now: Date,
  ): Promise<DashboardTripsDto> {
    const rows = await this.prisma.booking.findMany({
      where: {
        ...this.bookingScope(access),
        status: { in: [BookingStatus.CONFIRMED, BookingStatus.SCHEDULED] },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: TRIP_SCAN,
      select: {
        reference: true,
        status: true,
        paymentStatus: true,
        itinerary: true,
      },
    });
    const until = now.getTime() + 14 * DAY;
    const upcoming = rows
      .map((row) => {
        const [first] = parseItinerary(row.itinerary).legs;
        return {
          reference: row.reference,
          status: row.status,
          paymentStatus: row.paymentStatus,
          originName: first.originName,
          destinationName: first.destinationName,
          departureAt: first.departureAt,
        };
      })
      .filter((trip) => {
        const at = Date.parse(trip.departureAt);
        return at >= now.getTime() && at <= until;
      })
      .sort((a, b) => Date.parse(a.departureAt) - Date.parse(b.departureAt));
    return { upcomingCount: upcoming.length, upcoming: upcoming.slice(0, 5) };
  }

  private async fleet(
    access: OperatorAccess,
    now: Date,
  ): Promise<DashboardFleetDto> {
    const aircraft = aircraftWhere(access);
    const notRejected = {
      aircraft,
      verificationStatus: { not: DocumentVerificationStatus.REJECTED },
    };
    const today = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const [
      approved,
      pendingReview,
      total,
      documentsPending,
      expiring,
      expired,
    ] = await Promise.all([
      this.prisma.aircraft.count({
        where: { ...aircraft, listingStatus: AircraftListingStatus.APPROVED },
      }),
      this.prisma.aircraft.count({
        where: {
          ...aircraft,
          listingStatus: AircraftListingStatus.PENDING_REVIEW,
        },
      }),
      this.prisma.aircraft.count({ where: aircraft }),
      this.prisma.aircraftDocument.count({
        where: {
          aircraft,
          verificationStatus: DocumentVerificationStatus.PENDING,
        },
      }),
      this.prisma.aircraftDocument.count({
        where: {
          ...notRejected,
          expiresAt: {
            gte: today,
            lte: new Date(today.getTime() + 30 * DAY),
          },
        },
      }),
      this.prisma.aircraftDocument.count({
        where: { ...notRejected, expiresAt: { lt: today } },
      }),
    ]);
    return {
      approved,
      pendingReview,
      other: total - approved - pendingReview,
      documentsPending,
      documentsExpiring: expiring,
      documentsExpired: expired,
    };
  }

  private async emptyLegs(
    access: OperatorAccess,
    now: Date,
  ): Promise<DashboardEmptyLegsDto> {
    const where: Prisma.EmptyLegWhereInput = {
      operatorId: access.operatorId,
      aircraft: aircraftWhere(access),
      status: EmptyLegStatus.PUBLISHED,
      expiresAt: { gt: now },
    };
    const [live, expiringSoon] = await Promise.all([
      this.prisma.emptyLeg.count({ where }),
      this.prisma.emptyLeg.count({
        where: {
          ...where,
          expiresAt: { gt: now, lte: new Date(now.getTime() + 48 * HOUR) },
        },
      }),
    ]);
    return { live, expiringSoon };
  }
}
