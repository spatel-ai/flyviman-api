import { Module } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { NotificationEventsModule } from '../notifications/events/notification-events.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminAirAmbulanceController } from './admin-air-ambulance.controller.js';
import { AirAmbulanceController } from './air-ambulance.controller.js';
import { AirAmbulanceService } from './air-ambulance.service.js';
import { AirAmbulanceWorkflowService } from './air-ambulance-workflow.service.js';

/** Owns AirAmbulanceRequest, AirAmbulanceMedical, its timeline and documents. */
@Module({
  imports: [
    OperatorsModule,
    LocationsModule,
    DocumentsModule,
    UsersModule,
    NotificationEventsModule,
  ],
  controllers: [AirAmbulanceController, AdminAirAmbulanceController],
  providers: [AirAmbulanceService, AirAmbulanceWorkflowService, FieldCipher],
  exports: [AirAmbulanceService],
})
export class AirAmbulanceModule {}
