import { Module } from '@nestjs/common';
import { AirlineModule } from '../../integrations/airline/airline.module.js';
import { RoutingModule } from '../../integrations/routing/routing.module.js';
import { ConfigurationModule } from '../configuration/configuration.module.js';
import { EmptyLegsModule } from '../empty-legs/empty-legs.module.js';
import { LocationsModule } from '../locations/locations.module.js';
import { MatchingModule } from '../matching/matching.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { ScheduledSearchController } from './scheduled-search.controller.js';
import { ScheduledSearchService } from './scheduled-search.service.js';
import { SearchController } from './search.controller.js';
import { SearchService } from './search.service.js';

@Module({
  imports: [
    AirlineModule,
    ConfigurationModule,
    EmptyLegsModule,
    LocationsModule,
    MatchingModule,
    PricingModule,
    RoutingModule,
  ],
  // Scheduled first, so `search/scheduled/…` never reaches `search/:searchId`.
  controllers: [ScheduledSearchController, SearchController],
  providers: [SearchService, ScheduledSearchService],
  exports: [SearchService],
})
export class SearchModule {}
