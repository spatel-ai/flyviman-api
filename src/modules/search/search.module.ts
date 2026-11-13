import { Module } from '@nestjs/common';
import { RoutingModule } from '../../integrations/routing/routing.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { MatchingModule } from '../matching/matching.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [LocationsModule, MatchingModule, PricingModule, RoutingModule],
  controllers: [SearchController],
  providers: [SearchService],
})
export class SearchModule {}
