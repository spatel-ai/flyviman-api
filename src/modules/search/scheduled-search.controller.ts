import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SearchRateLimit } from '../../common/rate-limit/rate-limit.js';
import { Public } from '../auth/auth.decorators.js';
import {
  RevalidateScheduledDto,
  ScheduledFareRulesDto,
  ScheduledRevalidationDto,
  ScheduledSearchDto,
  ScheduledSearchResponseDto,
} from './dto/scheduled-search.dto.js';
import { ScheduledSearchService } from './scheduled-search.service.js';

/**
 * Scheduled airline search (M6). Public. Every fare is a `LIVE_FARE`
 * (rule 1) and is rechecked by revalidation before payment (rule 3). The
 * routes that call a supplier are on the search rate tier; reading a
 * stored search is on the default tier. A search expires with its fares
 * (AIRLINE_OFFER_TTL_MINUTES) and then answers 404.
 */
@ApiTags('search')
@Public()
@Controller('search/scheduled')
export class ScheduledSearchController {
  constructor(private readonly scheduled: ScheduledSearchService) {}

  @Post()
  @SearchRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Search scheduled flights across airline suppliers',
    description:
      "Suppliers are called in parallel, each with a timeout. One that times out or fails is listed in `providers` and `partial` is true; the others' fares are still returned. 422 `CATEGORY_DISABLED` while the platform has scheduled flights switched off.",
  })
  @ApiOkResponse({ type: ScheduledSearchResponseDto })
  search(@Body() dto: ScheduledSearchDto): Promise<ScheduledSearchResponseDto> {
    return this.scheduled.search(dto, null);
  }

  // Before ':searchId' routes, though the segment counts differ anyway.
  @Post('revalidate')
  @SearchRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Recheck the fare and seats of a selected flight',
    description:
      'A changed fare is returned, never hidden. 503 `SEARCH_PROVIDER_UNAVAILABLE` when the airline does not answer.',
  })
  @ApiOkResponse({ type: ScheduledRevalidationDto })
  revalidate(
    @Body() dto: RevalidateScheduledDto,
  ): Promise<ScheduledRevalidationDto> {
    return this.scheduled.revalidate(dto);
  }

  @Get(':searchId')
  @ApiOperation({
    summary: 'A stored scheduled search and its results (404 once expired)',
  })
  @ApiOkResponse({ type: ScheduledSearchResponseDto })
  get(
    @Param('searchId', ParseUUIDPipe) searchId: string,
  ): Promise<ScheduledSearchResponseDto> {
    return this.scheduled.get(searchId);
  }

  @Get(':searchId/offers/:offerId/fare-rules')
  @SearchRateLimit()
  @ApiOperation({
    summary: 'Fare rules of one offer: baggage, cancellation and changes',
  })
  @ApiOkResponse({ type: ScheduledFareRulesDto })
  fareRules(
    @Param('searchId', ParseUUIDPipe) searchId: string,
    @Param('offerId', ParseUUIDPipe) offerId: string,
  ): Promise<ScheduledFareRulesDto> {
    return this.scheduled.fareRules(searchId, offerId);
  }
}
