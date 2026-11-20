import { HttpStatus, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AppException } from '../../common/errors/app.exception.js';
import { minorToNumber } from '../../common/money.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PriceType, RefundStatus, Role } from '../../generated/prisma/enums.js';
import { PaymentGatewayProvider } from '../../integrations/payment/payment-gateway.provider.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { MONEY_IN } from '../bookings/paid-amount.js';
import type {
  PaymentDetailDto,
  PaymentMethodDto,
  PaymentReceiptDto,
} from './dto/payment-view.dto.js';
import type { RefundSummaryDto } from './dto/refund.dto.js';

/** Who may read any payment; a customer reads only their own. */
const STAFF: readonly Role[] = [Role.FINANCE_ADMIN, Role.SUPER_ADMIN];

export const RECEIPT_NOTICE =
  'This is a payment receipt, not a GST tax invoice.';

const METHOD_LABELS: Record<string, string> = {
  card: 'Card',
  upi: 'UPI',
  netbanking: 'Net banking',
  wallet: 'Wallet',
  emi: 'EMI',
  paylater: 'Pay later',
};

const VIEW = {
  reference: true,
  providerOrderId: true,
  purpose: true,
  amountMinor: true,
  currency: true,
  status: true,
  method: true,
  paidAt: true,
  createdAt: true,
  booking: { select: { reference: true, category: true } },
  refunds: {
    select: {
      reference: true,
      amountMinor: true,
      currency: true,
      status: true,
      createdAt: true,
      updatedAt: true,
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} as const satisfies Prisma.PaymentSelect;

type ViewRow = Prisma.PaymentGetPayload<{ select: typeof VIEW }>;

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Payment not found.',
    HttpStatus.NOT_FOUND,
  );
}

/** The method type as kept, and a label; never card details (rule 10). */
export function methodOf(type: string | null): PaymentMethodDto {
  return {
    type,
    label: type === null ? 'Not reported' : (METHOD_LABELS[type] ?? 'Other'),
  };
}

/**
 * A payment and its receipt (M9, W4-1), for the customer who paid or for
 * finance and the super administrator. Someone else's payment is 404. Read
 * only: nothing here moves money or status.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly gateway: PaymentGatewayProvider,
    private readonly config: ConfigService,
  ) {}

  async detail(user: AuthUser, reference: string): Promise<PaymentDetailDto> {
    const row = await this.find(user, reference);
    return {
      reference: row.reference,
      bookingReference: row.booking.reference,
      status: row.status,
      purpose: row.purpose,
      price: {
        priceType: PriceType.CONFIRMED,
        amountMinor: minorToNumber(row.amountMinor),
        currency: row.currency,
      },
      checkout: {
        provider: this.gateway.name,
        keyId: this.gateway.checkoutKeyId,
        orderId: row.providerOrderId ?? '',
      },
      paidAt: row.paidAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      method: methodOf(row.method),
      refundedMinor: minorToNumber(refunded(row)),
      refunds: row.refunds.map(refundView),
    };
  }

  /**
   * The receipt of a payment whose money arrived; 409
   * `PAYMENT_NOT_SUCCEEDED` before that (nothing to receipt yet).
   */
  async receipt(user: AuthUser, reference: string): Promise<PaymentReceiptDto> {
    const row = await this.find(user, reference);
    if (!MONEY_IN.includes(row.status) || !row.paidAt) {
      throw new AppException(
        'PAYMENT_NOT_SUCCEEDED',
        'There is no receipt until the payment has succeeded.',
        HttpStatus.CONFLICT,
        [{ field: 'status', issue: row.status }],
      );
    }
    const back = refunded(row);
    return {
      documentType: 'PAYMENT_RECEIPT',
      notice: RECEIPT_NOTICE,
      receiptNumber: row.reference,
      issuedAt: new Date().toISOString(),
      issuer: {
        name: this.config.getOrThrow<string>('RECEIPT_ISSUER_NAME'),
        address: this.config.get<string>('RECEIPT_ISSUER_ADDRESS') ?? null,
        email: this.config.get<string>('RECEIPT_ISSUER_EMAIL') ?? null,
        phone: this.config.get<string>('RECEIPT_ISSUER_PHONE') ?? null,
      },
      bookingReference: row.booking.reference,
      category: row.booking.category,
      purpose: row.purpose,
      amount: {
        priceType: PriceType.CONFIRMED,
        amountMinor: minorToNumber(row.amountMinor),
        currency: row.currency,
      },
      method: methodOf(row.method),
      paidAt: row.paidAt.toISOString(),
      refunds: row.refunds.map(refundView),
      refundedMinor: minorToNumber(back),
      netPaidMinor: minorToNumber(row.amountMinor - back),
    };
  }

  private async find(user: AuthUser, reference: string): Promise<ViewRow> {
    const row = await this.prisma.payment.findFirst({
      where: STAFF.includes(user.role)
        ? { reference }
        : { reference, booking: { customerId: user.id } },
      select: VIEW,
    });
    if (!row) throw notFound();
    return row;
  }
}

function refunded(row: ViewRow): bigint {
  return row.refunds
    .filter((refund) => refund.status === RefundStatus.COMPLETED)
    .reduce((total, refund) => total + refund.amountMinor, 0n);
}

function refundView(refund: ViewRow['refunds'][number]): RefundSummaryDto {
  return {
    reference: refund.reference,
    amountMinor: minorToNumber(refund.amountMinor),
    currency: refund.currency,
    status: refund.status,
    createdAt: refund.createdAt.toISOString(),
    updatedAt: refund.updatedAt.toISOString(),
  };
}
