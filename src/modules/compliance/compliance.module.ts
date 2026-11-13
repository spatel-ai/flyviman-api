import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { AdminComplianceController } from './admin-compliance.controller.js';
import { ComplianceService } from './compliance.service.js';
import { DevComplianceController } from './dev-compliance.controller.js';

/** Document expiry alerts and the expiring-documents list (M3 step 8). */
@Module({
  imports: [OperatorsModule, AircraftModule, NotificationsModule],
  controllers: [AdminComplianceController, DevComplianceController],
  providers: [ComplianceService],
})
export class ComplianceModule {}
