import { HttpStatus, Injectable } from '@nestjs/common';
import { Paginated } from '../../common/dto/paginated.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  ChangeRequestStatus,
  OperatorStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { aircraftWhere, assertCan } from '../operators/operator-access.js';
import { OperatorsService } from '../operators/operators.service.js';
import { changeRequestView, decisionNotes } from './change-requests.js';
import type { ChangeRequestQueryDto } from './dto/admin-booking.dto.js';
import type { ChangeRequestResponseDto } from './dto/booking.dto.js';

/**
 * Lists of customers' change and cancellation requests (M8), by default
 * those waiting for an answer, newest first: every booking's for
 * operations, the operator's own bookings (aircraft in reach, staff with
 * `MANAGE_BOOKINGS`) for the operator. Answers go through
 * `TripsService.decide`.
 */
@Injectable()
export class ChangeRequestListsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
  ) {}

  async forOperations(
    query: ChangeRequestQueryDto,
  ): Promise<Paginated<ChangeRequestResponseDto>> {
    return this.list({}, query);
  }

  async forOperator(
    user: AuthUser,
    query: ChangeRequestQueryDto,
  ): Promise<Paginated<ChangeRequestResponseDto>> {
    const { operator, access } = await this.operators.accessFor(user);
    assertCan(access, 'MANAGE_BOOKINGS');
    if (operator.status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can answer change requests.',
        HttpStatus.CONFLICT,
      );
    }
    return this.list(
      { operatorId: access.operatorId, aircraft: aircraftWhere(access) },
      query,
    );
  }

  private async list(
    booking: Prisma.BookingWhereInput,
    query: ChangeRequestQueryDto,
  ): Promise<Paginated<ChangeRequestResponseDto>> {
    const where: Prisma.ChangeRequestWhereInput = {
      status: query.status ?? ChangeRequestStatus.REQUESTED,
      booking,
    };
    const [rows, total] = await Promise.all([
      this.prisma.changeRequest.findMany({
        where,
        include: { booking: { select: { reference: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.changeRequest.count({ where }),
    ]);
    // Decision notes live on each booking's timeline.
    const notes = new Map<string, string>();
    const decided = new Set(
      rows.filter((row) => row.decidedAt !== null).map((row) => row.bookingId),
    );
    for (const bookingId of decided) {
      for (const [id, note] of await decisionNotes(this.prisma, bookingId)) {
        notes.set(id, note);
      }
    }
    return new Paginated(
      rows.map((row) => changeRequestView(row, row.booking.reference, notes)),
      query.page,
      query.pageSize,
      total,
    );
  }
}
