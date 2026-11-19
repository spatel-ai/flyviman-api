import { Module } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AvailabilityModule } from '../availability/availability.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { SearchModule } from '../search/search.module.js';
import { BookingsController } from './bookings.controller.js';
import { BookingsService } from './bookings.service.js';

/** Bookings (M8): creation from a search result and the customer's reads. */
@Module({
  imports: [
    SearchModule,
    AvailabilityModule,
    ConfigurationModule,
    CustomersModule,
  ],
  controllers: [BookingsController],
  providers: [BookingsService, FieldCipher],
  exports: [BookingsService],
})
export class BookingsModule {}
