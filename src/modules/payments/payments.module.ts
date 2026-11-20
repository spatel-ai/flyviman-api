import { Module } from '@nestjs/common';
import { PaymentModule } from '../../integrations/payment/payment.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { AdminPaymentsController } from './admin-payments.controller.js';
import { DevPaymentJobsController } from './dev-payment-jobs.controller.js';
import { PaymentWebhooksController } from './payment-webhooks.controller.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { ReceiptsService } from './receipts.service.js';
import { RefundsService } from './refunds.service.js';

/**
 * Payments (M9): orders, checkout results, gateway notifications, the
 * status sweep, refunds and receipts.
 */
@Module({
  imports: [PaymentModule, BookingsModule, ConfigurationModule],
  controllers: [
    PaymentsController,
    PaymentWebhooksController,
    AdminPaymentsController,
    DevPaymentJobsController,
  ],
  providers: [
    PaymentsService,
    PaymentWebhooksService,
    RefundsService,
    ReceiptsService,
  ],
})
export class PaymentsModule {}
