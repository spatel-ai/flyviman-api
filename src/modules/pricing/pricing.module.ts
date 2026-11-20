import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import {
  AdminPriceCalculationsController,
  AdminPricingRulesController,
} from './admin-pricing.controller.js';
import { AdminPricingService } from './admin-pricing.service.js';
import { AdminCancellationTermsController } from './admin-cancellation-terms.controller.js';
import { CancellationTermsService } from './cancellation-terms.service.js';
import { OperatorPricingController } from './operator-pricing.controller.js';
import { OperatorPricingService } from './operator-pricing.service.js';
import { PricingService } from './pricing.service.js';

@Module({
  imports: [OperatorsModule, AircraftModule, AuditModule],
  controllers: [
    OperatorPricingController,
    AdminPricingRulesController,
    AdminPriceCalculationsController,
    AdminCancellationTermsController,
  ],
  providers: [
    PricingService,
    OperatorPricingService,
    AdminPricingService,
    CancellationTermsService,
  ],
  exports: [PricingService, CancellationTermsService],
})
export class PricingModule {}
