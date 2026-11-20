import {
  Body,
  Controller,
  HttpCode,
  NotFoundException,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { Public } from '../../modules/auth/auth.decorators.js';
import { DevToolsGuard } from '../dev-tools.guard.js';
import {
  MOCK_PAYMENT_METHODS,
  MockPaymentGatewayProvider,
  type MockPaymentMethod,
  type SignedWebhook,
  type SimulatedOutcome,
  type SimulatedPayment,
  type SimulatedRefundOutcome,
} from './mock-payment-gateway.provider.js';
import {
  PaymentGatewayError,
  PaymentGatewayProvider,
} from './payment-gateway.provider.js';

export class SimulatePaymentDto {
  @IsIn(['success', 'failure'])
  outcome: SimulatedOutcome;

  @IsOptional()
  @IsIn(MOCK_PAYMENT_METHODS)
  method?: MockPaymentMethod;
}

export class SimulateRefundDto {
  @IsIn(['processed', 'failed'])
  outcome: SimulatedRefundOutcome;
}

/**
 * Development and test only: pays an order in the mock gateway as its
 * checkout would, so what `fetchPayment` reports changes, and returns the
 * checkout result and the signed notice without sending either (a notice
 * that never arrives, for the status sweep). Settles a refund the same way. Answered only when
 * ENABLE_DEV_TOOLS is on, which production refuses (DevToolsGuard).
 */
@ApiExcludeController()
@UseGuards(DevToolsGuard)
@Public()
@Controller('dev/payments')
export class MockPaymentController {
  constructor(private readonly gateway: PaymentGatewayProvider) {}

  @Post('orders/:orderId/simulate')
  @HttpCode(200)
  simulate(
    @Param('orderId') orderId: string,
    @Body() dto: SimulatePaymentDto,
  ): SimulatedPayment {
    if (!(this.gateway instanceof MockPaymentGatewayProvider)) {
      throw new NotFoundException();
    }
    try {
      return this.gateway.simulatePayment(orderId, dto.outcome, dto.method);
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw new NotFoundException();
      throw error;
    }
  }

  /** Settles a pending refund; returns its signed notice, not sent. */
  @Post('refunds/:refundId/simulate')
  @HttpCode(200)
  simulateRefund(
    @Param('refundId') refundId: string,
    @Body() dto: SimulateRefundDto,
  ): SignedWebhook {
    if (!(this.gateway instanceof MockPaymentGatewayProvider)) {
      throw new NotFoundException();
    }
    try {
      return this.gateway.simulateRefund(refundId, dto.outcome);
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw new NotFoundException();
      throw error;
    }
  }
}
