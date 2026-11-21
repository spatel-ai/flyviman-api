import { PaymentModel } from '../../generated/prisma/enums.js';

/**
 * The deposit percent saved on a new booking: the configured one for Model C,
 * null for the other models (D-204 follow-up). Saved, so a later change to
 * the category configuration applies to new bookings only.
 */
export function depositPercentToSave(config: {
  paymentModel: PaymentModel;
  depositPercent: number;
}): number | null {
  return config.paymentModel === PaymentModel.C_DEPOSIT
    ? config.depositPercent
    : null;
}

/**
 * The percent of the total a booking's first payment takes: 100 unless
 * Model C, then the percent saved on the booking. `configured` is read only
 * for a Model C booking made before the percent was saved (none after the
 * backfill, kept as a guard).
 */
export async function depositPercentFor(
  booking: { paymentModel: PaymentModel; depositPercent: number | null },
  configured: () => Promise<number>,
): Promise<number> {
  if (booking.paymentModel !== PaymentModel.C_DEPOSIT) return 100;
  return booking.depositPercent ?? configured();
}
