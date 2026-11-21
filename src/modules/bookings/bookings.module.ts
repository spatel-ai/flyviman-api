import { Module } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AvailabilityModule } from '../availability/availability.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { NotificationEventsModule } from '../notifications/events/notification-events.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { QuotesModule } from '../quotes/quotes.module.js';
import { SearchModule } from '../search/search.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminBookingsController } from './admin-bookings.controller.js';
import { AdminBookingsService } from './admin-bookings.service.js';
import { AdminChangeRequestsController } from './admin-change-requests.controller.js';
import { AdminPriceOverrideController } from './admin-price-override.controller.js';
import { BookingPassengersService } from './booking-passengers.service.js';
import { BookingRequestsService } from './booking-requests.service.js';
import { BookingRevalidationService } from './booking-revalidation.service.js';
import { BookingSelfServiceController } from './booking-self-service.controller.js';
import { BookingTimelineService } from './booking-timeline.service.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { ChangeRequestListsService } from './change-request-lists.service.js';
import {
  BookingConversationController,
  CustomerQuotesController,
} from './customer-quotes.controller.js';
import { DevBookingJobsController } from './dev-booking-jobs.controller.js';
import { MeBookingsController } from './me-bookings.controller.js';
import { OperatorBookingRequestsController } from './operator-booking-requests.controller.js';
import { OperatorChangeRequestsController } from './operator-change-requests.controller.js';
import { TripsService } from './trips.service.js';

/**
 * Bookings (M8): creation from a search result and the customer's reads;
 * the customer's trips, cancellation and change requests; the operator's
 * request inbox, quotes and answers, and the hold-expiry job; the
 * confirmation rule; bookings and change requests for Flyviman staff.
 */
@Module({
  imports: [
    SearchModule,
    AvailabilityModule,
    ConfigurationModule,
    CustomersModule,
    QuotesModule,
    OperatorsModule,
    PricingModule,
    UsersModule,
    NotificationsModule,
    PricingModule,
    NotificationEventsModule,
  ],
  controllers: [
    BookingsController,
    MeBookingsController,
    OperatorChangeRequestsController,
    AdminChangeRequestsController,
    AdminBookingsController,
    AdminPriceOverrideController,
    BookingConversationController,
    CustomerQuotesController,
    OperatorBookingRequestsController,
    DevBookingJobsController,
    BookingSelfServiceController,
  ],
  providers: [
    BookingsService,
    TripsService,
    BookingRequestsService,
    AdminBookingsService,
    ChangeRequestListsService,
    FieldCipher,
    BookingTimelineService,
    BookingPassengersService,
    BookingRevalidationService,
  ],
  exports: [BookingsService],
})
export class BookingsModule {}
