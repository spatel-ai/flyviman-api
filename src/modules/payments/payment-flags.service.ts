import { HttpStatus, Injectable } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import type { PaymentReviewReason } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AdminPaymentDto } from './dto/payment-view.dto.js';
import { hasOpenGatewayFlag } from './payment-rules.js';
import { ReceiptsService } from './receipts.service.js';

/**
 * Finance's resolution of a payment flagged `AMOUNT_MISMATCH` or
 * `DUPLICATE_CAPTURE` (D-202 follow-up): the money was checked at the
 * gateway and settled there or by a refund through the refund flow.
 * Records the resolution only: never moves money, never changes the
 * payment's or the booking's status, and keeps `reviewReason`.
 */
@Injectable()
export class PaymentFlagsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly receipts: ReceiptsService,
  ) {}

  /**
   * 409 `PAYMENT_FLAG_NOT_OPEN` unless the payment carries an unresolved
   * `AMOUNT_MISMATCH` or `DUPLICATE_CAPTURE` flag. Audited with the reason.
   */
  async resolve(reference: string, reason: string): Promise<AdminPaymentDto> {
    await this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<
        {
          id: string;
          reviewReason: PaymentReviewReason | null;
          reviewResolvedAt: Date | null;
        }[]
      >`SELECT "id", "reviewReason", "reviewResolvedAt" FROM "Payment"
        WHERE "reference" = ${reference} FOR UPDATE`;
      const payment = rows[0];
      if (!payment) {
        throw new AppException(
          'NOT_FOUND',
          'Payment not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (!hasOpenGatewayFlag(payment)) {
        throw new AppException(
          'PAYMENT_FLAG_NOT_OPEN',
          'This payment has no open AMOUNT_MISMATCH or DUPLICATE_CAPTURE flag to resolve.',
          HttpStatus.CONFLICT,
          [
            {
              field: 'reviewReason',
              issue: payment.reviewResolvedAt
                ? 'already resolved'
                : String(payment.reviewReason),
            },
          ],
        );
      }
      const reviewResolvedAt = new Date();
      await tx.payment.update({
        where: { id: payment.id },
        data: { reviewResolvedAt },
      });
      await this.audit.record(
        {
          action: 'payment.flag_resolve',
          entityType: 'Payment',
          entityId: payment.id,
          before: {
            reference,
            reviewReason: payment.reviewReason,
            reviewResolvedAt: null,
          },
          after: {
            reference,
            reviewReason: payment.reviewReason,
            reviewResolvedAt: reviewResolvedAt.toISOString(),
          },
          reason,
        },
        tx,
      );
    });
    return this.receipts.adminOne(reference);
  }
}
