import { describe, expect, it, vi } from 'vitest';
import {
  BookingPaymentStatus,
  BookingStatus,
  PaymentModel,
  PriceType,
} from '../../generated/prisma/enums.js';
import { amountDue } from '../payments/payment-rules.js';
import { depositPercentFor, depositPercentToSave } from './deposit-percent.js';

const NOW = new Date('2026-11-21T12:00:00Z');

function payable(paymentModel: PaymentModel) {
  return {
    status: BookingStatus.AWAITING_PAYMENT,
    priceType: PriceType.CONFIRMED,
    paymentModel,
    operatorAccepted: true,
    paymentStatus: BookingPaymentStatus.UNPAID,
    totalMinor: 1_000_000n,
    creditedMinor: 0n,
    departureAt: new Date('2026-12-01T08:00:00Z'),
  };
}

describe('depositPercentToSave', () => {
  it('saves the configured percent for Model C only', () => {
    expect(
      depositPercentToSave({
        paymentModel: PaymentModel.C_DEPOSIT,
        depositPercent: 30,
      }),
    ).toBe(30);
    expect(
      depositPercentToSave({
        paymentModel: PaymentModel.B_OPERATOR_CONFIRMED,
        depositPercent: 30,
      }),
    ).toBeNull();
    expect(
      depositPercentToSave({
        paymentModel: PaymentModel.A_INSTANT,
        depositPercent: 30,
      }),
    ).toBeNull();
  });
});

describe('depositPercentFor', () => {
  it('uses the percent saved on a Model C booking, not the configuration', async () => {
    const configured = vi.fn(async () => 50);
    const percent = await depositPercentFor(
      { paymentModel: PaymentModel.C_DEPOSIT, depositPercent: 30 },
      configured,
    );
    expect(percent).toBe(30);
    expect(configured).not.toHaveBeenCalled();
    // The deposit owed follows the saved 30 %, after an admin changed it to 50 %.
    const due = amountDue(payable(PaymentModel.C_DEPOSIT), percent, NOW);
    expect(due).toMatchObject({ due: true, amountMinor: 300_000n });
  });

  it('falls back to the configuration when nothing was saved', async () => {
    const configured = vi.fn(async () => 50);
    const percent = await depositPercentFor(
      { paymentModel: PaymentModel.C_DEPOSIT, depositPercent: null },
      configured,
    );
    expect(percent).toBe(50);
    expect(configured).toHaveBeenCalledOnce();
    expect(
      amountDue(payable(PaymentModel.C_DEPOSIT), percent, NOW),
    ).toMatchObject({ due: true, amountMinor: 500_000n });
  });

  it('is 100 for Model A and B without reading the configuration', async () => {
    const configured = vi.fn(async () => 50);
    for (const paymentModel of [
      PaymentModel.A_INSTANT,
      PaymentModel.B_OPERATOR_CONFIRMED,
    ]) {
      const percent = await depositPercentFor(
        { paymentModel, depositPercent: null },
        configured,
      );
      expect(percent).toBe(100);
      expect(amountDue(payable(paymentModel), percent, NOW)).toMatchObject({
        due: true,
        amountMinor: 1_000_000n,
      });
    }
    expect(configured).not.toHaveBeenCalled();
  });
});
