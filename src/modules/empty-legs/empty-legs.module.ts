import { Module } from '@nestjs/common';
import { AircraftModule } from '../aircraft/aircraft.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { OperatorsModule } from '../operators/operators.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminEmptyLegsController } from './admin-empty-legs.controller.js';
import { DevEmptyLegsController } from './dev-empty-legs.controller.js';
import { EmptyLegsController } from './empty-legs.controller.js';
import { EmptyLegsService } from './empty-legs.service.js';
import { OperatorEmptyLegsController } from './operator-empty-legs.controller.js';

/** Empty-leg offers, review, listing, interest and expiry (M7). */
@Module({
  imports: [
    OperatorsModule,
    AircraftModule,
    LocationsModule,
    UsersModule,
    NotificationsModule,
    PricingModule,
  ],
  controllers: [
    EmptyLegsController,
    OperatorEmptyLegsController,
    AdminEmptyLegsController,
    DevEmptyLegsController,
  ],
  providers: [EmptyLegsService],
  exports: [EmptyLegsService],
})
export class EmptyLegsModule {}
