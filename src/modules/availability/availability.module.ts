import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { AvailabilityController } from './availability.controller.js';
import { AvailabilityService } from './availability.service.js';

@Module({
  imports: [OperatorsModule, AircraftModule, LocationsModule],
  controllers: [AvailabilityController],
  providers: [AvailabilityService],
  exports: [AvailabilityService],
})
export class AvailabilityModule {}
