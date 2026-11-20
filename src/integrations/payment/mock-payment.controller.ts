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
import { IsIn } from 'class-validator';
import { Public } from '../../modules/auth/auth.decorators.js';
import { DevToolsGuard } from '../dev-tools.guard.js';
import {
  MockPaymentGatewayProvider,
  type SimulatedOutcome,
  type SimulatedPayment,
} from './mock-payment-gateway.provider.js';
import {
  PaymentGatewayError,
  PaymentGatewayProvider,
} from './payment-gateway.provider.js';

export class SimulatePaymentDto {
  @IsIn(['success', 'failure'])
  outcome: SimulatedOutcome;
}

/**
 * Development and test only: pays an order in the mock gateway as its
 * checkout would, so what `fetchPayment` reports changes, and returns the
 * checkout result and the signed notice without sending either (a notice
 * that never arrives, for the status sweep). Answered only when
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
      return this.gateway.simulatePayment(orderId, dto.outcome);
    } catch (error) {
      if (error instanceof PaymentGatewayError) throw new NotFoundException();
      throw error;
    }
  }
}
