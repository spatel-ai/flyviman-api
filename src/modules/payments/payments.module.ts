import { Module } from '@nestjs/common';
import { PaymentModule } from '../../integrations/payment/payment.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { AdminPaymentsController } from './admin-payments.controller.js';
import { AdminSettlementsController } from './admin-settlements.controller.js';
import { DevPaymentJobsController } from './dev-payment-jobs.controller.js';
import { NotificationEventsModule } from '../notifications/events/notification-events.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { OperatorSettlementsController } from './operator-settlements.controller.js';
import { PaymentWebhooksController } from './payment-webhooks.controller.js';
import { PaymentWebhooksService } from './payment-webhooks.service.js';
import { PaymentsController } from './payments.controller.js';
import { PaymentsService } from './payments.service.js';
import { ReceiptsService } from './receipts.service.js';
import { ReconciliationService } from './reconciliation.service.js';
import { RefundsService } from './refunds.service.js';
import { SettlementsService } from './settlements.service.js';

/**
 * Payments (M9): orders, checkout results, gateway notifications, the
 * status sweep, refunds, receipts, operator settlements and reconciliation.
 */
@Module({
  imports: [
    PaymentModule,
    BookingsModule,
    ConfigurationModule,
    NotificationEventsModule,
    OperatorsModule,
    PricingModule,
  ],
  controllers: [
    PaymentsController,
    PaymentWebhooksController,
    AdminPaymentsController,
    AdminSettlementsController,
    OperatorSettlementsController,
    DevPaymentJobsController,
  ],
  providers: [
    PaymentsService,
    PaymentWebhooksService,
    RefundsService,
    ReceiptsService,
    SettlementsService,
    ReconciliationService,
  ],
})
export class PaymentsModule {}
