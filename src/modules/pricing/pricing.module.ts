import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { OperatorPricingController } from './operator-pricing.controller.js';
import { OperatorPricingService } from './operator-pricing.service.js';
import { PricingService } from './pricing.service.js';

@Module({
  imports: [OperatorsModule, AuditModule],
  controllers: [OperatorPricingController],
  providers: [PricingService, OperatorPricingService],
  exports: [PricingService],
})
export class PricingModule {}
