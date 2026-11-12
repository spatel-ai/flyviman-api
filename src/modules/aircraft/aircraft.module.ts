import { Module } from '@nestjs/common';
import { DocumentsModule } from '../documents/documents.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { AdminAircraftController } from './admin-aircraft.controller.js';
import { AircraftService } from './aircraft.service.js';
import { OperatorAircraftController } from './operator-aircraft.controller.js';

@Module({
  imports: [
    OperatorsModule,
    DocumentsModule,
    LocationsModule,
    NotificationsModule,
  ],
  controllers: [OperatorAircraftController, AdminAircraftController],
  providers: [AircraftService],
  exports: [AircraftService],
})
export class AircraftModule {}
