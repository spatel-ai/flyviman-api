import { Module } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AvailabilityModule } from '../availability/availability.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { SearchModule } from '../search/search.module.js';
import { AdminChangeRequestsController } from './admin-change-requests.controller.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';
import { MeBookingsController } from './me-bookings.controller.js';
import { OperatorChangeRequestsController } from './operator-change-requests.controller.js';
import { TripsService } from './trips.service.js';

/**
 * Bookings (M8): creation from a search result, the customer's trips,
 * cancellation and change requests.
 */
@Module({
  imports: [
    SearchModule,
    AvailabilityModule,
    ConfigurationModule,
    CustomersModule,
    OperatorsModule,
  ],
  controllers: [
    BookingsController,
    MeBookingsController,
    OperatorChangeRequestsController,
    AdminChangeRequestsController,
  ],
  providers: [BookingsService, TripsService, FieldCipher],
  exports: [BookingsService],
})
export class BookingsModule {}
