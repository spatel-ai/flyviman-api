import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { minorToNumber } from '../../common/money.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import type {
  CreatePromotionDto,
  ListPromotionsDto,
  PromotionResponseDto,
} from './dto/promotion.dto.js';
import type { PromotionInput } from './engine.js';
import {
  engineInput,
  normalizeCode,
  PROMOTION_MESSAGES,
  type PromotionProblem,
  promotionProblem,
  promotionStatus,
  type PromotionTerms,
  type PromotionTrip,
} from './promotions.js';

type PromotionRow = Prisma.PromotionGetPayload<object>;

/** A code applied to a trip: what the engine needs, and the row to redeem. */
export interface AppliedPromotion {
  promotionId: string;
  input: PromotionInput;
}

function terms(row: PromotionRow): PromotionTerms {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    kind: row.kind,
    percentBasisPoints: row.percentBasisPoints,
    amountMinor: row.amountMinor == null ? null : minorToNumber(row.amountMinor),
    category: row.category,
    originId: row.originId,
    destinationId: row.destinationId,
    startsAt: row.startsAt,
    endsAt: row.endsAt,
    maxUses: row.maxUses,
    maxUsesPerCustomer: row.maxUsesPerCustomer,
    endedAt: row.endedAt,
  };
}

export function promotionRefusal(problem: PromotionProblem): AppException {
  return new AppException(
    problem,
    PROMOTION_MESSAGES[problem],
    HttpStatus.UNPROCESSABLE_ENTITY,
    [{ field: 'promoCode', issue: problem }],
  );
}

function invalid(field: string, issue: string): AppException {
  return new AppException(
    'VALIDATION_ERROR',
    'The request is not valid.',
    HttpStatus.BAD_REQUEST,
    [{ field, issue }],
  );
}

/**
 * Promotion codes (M10). Finance and super administrators create and end
 * them; nothing else changes a promotion, so a calculation that applied one
 * stays explainable. Both are audited (`promotion.create`, `promotion.end`)
 * with the reason. Automatic discounts are the `DISCOUNT` pricing rule.
 *
 * A code is checked when the customer previews it and again when they book:
 * `redeem` takes the promotion's lock and counts the uses once more inside
 * the booking's transaction, so two bookings at once cannot pass a cap.
 */
@Injectable()
export class PromotionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // --- Admin ---------------------------------------------------------------

  async list(
    query: ListPromotionsDto,
  ): Promise<{ items: PromotionResponseDto[]; total: number }> {
    const now = new Date();
    const where: Prisma.PromotionWhereInput =
      query.status === 'ENDED'
        ? { OR: [{ endedAt: { not: null } }, { endsAt: { lte: now } }] }
        : query.status === 'ACTIVE'
          ? { endedAt: null, startsAt: { lte: now }, endsAt: { gt: now } }
          : query.status === 'SCHEDULED'
            ? { endedAt: null, startsAt: { gt: now } }
            : {};
    const [rows, total] = await Promise.all([
      this.prisma.promotion.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize,
      }),
      this.prisma.promotion.count({ where }),
    ]);
    return { items: await this.toResponses(rows, now), total };
  }

  async create(
    user: AuthUser,
    dto: CreatePromotionDto,
  ): Promise<PromotionResponseDto> {
    const now = new Date();
    if (dto.kind === 'PERCENT' && dto.amountMinor !== undefined) {
      throw invalid('amountMinor', 'must be left out for a PERCENT promotion');
    }
    if (dto.kind === 'FIXED' && dto.percent !== undefined) {
      throw invalid('percent', 'must be left out for a FIXED promotion');
    }
    const startsAt = new Date(dto.startsAt);
    const endsAt = new Date(dto.endsAt);
    if (endsAt.getTime() <= startsAt.getTime()) {
      throw invalid('endsAt', 'must be after startsAt');
    }
    if (endsAt.getTime() <= now.getTime()) {
      throw invalid('endsAt', 'must be in the future');
    }
    const originId = dto.originId ?? null;
    const destinationId = dto.destinationId ?? null;
    if ((originId === null) !== (destinationId === null)) {
      throw invalid('destinationId', 'give both ends of the route, or neither');
    }
    if (originId && originId === destinationId) {
      throw invalid('destinationId', 'must differ from originId');
    }
    if (originId && destinationId) {
      const found = await this.prisma.location.count({
        where: { id: { in: [originId, destinationId] }, isActive: true },
      });
      if (found !== 2) throw invalid('originId', 'unknown or inactive location');
    }
    const code = normalizeCode(dto.code);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const created = await tx.promotion.create({
          data: {
            code,
            name: dto.name,
            kind: dto.kind,
            percentBasisPoints:
              dto.kind === 'PERCENT' ? Math.round((dto.percent ?? 0) * 100) : null,
            amountMinor:
              dto.kind === 'FIXED' ? BigInt(dto.amountMinor ?? 0) : null,
            currency: dto.currency,
            category: dto.category ?? null,
            originId,
            destinationId,
            startsAt,
            endsAt,
            maxUses: dto.maxUses ?? null,
            maxUsesPerCustomer: dto.maxUsesPerCustomer ?? null,
            createdById: user.id,
          },
        });
        await this.audit.record(
          {
            action: 'promotion.create',
            entityType: 'Promotion',
            entityId: created.id,
            after: snapshot(created),
            reason: dto.reason,
          },
          tx,
        );
        return created;
      });
      return (await this.toResponses([row], now))[0];
    } catch (error) {
      if ((error as { code?: unknown }).code === 'P2002') {
        throw new AppException(
          'PROMOTION_CODE_EXISTS',
          'A promotion with this code already exists. Choose another code.',
          HttpStatus.CONFLICT,
          [{ field: 'code', issue: 'taken' }],
        );
      }
      throw error;
    }
  }

  /** Ends a promotion now. Only once, and not one already past its window. */
  async end(
    id: string,
    reason: string,
  ): Promise<PromotionResponseDto> {
    const now = new Date();
    const row = await this.prisma.$transaction(async (tx) => {
      const current = await tx.promotion.findUnique({ where: { id } });
      if (!current) {
        throw new AppException(
          'NOT_FOUND',
          'Promotion not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      // Conditional on still being open, so two at once end it once.
      const { count } = await tx.promotion.updateMany({
        where: { id, endedAt: null, endsAt: { gt: now } },
        data: { endedAt: now },
      });
      if (count !== 1) {
        throw new AppException(
          'PROMOTION_ENDED',
          'This promotion has already ended.',
          HttpStatus.CONFLICT,
        );
      }
      const ended = { ...current, endedAt: now };
      await this.audit.record(
        {
          action: 'promotion.end',
          entityType: 'Promotion',
          entityId: id,
          before: snapshot(current),
          after: snapshot(ended),
          reason,
        },
        tx,
      );
      return ended;
    });
    return (await this.toResponses([row], now))[0];
  }

  // --- Customers and bookings ----------------------------------------------

  /**
   * The promotion for `code` if it can be used on `trip` by `customerId`
   * (null: not signed in, so only the overall cap is checked). Otherwise a
   * 422 naming the reason.
   */
  async forCode(
    code: string,
    trip: PromotionTrip,
    customerId: string | null,
  ): Promise<AppliedPromotion> {
    const row = await this.prisma.promotion.findUnique({
      where: { code: normalizeCode(code) },
    });
    const usage = row
      ? await this.usage(this.prisma, row.id, customerId)
      : { total: 0, customer: null };
    const problem = promotionProblem(row && terms(row), trip, usage);
    if (problem || !row) {
      throw promotionRefusal(problem ?? 'PROMO_CODE_INVALID');
    }
    return { promotionId: row.id, input: engineInput(terms(row)) };
  }

  /**
   * Records a booking's use of a promotion, in the booking's transaction:
   * under the promotion's lock, the code is checked again (it may have
   * ended or reached a cap meanwhile). Lock order: the customer's, then
   * this, then the aircraft's.
   */
  async redeem(
    tx: Prisma.TransactionClient,
    input: {
      promotionId: string;
      customerId: string;
      bookingId: string;
      trip: PromotionTrip;
    },
  ): Promise<void> {
    const key = `promotion:${input.promotionId}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
    const row = await tx.promotion.findUnique({
      where: { id: input.promotionId },
    });
    const usage = await this.usage(tx, input.promotionId, input.customerId);
    const problem = promotionProblem(row && terms(row), input.trip, usage);
    if (problem) throw promotionRefusal(problem);
    await tx.promotionRedemption.create({
      data: {
        promotionId: input.promotionId,
        customerId: input.customerId,
        bookingId: input.bookingId,
      },
    });
  }

  private async usage(
    db: Prisma.TransactionClient | PrismaService,
    promotionId: string,
    customerId: string | null,
  ): Promise<{ total: number; customer: number | null }> {
    const [total, customer] = await Promise.all([
      db.promotionRedemption.count({ where: { promotionId } }),
      customerId
        ? db.promotionRedemption.count({ where: { promotionId, customerId } })
        : Promise.resolve(null),
    ]);
    return { total, customer };
  }

  private async toResponses(
    rows: PromotionRow[],
    now: Date,
  ): Promise<PromotionResponseDto[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((row) => row.id);
    const placeIds = rows.flatMap((row) =>
      [row.originId, row.destinationId].filter((v): v is string => !!v),
    );
    const [uses, places] = await Promise.all([
      this.prisma.promotionRedemption.groupBy({
        by: ['promotionId'],
        where: { promotionId: { in: ids } },
        _count: { _all: true },
      }),
      placeIds.length
        ? this.prisma.location.findMany({
            where: { id: { in: placeIds } },
            select: { id: true, name: true },
          })
        : Promise.resolve([]),
    ]);
    const useCount = new Map(
      uses.map((entry) => [entry.promotionId, entry._count._all]),
    );
    const names = new Map(places.map((place) => [place.id, place.name]));
    return rows.map((row) => {
      const status = promotionStatus(row, now);
      return {
        id: row.id,
        code: row.code,
        name: row.name,
        kind: row.kind,
        percent:
          row.percentBasisPoints == null ? null : row.percentBasisPoints / 100,
        amountMinor:
          row.amountMinor == null ? null : minorToNumber(row.amountMinor),
        currency: row.currency,
        category: row.category as PromotionResponseDto['category'],
        originId: row.originId,
        originName: row.originId ? (names.get(row.originId) ?? null) : null,
        destinationId: row.destinationId,
        destinationName: row.destinationId
          ? (names.get(row.destinationId) ?? null)
          : null,
        startsAt: row.startsAt.toISOString(),
        endsAt: row.endsAt.toISOString(),
        maxUses: row.maxUses,
        maxUsesPerCustomer: row.maxUsesPerCustomer,
        uses: useCount.get(row.id) ?? 0,
        status,
        endedAt: row.endedAt?.toISOString() ?? null,
        endable: status !== 'ENDED',
        createdAt: row.createdAt.toISOString(),
      };
    });
  }
}

/** The audit record's view: the terms, never who used it. */
function snapshot(row: PromotionRow): Prisma.InputJsonObject {
  return {
    code: row.code,
    name: row.name,
    kind: row.kind,
    percentBasisPoints: row.percentBasisPoints,
    amountMinor:
      row.amountMinor == null ? null : minorToNumber(row.amountMinor),
    currency: row.currency,
    category: row.category,
    originId: row.originId,
    destinationId: row.destinationId,
    startsAt: row.startsAt.toISOString(),
    endsAt: row.endsAt.toISOString(),
    maxUses: row.maxUses,
    maxUsesPerCustomer: row.maxUsesPerCustomer,
    endedAt: row.endedAt?.toISOString() ?? null,
  };
}
