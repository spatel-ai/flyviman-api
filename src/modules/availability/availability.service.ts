import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import type {
  AvailabilityBlock,
  AvailabilitySlot,
} from '../../generated/prisma/client.js';
import {
  AvailabilityBlockReason,
  AvailabilitySlotKind,
  OperatorStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AircraftService } from '../aircraft/aircraft.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { assertCan } from '../operators/operator-access.js';
import { LocationsService } from '../locations/locations.service.js';
import { OperatorsService } from '../operators/operators.service.js';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Longest calendar read. Keeps one request from scanning years of rows. */
export const MAX_CALENDAR_DAYS = 93;
/** Longest fleet timeline read: six weeks, what a month view shows. */
export const MAX_FLEET_DAYS = 42;
/** Most slots, and most blocks, one fleet read returns. */
export const MAX_FLEET_ROWS = 2000;
/** Longest single slot or block. */
export const MAX_ENTRY_DAYS = 180;
/** A soft hold must lapse within this many days of being placed. */
export const MAX_SOFT_HOLD_DAYS = 30;
/** Current and future slots plus blocks one aircraft may carry. */
export const MAX_ENTRIES_PER_AIRCRAFT = 1000;
/** Most conflict pairs returned at once. */
const MAX_CONFLICTS = 200;

function notFound(what = 'Availability'): AppException {
  return new AppException(
    'NOT_FOUND',
    `${what} not found.`,
    HttpStatus.NOT_FOUND,
  );
}

function invalid(field: string, issue: string, message: string): AppException {
  return new AppException('VALIDATION_ERROR', message, HttpStatus.BAD_REQUEST, [
    { field, issue },
  ]);
}

/** New or moved entries are for time still to come; past rows are history. */
function notOver(endsAt: Date): void {
  if (endsAt.getTime() <= Date.now()) {
    throw invalid(
      'endsAt',
      'must be in the future',
      'This time has already passed.',
    );
  }
}

function range(
  startsAt: Date,
  endsAt: Date,
  maxDays: number,
  fields: [string, string] = ['startsAt', 'endsAt'],
): void {
  if (endsAt <= startsAt) {
    throw invalid(
      fields[1],
      `must be after ${fields[0]}`,
      'The end must be after the start.',
    );
  }
  if (endsAt.getTime() - startsAt.getTime() > maxDays * DAY_MS) {
    throw invalid(
      fields[1],
      `must be within ${maxDays} days of ${fields[0]}`,
      `A range can cover at most ${maxDays} days.`,
    );
  }
}

/** What an audit record keeps of a slot or block: times and kind, no notes. */
function slotValues(row: AvailabilitySlot) {
  return {
    aircraftId: row.aircraftId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    kind: row.kind,
    originId: row.originId,
  };
}

function blockValues(row: AvailabilityBlock) {
  return {
    aircraftId: row.aircraftId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    reason: row.reason,
    expiresAt: row.expiresAt?.toISOString() ?? null,
  };
}

@Injectable()
export class AvailabilityService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operators: OperatorsService,
    private readonly aircraft: AircraftService,
    private readonly locations: LocationsService,
    private readonly audit: AuditService,
  ) {}

  /**
   * An aircraft in the caller's reach, for someone who may manage its
   * availability (operator administrators, and staff with "manage
   * availability" on it, D-049). Offering time (slots, soft holds) needs an
   * approved operator; reading, grounding and removing do not, so a
   * suspended operator can still take an aircraft out of service (D-058).
   */
  private async ownedAircraft(
    user: AuthUser,
    aircraftId: string,
    offersTime = false,
    grounds = false,
  ) {
    const { operator, access } = await this.operators.accessFor(user);
    const aircraft = await this.aircraft.inReach(access, aircraftId);
    // Grounding (a maintenance, blackout or other block) is a safety action
    // that either capability may take, like the availability status (D-071).
    if (grounds) assertCan(access, 'MANAGE_AVAILABILITY', 'MANAGE_AIRCRAFT');
    else assertCan(access, 'MANAGE_AVAILABILITY');
    if (offersTime && operator.status !== OperatorStatus.APPROVED) {
      throw new AppException(
        'OPERATOR_NOT_APPROVED',
        'Only an approved operator can offer availability.',
        HttpStatus.CONFLICT,
      );
    }
    return { operator, aircraft };
  }

  private async assertOrigin(originId: string | null | undefined) {
    if (!originId) return;
    if (!(await this.locations.isActive(originId))) {
      throw invalid(
        'originId',
        'must be an active location',
        'Origin not found or inactive.',
      );
    }
  }

  private async assertRoom(aircraftId: string): Promise<void> {
    const now = new Date();
    const [slots, blocks] = await this.prisma.$transaction([
      this.prisma.availabilitySlot.count({
        where: { aircraftId, endsAt: { gt: now } },
      }),
      this.prisma.availabilityBlock.count({
        where: { aircraftId, endsAt: { gt: now } },
      }),
    ]);
    if (slots + blocks >= MAX_ENTRIES_PER_AIRCRAFT) {
      throw new AppException(
        'AVAILABILITY_LIMIT_REACHED',
        `An aircraft can carry up to ${MAX_ENTRIES_PER_AIRCRAFT} current slots and blocks.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
  }

  async calendar(user: AuthUser, aircraftId: string, from: Date, to: Date) {
    range(from, to, MAX_CALENDAR_DAYS, ['from', 'to']);
    await this.ownedAircraft(user, aircraftId);
    const where = {
      aircraftId,
      startsAt: { lt: to },
      endsAt: { gt: from },
    };
    const [slots, blocks] = await this.prisma.$transaction([
      this.prisma.availabilitySlot.findMany({
        where,
        orderBy: { startsAt: 'asc' },
        take: MAX_ENTRIES_PER_AIRCRAFT,
      }),
      this.prisma.availabilityBlock.findMany({
        where,
        orderBy: { startsAt: 'asc' },
        take: MAX_ENTRIES_PER_AIRCRAFT,
      }),
    ]);
    return { slots, blocks };
  }

  /**
   * Every aircraft of the caller's operator with the slots and blocks that
   * overlap the range, for the fleet timeline. Open to an operator who is not
   * approved, like the per-aircraft read. Capped, with `truncated` set.
   */
  async fleetCalendar(user: AuthUser, from: Date, to: Date) {
    range(from, to, MAX_FLEET_DAYS, ['from', 'to']);
    const { access } = await this.operators.accessFor(user);
    assertCan(access, 'MANAGE_AVAILABILITY');
    // Staff see only the aircraft assigned to them.
    const aircraft = await this.aircraft.fleetFor(access);
    if (aircraft.length === 0) {
      return { aircraft, slots: [], blocks: [], truncated: false };
    }
    const where = {
      aircraftId: { in: aircraft.map((row) => row.id) },
      startsAt: { lt: to },
      endsAt: { gt: from },
    };
    const [slots, blocks] = await this.prisma.$transaction([
      this.prisma.availabilitySlot.findMany({
        where,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: MAX_FLEET_ROWS + 1,
      }),
      this.prisma.availabilityBlock.findMany({
        where,
        orderBy: [{ startsAt: 'asc' }, { id: 'asc' }],
        take: MAX_FLEET_ROWS + 1,
      }),
    ]);
    const truncated =
      slots.length > MAX_FLEET_ROWS || blocks.length > MAX_FLEET_ROWS;
    return {
      aircraft,
      slots: slots.slice(0, MAX_FLEET_ROWS),
      blocks: blocks.slice(0, MAX_FLEET_ROWS),
      truncated,
    };
  }

  async addSlot(
    user: AuthUser,
    aircraftId: string,
    input: {
      startsAt: Date;
      endsAt: Date;
      kind: AvailabilitySlotKind;
      originId?: string | null;
    },
  ): Promise<AvailabilitySlot> {
    range(input.startsAt, input.endsAt, MAX_ENTRY_DAYS);
    notOver(input.endsAt);
    const { aircraft } = await this.ownedAircraft(user, aircraftId, true);
    await this.assertOrigin(input.originId);
    await this.assertRoom(aircraft.id);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.availabilitySlot.create({
        data: {
          aircraftId: aircraft.id,
          startsAt: input.startsAt,
          endsAt: input.endsAt,
          kind: input.kind,
          originId: input.originId ?? null,
        },
      });
      await this.audit.record(
        {
          action: 'availability.slot.add',
          entityType: 'AvailabilitySlot',
          entityId: row.id,
          after: slotValues(row),
        },
        tx,
      );
      return row;
    });
  }

  async updateSlot(
    user: AuthUser,
    aircraftId: string,
    slotId: string,
    input: {
      startsAt?: Date;
      endsAt?: Date;
      kind?: AvailabilitySlotKind;
      originId?: string | null;
    },
  ): Promise<AvailabilitySlot> {
    const { aircraft } = await this.ownedAircraft(user, aircraftId, true);
    const slot = await this.prisma.availabilitySlot.findFirst({
      where: { id: slotId, aircraftId: aircraft.id },
    });
    if (!slot) throw notFound('Slot');
    const startsAt = input.startsAt ?? slot.startsAt;
    const endsAt = input.endsAt ?? slot.endsAt;
    range(startsAt, endsAt, MAX_ENTRY_DAYS);
    notOver(endsAt);
    if (input.originId !== undefined) await this.assertOrigin(input.originId);
    return this.prisma.$transaction(async (tx) => {
      const row = await tx.availabilitySlot.update({
        where: { id: slot.id },
        data: {
          startsAt,
          endsAt,
          ...(input.kind ? { kind: input.kind } : {}),
          ...(input.originId !== undefined ? { originId: input.originId } : {}),
        },
      });
      await this.audit.record(
        {
          action: 'availability.slot.update',
          entityType: 'AvailabilitySlot',
          entityId: row.id,
          before: slotValues(slot),
          after: slotValues(row),
        },
        tx,
      );
      return row;
    });
  }

  async removeSlot(
    user: AuthUser,
    aircraftId: string,
    slotId: string,
  ): Promise<void> {
    const { aircraft } = await this.ownedAircraft(user, aircraftId);
    const slot = await this.prisma.availabilitySlot.findFirst({
      where: { id: slotId, aircraftId: aircraft.id },
    });
    if (!slot) throw notFound('Slot');
    await this.prisma.$transaction(async (tx) => {
      await tx.availabilitySlot.delete({ where: { id: slot.id } });
      await this.audit.record(
        {
          action: 'availability.slot.remove',
          entityType: 'AvailabilitySlot',
          entityId: slot.id,
          before: slotValues(slot),
        },
        tx,
      );
    });
  }

  async addBlock(
    user: AuthUser,
    aircraftId: string,
    input: {
      startsAt: Date;
      endsAt: Date;
      reason: AvailabilityBlockReason;
      expiresAt?: Date;
      note?: string;
    },
  ): Promise<AvailabilityBlock> {
    range(input.startsAt, input.endsAt, MAX_ENTRY_DAYS);
    notOver(input.endsAt);
    if (input.reason === AvailabilityBlockReason.BOOKING) {
      throw invalid(
        'reason',
        'cannot be BOOKING',
        'Booking holds are created by bookings.',
      );
    }
    const softHold = input.reason === AvailabilityBlockReason.SOFT_HOLD;
    if (softHold) {
      const now = Date.now();
      if (!input.expiresAt) {
        throw invalid(
          'expiresAt',
          'is required for a soft hold',
          'A soft hold needs an expiry time.',
        );
      }
      const lapses = input.expiresAt.getTime();
      if (lapses > input.endsAt.getTime()) {
        throw invalid(
          'expiresAt',
          'must not be after endsAt',
          'A soft hold must lapse before the time it holds is over.',
        );
      }
      if (lapses <= now || lapses > now + MAX_SOFT_HOLD_DAYS * DAY_MS) {
        throw invalid(
          'expiresAt',
          `must be in the next ${MAX_SOFT_HOLD_DAYS} days`,
          `A soft hold must lapse within the next ${MAX_SOFT_HOLD_DAYS} days.`,
        );
      }
    } else if (input.expiresAt) {
      throw invalid(
        'expiresAt',
        'is only for a soft hold',
        'Only a soft hold has an expiry time.',
      );
    }
    // A soft hold offers time to a customer; a maintenance or blackout block
    // grounds the aircraft and stays open to an operator who is not approved.
    const { aircraft } = await this.ownedAircraft(
      user,
      aircraftId,
      softHold,
      !softHold,
    );
    await this.assertRoom(aircraft.id);
    try {
      return await this.prisma.$transaction(async (tx) => {
        const row = await tx.availabilityBlock.create({
          data: {
            aircraftId: aircraft.id,
            startsAt: input.startsAt,
            endsAt: input.endsAt,
            reason: input.reason,
            expiresAt: input.expiresAt ?? null,
            note: input.note ?? null,
          },
        });
        await this.audit.record(
          {
            action: 'availability.block.add',
            entityType: 'AvailabilityBlock',
            entityId: row.id,
            after: blockValues(row),
          },
          tx,
        );
        return row;
      });
    } catch (error) {
      throw this.conflictOr(error);
    }
  }

  async removeBlock(
    user: AuthUser,
    aircraftId: string,
    blockId: string,
  ): Promise<void> {
    // Grounding blocks may be lifted with either capability; a soft hold
    // only with "manage availability" (D-071).
    const { aircraft } = await this.ownedAircraft(
      user,
      aircraftId,
      false,
      true,
    );
    const block = await this.prisma.availabilityBlock.findFirst({
      where: { id: blockId, aircraftId: aircraft.id },
    });
    if (!block) throw notFound('Block');
    if (block.reason === AvailabilityBlockReason.SOFT_HOLD) {
      await this.ownedAircraft(user, aircraftId);
    }
    if (block.reason === AvailabilityBlockReason.BOOKING) {
      throw new AppException(
        'AVAILABILITY_CONFLICT',
        'A booking hold is removed when the booking changes.',
        HttpStatus.CONFLICT,
      );
    }
    await this.prisma.$transaction(async (tx) => {
      // Conditional, so a block that became a booking hold is never removed.
      const { count } = await tx.availabilityBlock.deleteMany({
        where: {
          id: block.id,
          reason: { not: AvailabilityBlockReason.BOOKING },
        },
      });
      if (count !== 1) throw notFound('Block');
      await this.audit.record(
        {
          action: 'availability.block.remove',
          entityType: 'AvailabilityBlock',
          entityId: block.id,
          before: blockValues(block),
        },
        tx,
      );
    });
  }

  /**
   * Pairs of current soft holds that overlap on the same aircraft of this
   * operator. Lapsed holds and holds that have ended are left out. Computed
   * in the database and capped, so a large calendar cannot stall the API.
   */
  async conflicts(user: AuthUser) {
    const { access } = await this.operators.accessFor(user);
    assertCan(access, 'MANAGE_AVAILABILITY');
    const aircraftIds = await this.aircraft.idsFor(access);
    if (aircraftIds.length === 0) return [];
    const pairs = await this.prisma.$queryRaw<
      { holdId: string; overlapsId: string }[]
    >`
      SELECT a.id AS "holdId", b.id AS "overlapsId"
      FROM "AvailabilityBlock" a
      JOIN "AvailabilityBlock" b
        ON b."aircraftId" = a."aircraftId"
       AND (a."startsAt", a.id) < (b."startsAt", b.id)
       AND a."startsAt" < b."endsAt"
       AND b."startsAt" < a."endsAt"
      WHERE a."aircraftId" = ANY(${aircraftIds}::uuid[])
        AND a.reason = 'SOFT_HOLD' AND b.reason = 'SOFT_HOLD'
        AND a."expiresAt" > now() AND b."expiresAt" > now()
        AND a."endsAt" > now() AND b."endsAt" > now()
      ORDER BY a."startsAt", a.id, b."startsAt", b.id
      LIMIT ${MAX_CONFLICTS}
    `;
    if (pairs.length === 0) return [];
    const ids = [...new Set(pairs.flatMap((p) => [p.holdId, p.overlapsId]))];
    const rows = await this.prisma.availabilityBlock.findMany({
      where: { id: { in: ids } },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return pairs.flatMap((pair) => {
      const hold = byId.get(pair.holdId);
      const overlaps = byId.get(pair.overlapsId);
      return hold && overlaps ? [{ hold, overlaps }] : [];
    });
  }

  /**
   * Offered time and blocks of many aircraft over a period, in two queries,
   * for search and the fare calendar (M5). Expired soft holds are left out.
   */
  async windowsFor(
    aircraftIds: string[],
    from: Date,
    to: Date,
  ): Promise<
    Map<
      string,
      {
        slots: {
          startsAt: Date;
          endsAt: Date;
          kind: AvailabilitySlotKind;
          originId: string | null;
        }[];
        blocks: { startsAt: Date; endsAt: Date }[];
      }
    >
  > {
    const now = new Date();
    const [slots, blocks] = await Promise.all([
      this.prisma.availabilitySlot.findMany({
        where: {
          aircraftId: { in: aircraftIds },
          startsAt: { lt: to },
          endsAt: { gt: from },
        },
        select: {
          aircraftId: true,
          startsAt: true,
          endsAt: true,
          kind: true,
          originId: true,
        },
      }),
      this.prisma.availabilityBlock.findMany({
        where: {
          aircraftId: { in: aircraftIds },
          startsAt: { lt: to },
          endsAt: { gt: from },
          OR: [
            { reason: { not: AvailabilityBlockReason.SOFT_HOLD } },
            { expiresAt: null },
            { expiresAt: { gt: now } },
          ],
        },
        select: { aircraftId: true, startsAt: true, endsAt: true },
      }),
    ]);
    const windows = new Map(
      aircraftIds.map((id) => [
        id,
        {
          slots: [] as {
            startsAt: Date;
            endsAt: Date;
            kind: AvailabilitySlotKind;
            originId: string | null;
          }[],
          blocks: [] as { startsAt: Date; endsAt: Date }[],
        },
      ]),
    );
    for (const { aircraftId, ...slot } of slots)
      windows.get(aircraftId)?.slots.push(slot);
    for (const { aircraftId, ...block } of blocks)
      windows.get(aircraftId)?.blocks.push(block);
    return windows;
  }

  /** Used by tests and, later, by bookings. The database constraint is the backstop. */
  async assertNoBookingOverlap(
    aircraftId: string,
    startsAt: Date,
    endsAt: Date,
    exceptId?: string,
  ): Promise<void> {
    const clash = await this.prisma.availabilityBlock.findFirst({
      where: {
        aircraftId,
        reason: AvailabilityBlockReason.BOOKING,
        ...(exceptId ? { id: { not: exceptId } } : {}),
        startsAt: { lt: endsAt },
        endsAt: { gt: startsAt },
      },
      select: { id: true },
    });
    if (clash) {
      throw new AppException(
        'AVAILABILITY_CONFLICT',
        'This aircraft already has a confirmed hold in that time.',
        HttpStatus.CONFLICT,
      );
    }
  }

  /** Maps the booking exclusion constraint (SQLSTATE 23P01) to a 409. */
  private conflictOr(error: unknown): unknown {
    const text =
      error instanceof Prisma.PrismaClientKnownRequestError ||
      error instanceof Error
        ? `${error.message} ${JSON.stringify((error as { meta?: unknown }).meta ?? {})}`
        : '';
    if (
      text.includes('23P01') ||
      text.includes('AvailabilityBlock_booking_no_overlap')
    ) {
      return new AppException(
        'AVAILABILITY_CONFLICT',
        'This aircraft already has a confirmed hold in that time.',
        HttpStatus.CONFLICT,
      );
    }
    return error;
  }
}
