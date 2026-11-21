import { Module } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AircraftModule } from '../aircraft/aircraft.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { NotificationEventsModule } from '../notifications/events/notification-events.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { UsersModule } from '../users/users.module.js';
import {
  AdminAirAmbulanceController,
  AdminAirAmbulanceOperatorsController,
} from './admin-air-ambulance.controller.js';
import { OperatorAirAmbulanceController } from './operator-air-ambulance.controller.js';
import { AirAmbulanceController } from './air-ambulance.controller.js';
import { AirAmbulanceService } from './air-ambulance.service.js';
import { AirAmbulanceWorkflowService } from './air-ambulance-workflow.service.js';
import { AirAmbulanceErasureService } from './air-ambulance-erasure.service.js';
import { AirAmbulanceReportsService } from './air-ambulance-reports.service.js';

/** Owns AirAmbulanceRequest, AirAmbulanceMedical, its timeline and documents. */
@Module({
  imports: [
    AircraftModule,
    ConfigurationModule,
    OperatorsModule,
    LocationsModule,
    DocumentsModule,
    UsersModule,
    NotificationEventsModule,
  ],
  controllers: [
    AirAmbulanceController,
    AdminAirAmbulanceController,
    AdminAirAmbulanceOperatorsController,
    OperatorAirAmbulanceController,
  ],
  providers: [
    AirAmbulanceService,
    AirAmbulanceWorkflowService,
    AirAmbulanceReportsService,
    AirAmbulanceErasureService,
    FieldCipher,
  ],
  exports: [
    AirAmbulanceService,
    AirAmbulanceReportsService,
    AirAmbulanceErasureService,
  ],
})
export class AirAmbulanceModule {}
