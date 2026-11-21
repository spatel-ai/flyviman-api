import { Module } from '@nestjs/common';
import { AirAmbulanceModule } from '../air-ambulance/air-ambulance.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { EmptyLegsModule } from '../empty-legs/empty-legs.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { SearchModule } from '../search/search.module.js';
import { AdminReportsController } from './admin-reports.controller.js';
import { ReportsService } from './reports.service.js';

/**
 * Reports and CSV exports (W5-1). Read-only: reaches other modules' data
 * only through their exported report services.
 */
@Module({
  imports: [
    AirAmbulanceModule,
    BookingsModule,
    EmptyLegsModule,
    OperatorsModule,
    PaymentsModule,
    PricingModule,
    SearchModule,
  ],
  controllers: [AdminReportsController],
  providers: [ReportsService],
})
export class ReportsModule {}
