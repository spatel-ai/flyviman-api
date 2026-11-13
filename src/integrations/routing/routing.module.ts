import { Module } from '@nestjs/common';
import {
  GreatCircleRoutingProvider,
  RoutingProvider,
} from './routing.provider.js';

@Module({
  providers: [
    { provide: RoutingProvider, useClass: GreatCircleRoutingProvider },
  ],
  exports: [RoutingProvider],
})
export class RoutingModule {}
