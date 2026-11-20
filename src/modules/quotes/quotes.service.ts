import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { minorToNumber } from '../../common/money.js';
import { quoteReference } from '../../common/reference.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PriceType, QuoteStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type {
  OperatorQuoteResponseDto,
  QuoteConditionsDto,
  QuoteResponseDto,
} from './dto/quote.dto.js';
import { isLive, type QuoteAction, quoteMove } from './quote-transitions.js';

export type QuoteRow = Prisma.QuoteGetPayload<object>;

/** What an operator's view reads from the quote's stored calculation. */
export const QUOTE_CALCULATION_SELECT = {
  baseMinor: true,
  operatorPayableMinor: true,
  currency: true,
} as const satisfies Prisma.PriceCalculationSelect;

export type OperatorQuoteRow = QuoteRow & {
  calculation: Prisma.PriceCalculationGetPayload<{
    select: typeof QUOTE_CALCULATION_SELECT;
  }> | null;
};

/** `Quote.conditions` (jsonb) as written. */
interface StoredConditions extends QuoteConditionsDto {
  version: 1;
}

const NO_CONDITIONS: QuoteConditionsDto = {
  summary: '',
  charges: [],
  inclusions: [],
  exclusions: [],
};

/**
 * Quotes (M8): the operator's price for a booking request, with its
 * conditions and validity. This service owns the `Quote` table; bookings
 * call it inside their own transaction, holding the booking's lock, so a
 * revision and an answer to the quote it replaces never interleave. A sent
 * quote is never edited: a revision is a new quote and supersedes it.
 */
@Injectable()
export class QuotesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  /** The booking's newest quote, or null. */
  newest(
    db: Prisma.TransactionClient,
    bookingId: string,
  ): Promise<QuoteRow | null> {
    return db.quote.findFirst({
      where: { bookingId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  /** Every quote sent on the booking, newest first (drafts left out). */
  forBooking(bookingId: string): Promise<QuoteRow[]> {
    return this.prisma.quote.findMany({
      where: { bookingId, status: { not: QuoteStatus.DRAFT } },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
  }

  byReference(reference: string): Promise<QuoteRow | null> {
    return this.prisma.quote.findUnique({ where: { reference } });
  }

  /** Sent quotes past their validity, oldest first, for the expiry job. */
  lapsed(now: Date, take: number, skip: string[]): Promise<QuoteRow[]> {
    return this.prisma.quote.findMany({
      where: {
        id: { notIn: skip },
        status: QuoteStatus.SENT,
        validUntil: { lte: now },
      },
      orderBy: [{ validUntil: 'asc' }, { id: 'asc' }],
      take,
    });
  }

  /**
   * Sends a new quote on a booking and supersedes the one it replaces, in
   * the caller's transaction (which holds the booking's lock). Audited.
   * Returns the new quote and the reference it superseded, if any.
   */
  async issue(
    tx: Prisma.TransactionClient,
    input: {
      bookingId: string;
      operatorId: string;
      /** The customer's total, priced by Flyviman's rules (D-172). */
      totalMinor: number;
      /** The stored calculation behind `totalMinor`: Flyviman's pricing of
       * the operator's price, or a manual override's (M10). */
      calculationId: string;
      currency: string;
      validUntil: Date;
      /** Flyviman's terms from the booking, with the operator's notes. */
      conditions: QuoteConditionsDto;
      createdById: string;
    },
    now: Date,
  ): Promise<{ quote: QuoteRow; superseded: string | null }> {
    const open = await tx.quote.findMany({
      where: { bookingId: input.bookingId, status: QuoteStatus.SENT },
    });
    for (const previous of open) {
      await this.move(tx, previous, 'supersede', now);
    }
    const conditions: StoredConditions = {
      version: 1,
      summary: input.conditions.summary,
      charges: input.conditions.charges.map((charge) => ({
        minHoursBeforeDeparture: charge.minHoursBeforeDeparture,
        chargePercent: charge.chargePercent,
      })),
      inclusions: [...input.conditions.inclusions],
      exclusions: [...input.conditions.exclusions],
    };
    const quote = await tx.quote.create({
      data: {
        reference: quoteReference(),
        bookingId: input.bookingId,
        calculationId: input.calculationId,
        operatorId: input.operatorId,
        totalMinor: BigInt(input.totalMinor),
        currency: input.currency,
        priceType: PriceType.QUOTE,
        conditions: conditions as unknown as Prisma.InputJsonValue,
        validUntil: input.validUntil,
        status: QuoteStatus.SENT,
        createdById: input.createdById,
      },
    });
    await this.audit.record(
      {
        action: 'quote.issue',
        entityType: 'Quote',
        entityId: quote.id,
        after: {
          reference: quote.reference,
          bookingId: input.bookingId,
          calculationId: input.calculationId,
          status: quote.status,
          totalMinor: input.totalMinor,
          currency: quote.currency,
          priceType: quote.priceType,
          validUntil: quote.validUntil.toISOString(),
          supersedes: open.map((previous) => previous.reference),
        },
      },
      tx,
    );
    return { quote, superseded: open[0]?.reference ?? null };
  }

  /**
   * Moves a quote (`quote-transitions.ts`), only if it is still in the
   * status that was read: of two answers at once, one wins and the other is
   * 409. An accepted quote's price becomes `CONFIRMED`. Audited; `actor:
   * null` for the job.
   */
  async move(
    tx: Prisma.TransactionClient,
    quote: QuoteRow,
    action: QuoteAction,
    now: Date,
    options: { system?: boolean } = {},
  ): Promise<QuoteStatus> {
    const next = quoteMove(quote, action, now);
    if ('refused' in next) throw refusal(next.refused);
    const accepted = next.to === QuoteStatus.ACCEPTED;
    const answering = action === 'accept' || action === 'reject';
    const { count } = await tx.quote.updateMany({
      where: {
        id: quote.id,
        status: quote.status,
        // An answer is taken only while the quote is still valid.
        ...(answering ? { validUntil: { gt: now } } : {}),
      },
      data: {
        status: next.to,
        ...(accepted ? { priceType: PriceType.CONFIRMED } : {}),
      },
    });
    if (count !== 1) {
      throw refusal('QUOTE_INVALID_TRANSITION');
    }
    await this.audit.record(
      {
        action: 'quote.status',
        entityType: 'Quote',
        entityId: quote.id,
        before: { reference: quote.reference, status: quote.status },
        after: {
          reference: quote.reference,
          status: next.to,
          ...(accepted ? { priceType: PriceType.CONFIRMED } : {}),
        },
        ...(options.system ? { actor: null } : {}),
      },
      tx,
    );
    return next.to;
  }

  /** The conditions as written; anything malformed reads as none. */
  conditionsOf(quote: QuoteRow): QuoteConditionsDto {
    const raw = quote.conditions as Partial<StoredConditions> | null;
    if (!raw || raw.version !== 1) return NO_CONDITIONS;
    return {
      summary: typeof raw.summary === 'string' ? raw.summary : '',
      charges: Array.isArray(raw.charges) ? raw.charges : [],
      inclusions: Array.isArray(raw.inclusions) ? raw.inclusions : [],
      exclusions: Array.isArray(raw.exclusions) ? raw.exclusions : [],
    };
  }

  /**
   * The operator's view: the customer's view plus the operator's own price
   * and payable, from the stored calculation (never shown to a customer).
   */
  toOperatorResponse(
    quote: OperatorQuoteRow,
    bookingReference: string,
    now = new Date(),
  ): OperatorQuoteResponseDto {
    const { calculation } = quote;
    return {
      ...this.toResponse(quote, bookingReference, now),
      operatorPrice: calculation
        ? {
            priceType: quote.priceType,
            amountMinor: minorToNumber(calculation.baseMinor),
            payableMinor: minorToNumber(calculation.operatorPayableMinor),
            currency: calculation.currency,
          }
        : null,
    };
  }

  toResponse(
    quote: QuoteRow,
    bookingReference: string,
    now = new Date(),
  ): QuoteResponseDto {
    return {
      reference: quote.reference,
      bookingReference,
      status: quote.status,
      open: isLive(quote, now),
      price: {
        priceType: quote.priceType,
        amountMinor: minorToNumber(quote.totalMinor),
        currency: quote.currency,
        validUntil: quote.validUntil.toISOString(),
      },
      conditions: this.conditionsOf(quote),
      createdAt: quote.createdAt.toISOString(),
      updatedAt: quote.updatedAt.toISOString(),
    };
  }
}

export function refusal(
  code: 'QUOTE_EXPIRED' | 'QUOTE_INVALID_TRANSITION',
): AppException {
  return code === 'QUOTE_EXPIRED'
    ? new AppException(
        'QUOTE_EXPIRED',
        'This quote has expired and can no longer be accepted or declined.',
        HttpStatus.CONFLICT,
      )
    : new AppException(
        'QUOTE_INVALID_TRANSITION',
        'This quote has already been answered or replaced. Reload the booking to see the current quote.',
        HttpStatus.CONFLICT,
      );
}
