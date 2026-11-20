import { Module } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AvailabilityModule } from '../availability/availability.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { QuotesModule } from '../quotes/quotes.module.js';
import { SearchModule } from '../search/search.module.js';
import { UsersModule } from '../users/users.module.js';
import { BookingRequestsService } from './booking-requests.service.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import {
  BookingConversationController,
  CustomerQuotesController,
} from './customer-quotes.controller.js';
import { DevBookingJobsController } from './dev-booking-jobs.controller.js';
import { OperatorBookingRequestsController } from './operator-booking-requests.controller.js';

/**
 * Bookings (M8): creation from a search result and the customer's reads;
 * the operator's request inbox, quotes and answers, and the hold-expiry job.
 */
@Module({
  imports: [
    SearchModule,
    AvailabilityModule,
    ConfigurationModule,
    CustomersModule,
    QuotesModule,
    OperatorsModule,
    UsersModule,
    NotificationsModule,
  ],
  controllers: [
    BookingsController,
    BookingConversationController,
    CustomerQuotesController,
    OperatorBookingRequestsController,
    DevBookingJobsController,
  ],
  providers: [BookingsService, BookingRequestsService, FieldCipher],
  exports: [BookingsService],
})
export class BookingsModule {}
