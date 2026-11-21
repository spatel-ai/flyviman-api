import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Redis } from 'ioredis';
import { AppException } from '../../common/errors/app.exception.js';
import {
  type IdempotencyClaim,
  markIdempotencyCommitted,
} from '../../common/idempotency/idempotency.store.js';
import { minorToNumber } from '../../common/money.js';
import type { Prisma } from '../../generated/prisma/client.js';
import {
  BookingStatus,
  RefundStatus,
  SettlementStatus,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { REDIS } from '../../redis/redis.module.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { BookingsService } from '../bookings/bookings.service.js';
import {
  creditedMinor,
  MONEY_IN,
  netPaidMinor,
} from '../bookings/paid-amount.js';
import { OperatorsService } from '../operators/operators.service.js';
import { PricingService } from '../pricing/pricing.service.js';
import type {
  AdminSettlementDto,
  AdminSettlementsQueryDto,
  OperatorSettlementDto,
  UpdateSettlementDto,
} from './dto/settlement.dto.js';
import {
  canMoveSettlement,
  derivedSettlementStatus,
  type SettlementCalculation,
  type SettlementFigures,
  sameFigures,
  settlementFigures,
  unusableCalculation,
} from './settlement-rules.js';

const SYNC_LOCK_KEY = 'payments:settlements:lock';
const SYNC_LOCK_SECONDS = 5 * 60;
const SYNC_BATCH = 100;
const RELEASE_LOCK = `if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end`;

/** Refunds still on their way. */
const OPEN_REFUND: readonly RefundStatus[] = [
  RefundStatus.REQUESTED,
  RefundStatus.PENDING,
];

/** Records the system keeps up to date (never `PAID`). */
const OPEN_SETTLEMENT: SettlementStatus[] = [
  SettlementStatus.NOT_DUE,
  SettlementStatus.DUE,
  SettlementStatus.ON_HOLD,
];

/** What a booking's settlement is worked out from, read under its lock. */
export interface SettlementBasis {
  booking: {
    id: string;
    reference: string;
    status: BookingStatus;
    totalMinor: bigint;
    currency: string;
    operatorId: string | null;
  };
  keptMinor: bigint;
  /** Credited towards the booking (refunds not deducted) reached its total. */
  fullyPaid: boolean;
  refundOpen: boolean;
  calculation: SettlementCalculation | null;
  /** Why the calculation cannot price it, or null. */
  unusable: string | null;
}

const ADMIN_INCLUDE = {
  booking: { select: { reference: true, status: true } },
  operator: { select: { legalName: true, tradingName: true } },
} as const satisfies Prisma.SettlementInclude;

type AdminRow = Prisma.SettlementGetPayload<{
  include: typeof ADMIN_INCLUDE;
}>;

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Settlement not found.',
    HttpStatus.NOT_FOUND,
  );
}

function figuresOf(row: SettlementFigures): Record<string, number> {
  return {
    payableMinor: minorToNumber(row.payableMinor),
    commissionMinor: minorToNumber(row.commissionMinor),
    taxMinor: minorToNumber(row.taxMinor),
  };
}

/**
 * Operator settlements (M9, W4-2), recorded and paid by hand
 * (`SETTLEMENT_MODE=manual`, open decision 8). A job creates one record per
 * completed booking with money kept and keeps the figures and the
 * `DUE`/`NOT_DUE` status in step with payments and refunds
 * (`settlement-rules.ts`); finance holds, releases and marks records paid
 * with the payout's bank reference. Every write takes the booking's lock
 * first, as payments and refunds do, so a settlement is never worked out
 * from money that is moving, and every change is audited (rule 6).
 */
@Injectable()
export class SettlementsService {
  private readonly logger = new Logger(SettlementsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly bookings: BookingsService,
    private readonly pricing: PricingService,
    private readonly operators: OperatorsService,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  // --- The job ---------------------------------------------------------------

  /** Every five minutes. */
  @Cron('*/5 * * * *', { name: 'settlement-sync' })
  async scheduled(): Promise<void> {
    try {
      await this.runSync();
    } catch (error) {
      this.logger.error(
        `Settlement sync failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
  }

  /**
   * Creates the settlement of every completed booking with an operator and
   * money kept, and brings every open record (not `PAID`) in line with its
   * booking. One booking per transaction; one instance at a time (Redis
   * lock). A booking whose price calculation cannot price it gets no
   * record; the reconciliation report lists it.
   */
  async runSync(): Promise<{
    checked: number;
    written: number;
    skipped: boolean;
  }> {
    const token = randomUUID();
    const locked = await this.redis.set(
      SYNC_LOCK_KEY,
      token,
      'EX',
      SYNC_LOCK_SECONDS,
      'NX',
    );
    if (!locked) return { checked: 0, written: 0, skipped: true };
    let checked = 0;
    let written = 0;
    try {
      let after: string | undefined;
      for (;;) {
        const rows = await this.prisma.booking.findMany({
          where: {
            ...(after ? { id: { gt: after } } : {}),
            operatorId: { not: null },
            OR: [
              { status: BookingStatus.COMPLETED, settlement: null },
              { settlement: { status: { in: OPEN_SETTLEMENT } } },
            ],
          },
          select: { id: true },
          orderBy: { id: 'asc' },
          take: SYNC_BATCH,
        });
        for (const row of rows) {
          checked += 1;
          // One booking's failure never stops the others; its name only.
          try {
            const changed = await this.prisma.$transaction((tx) =>
              this.syncBooking(tx, row.id),
            );
            if (changed) written += 1;
          } catch (error) {
            this.logger.error(
              `Settlement sync failed for a booking: ${error instanceof Error ? error.name : 'unknown error'}`,
            );
          }
        }
        if (rows.length < SYNC_BATCH) break;
        after = rows[rows.length - 1].id;
      }
    } finally {
      await this.redis.eval(RELEASE_LOCK, 1, SYNC_LOCK_KEY, token);
    }
    return { checked, written, skipped: false };
  }

  /**
   * Locks the booking and reads what its settlement is worked out from: the
   * money kept towards it, whether a refund is on its way, and the price
   * calculation of the price it was booked at (the accepted quote's, else
   * its own).
   */
  async basis(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<SettlementBasis | null> {
    const locked = await this.bookings.forPayment({ id: bookingId }, tx);
    if (!locked) return null;
    const booking = await tx.booking.findUniqueOrThrow({
      where: { id: bookingId },
      select: {
        id: true,
        reference: true,
        status: true,
        totalMinor: true,
        currency: true,
        operatorId: true,
        calculationId: true,
        acceptedQuote: { select: { calculationId: true } },
      },
    });
    const payments = await tx.payment.findMany({
      where: { bookingId, status: { in: [...MONEY_IN] } },
      select: {
        status: true,
        reviewReason: true,
        amountMinor: true,
        refunds: { select: { status: true, amountMinor: true } },
      },
    });
    const calculationId =
      booking.acceptedQuote?.calculationId ?? booking.calculationId;
    const calculation = calculationId
      ? await this.pricing.calculation(calculationId)
      : null;
    return {
      booking: {
        id: booking.id,
        reference: booking.reference,
        status: booking.status,
        totalMinor: booking.totalMinor,
        currency: booking.currency,
        operatorId: booking.operatorId,
      },
      keptMinor: netPaidMinor(payments),
      fullyPaid: creditedMinor(payments) >= booking.totalMinor,
      refundOpen: payments.some((payment) =>
        payment.refunds.some((refund) => OPEN_REFUND.includes(refund.status)),
      ),
      calculation,
      unusable: unusableCalculation(calculation, booking.totalMinor),
    };
  }

  /**
   * Creates or updates one booking's settlement, inside the caller's
   * transaction. Returns whether anything was written. A `PAID` record is
   * never touched; an `ON_HOLD` one keeps its status (its figures follow).
   */
  async syncBooking(
    tx: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<boolean> {
    const basis = await this.basis(tx, bookingId);
    const operatorId = basis?.booking.operatorId;
    if (!basis || !operatorId || !basis.calculation || basis.unusable) {
      return false;
    }
    const { booking, keptMinor } = basis;
    const existing = await tx.settlement.findUnique({ where: { bookingId } });
    if (existing?.status === SettlementStatus.PAID) return false;
    const figures = settlementFigures(keptMinor, basis.calculation);
    const derived = derivedSettlementStatus({
      bookingStatus: booking.status,
      keptMinor,
      fullyPaid: basis.fullyPaid,
      refundOpen: basis.refundOpen,
      figures,
    });

    if (!existing) {
      if (booking.status !== BookingStatus.COMPLETED || keptMinor <= 0n) {
        return false;
      }
      const created = await tx.settlement.create({
        data: {
          bookingId,
          operatorId,
          ...figures,
          currency: booking.currency,
          status: derived,
        },
      });
      await this.audit.record(
        {
          action: 'settlement.create',
          entityType: 'Settlement',
          entityId: created.id,
          after: {
            bookingReference: booking.reference,
            ...figuresOf(figures),
            currency: created.currency,
            status: created.status,
            keptMinor: minorToNumber(keptMinor),
          },
          actor: null,
        },
        tx,
      );
      return true;
    }

    const status =
      existing.status === SettlementStatus.ON_HOLD
        ? SettlementStatus.ON_HOLD
        : derived;
    if (status === existing.status && sameFigures(existing, figures)) {
      return false;
    }
    await tx.settlement.update({
      where: { id: existing.id },
      data: { ...figures, status },
    });
    await this.audit.record(
      {
        action: 'settlement.update',
        entityType: 'Settlement',
        entityId: existing.id,
        before: {
          bookingReference: booking.reference,
          ...figuresOf(existing),
          status: existing.status,
        },
        after: {
          bookingReference: booking.reference,
          ...figuresOf(figures),
          status,
          keptMinor: minorToNumber(keptMinor),
          bookingStatus: booking.status,
          refundOpen: basis.refundOpen,
        },
        actor: null,
      },
      tx,
    );
    return true;
  }

  // --- Finance ---------------------------------------------------------------

  /** Settlements, newest first (`GET /admin/settlements`). */
  async adminList(
    query: AdminSettlementsQueryDto,
  ): Promise<{ items: AdminSettlementDto[]; total: number }> {
    const where: Prisma.SettlementWhereInput = { status: query.status };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        include: ADMIN_INCLUDE,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return { items: rows.map(toAdminDto), total };
  }

  /**
   * Finance's decision on a record (`PATCH /admin/settlements/:id`), under
   * the booking's lock:
   * - `ON_HOLD` from `NOT_DUE` or `DUE`;
   * - `DUE` from `ON_HOLD`, only when the booking is due now (409
   *   `SETTLEMENT_NOT_DUE`), with the figures brought up to date;
   * - `PAID` from `DUE`, with the payout's bank reference, only when the
   *   booking is still due and the figures, and the payable finance saw
   *   (`expectedPayableMinor`), are unchanged (409 `SETTLEMENT_CHANGED`).
   *   Marking it paid again with the same reference returns the record;
   *   another reference is 409 `SETTLEMENT_ALREADY_PAID`.
   * Any other move is 409 `SETTLEMENT_INVALID_TRANSITION`. Audited with the
   * reason.
   */
  async change(
    id: string,
    input: UpdateSettlementDto,
    claim: IdempotencyClaim,
  ): Promise<AdminSettlementDto> {
    const found = await this.prisma.settlement.findUnique({
      where: { id },
      select: { bookingId: true },
    });
    if (!found) throw notFound();
    const to = input.status;

    await this.prisma.$transaction(async (tx) => {
      await markIdempotencyCommitted(tx, claim);
      const basis = await this.basis(tx, found.bookingId);
      const row = await tx.settlement.findUniqueOrThrow({ where: { id } });

      if (
        row.status === SettlementStatus.PAID &&
        to === SettlementStatus.PAID
      ) {
        if (row.paymentReference === input.paymentReference) return;
        throw new AppException(
          'SETTLEMENT_ALREADY_PAID',
          'This settlement was already paid with another reference.',
          HttpStatus.CONFLICT,
        );
      }
      if (!canMoveSettlement(row.status, to)) {
        throw new AppException(
          'SETTLEMENT_INVALID_TRANSITION',
          `A ${row.status} settlement cannot become ${to}.`,
          HttpStatus.CONFLICT,
          [{ field: 'status', issue: row.status }],
        );
      }

      let figures: SettlementFigures = row;
      if (to === SettlementStatus.DUE || to === SettlementStatus.PAID) {
        const fresh =
          basis?.calculation && !basis.unusable
            ? settlementFigures(basis.keptMinor, basis.calculation)
            : null;
        const due =
          basis &&
          fresh &&
          derivedSettlementStatus({
            bookingStatus: basis.booking.status,
            keptMinor: basis.keptMinor,
            fullyPaid: basis.fullyPaid,
            refundOpen: basis.refundOpen,
            figures: fresh,
          }) === SettlementStatus.DUE;
        if (!basis || !fresh || !due) {
          throw new AppException(
            'SETTLEMENT_NOT_DUE',
            'This settlement is not due: the trip is not completed or not fully paid, a refund is on its way, or the money kept does not cover it.',
            HttpStatus.CONFLICT,
            basis
              ? [
                  { field: 'bookingStatus', issue: basis.booking.status },
                  { field: 'keptMinor', issue: String(basis.keptMinor) },
                  { field: 'fullyPaid', issue: String(basis.fullyPaid) },
                  { field: 'refundOpen', issue: String(basis.refundOpen) },
                ]
              : [],
          );
        }
        if (
          to === SettlementStatus.PAID &&
          (!sameFigures(fresh, row) ||
            BigInt(input.expectedPayableMinor ?? -1) !== row.payableMinor)
        ) {
          throw new AppException(
            'SETTLEMENT_CHANGED',
            'The amount payable has changed. Check it before marking it paid.',
            HttpStatus.CONFLICT,
            [{ field: 'payableMinor', issue: String(fresh.payableMinor) }],
          );
        }
        figures = fresh;
      }

      const paid = to === SettlementStatus.PAID;
      const updated = await tx.settlement.update({
        where: { id },
        data: {
          status: to,
          payableMinor: figures.payableMinor,
          commissionMinor: figures.commissionMinor,
          taxMinor: figures.taxMinor,
          ...(paid
            ? {
                paidAt: new Date(),
                paymentReference: input.paymentReference ?? null,
              }
            : {}),
        },
      });
      await this.audit.record(
        {
          action: 'settlement.status',
          entityType: 'Settlement',
          entityId: id,
          before: {
            bookingReference: basis?.booking.reference ?? null,
            ...figuresOf(row),
            status: row.status,
          },
          after: {
            bookingReference: basis?.booking.reference ?? null,
            ...figuresOf(updated),
            status: updated.status,
            paymentReference: updated.paymentReference,
            paidAt: updated.paidAt?.toISOString() ?? null,
          },
          reason: input.reason,
        },
        tx,
      );
    });

    return toAdminDto(
      await this.prisma.settlement.findUniqueOrThrow({
        where: { id },
        include: ADMIN_INCLUDE,
      }),
    );
  }

  // --- Operators -------------------------------------------------------------

  /** The caller's organisation's settlements, newest first. */
  async operatorList(
    user: AuthUser,
    page: number,
    pageSize: number,
  ): Promise<{ items: OperatorSettlementDto[]; total: number }> {
    const { operator } = await this.operators.accessFor(user);
    const where: Prisma.SettlementWhereInput = { operatorId: operator.id };
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.settlement.findMany({
        where,
        include: { booking: { select: { reference: true } } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.settlement.count({ where }),
    ]);
    return {
      items: rows.map((row) => ({
        id: row.id,
        bookingReference: row.booking.reference,
        payableMinor: minorToNumber(row.payableMinor),
        currency: row.currency,
        status: row.status,
        paidAt: row.paidAt?.toISOString() ?? null,
        paymentReference: row.paymentReference,
        createdAt: row.createdAt.toISOString(),
      })),
      total,
    };
  }
}

function toAdminDto(row: AdminRow): AdminSettlementDto {
  return {
    id: row.id,
    bookingReference: row.booking.reference,
    bookingStatus: row.booking.status,
    operatorId: row.operatorId,
    operatorName: row.operator.tradingName ?? row.operator.legalName,
    payableMinor: minorToNumber(row.payableMinor),
    commissionMinor: minorToNumber(row.commissionMinor),
    taxMinor: minorToNumber(row.taxMinor),
    currency: row.currency,
    status: row.status,
    paidAt: row.paidAt?.toISOString() ?? null,
    paymentReference: row.paymentReference,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
