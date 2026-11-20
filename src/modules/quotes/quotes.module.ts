import { Module } from '@nestjs/common';
import { QuotesService } from './quotes.service.js';

/**
 * Quotes (M8): owns the `Quote` table. Its routes live with the booking
 * flow that drives them (bookings module), which uses this service.
 */
@Module({
  providers: [QuotesService],
  exports: [QuotesService],
})
export class QuotesModule {}
