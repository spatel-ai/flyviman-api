import { Module } from '@nestjs/common';
import { RoutingModule } from '../../integrations/routing/routing.module.js';
import { AircraftModule } from '../aircraft/aircraft.module.js';
import { AvailabilityModule } from '../availability/availability.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { MatchingService } from './matching.service.js';

@Module({
  imports: [
    AircraftModule,
    AvailabilityModule,
    LocationsModule,
    OperatorsModule,
    RoutingModule,
  ],
  providers: [MatchingService],
  exports: [MatchingService],
})
export class MatchingModule {}
