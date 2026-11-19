import { Module } from '@nestjs/common';
import { PaymentModule } from '../../integrations/payment/payment.module.js';
import { PaymentWebhooksController } from './payment-webhooks.controller.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';

@Module({
  imports: [PaymentModule],
  controllers: [PaymentWebhooksController],
  providers: [PaymentWebhooksService],
})
export class PaymentsModule {}
