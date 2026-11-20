import { Module } from '@nestjs/common';
import { PaymentModule } from '../../integrations/payment/payment.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { DevPaymentJobsController } from './dev-payment-jobs.controller.js';
import { NotificationEventsModule } from '../notifications/events/notification-events.module.js';
import { PaymentWebhooksController } from './payment-webhooks.controller.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';

/**
 * Payments (M9): orders, checkout results, gateway notifications and the
 * status sweep.
 */
@Module({
  imports: [
    PaymentModule,
    BookingsModule,
    ConfigurationModule,
    NotificationEventsModule,
  ],
  controllers: [
    PaymentsController,
    PaymentWebhooksController,
    DevPaymentJobsController,
  ],
  providers: [PaymentsService, PaymentWebhooksService],
})
export class PaymentsModule {}
