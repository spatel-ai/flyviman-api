import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { SearchRateLimit } from '../../common/rate-limit/rate-limit.js';
import { Public } from '../auth/auth.decorators.js';
import {
  CharterSearchDto,
  HelicopterSearchDto,
  SearchResponseDto,
  SearchResultDetailDto,
} from './dto/search.dto.js';
import {
  FareCalendarQueryDto,
  FareCalendarResponseDto,
} from './dto/calendar.dto.js';
import { SearchService } from './search.service.js';

/**
 * Charter and helicopter search (M5). Every price is an `ESTIMATE` (business
 * rule 1); only approved inventory is offered (rule 4). Public. Searching
 * and the calendar are on the search rate tier; reading a stored search is
 * on the default tier.
 */
@ApiTags('search')
@Public()
@Controller('search')
export class SearchController {
  constructor(private readonly search: SearchService) {}

  @Post('charter')
  @SearchRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Search eligible charter aircraft with estimates' })
  @ApiOkResponse({ type: SearchResponseDto })
  charter(@Body() dto: CharterSearchDto): Promise<SearchResponseDto> {
    return this.search.search('PRIVATE_CHARTER', dto, null);
  }

  @Post('helicopter')
  @SearchRateLimit()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Search helicopter options with estimates' })
  @ApiOkResponse({ type: SearchResponseDto })
  helicopter(@Body() dto: HelicopterSearchDto): Promise<SearchResponseDto> {
    return this.search.search('HELICOPTER', dto, null);
  }

  // Before ':searchId', which would otherwise take "calendar" as an id.
  @Get('calendar')
  @SearchRateLimit()
  @ApiOperation({
    summary: 'Lowest estimate and aircraft count for each day of a month',
  })
  @ApiOkResponse({ type: FareCalendarResponseDto })
  calendar(
    @Query() query: FareCalendarQueryDto,
  ): Promise<FareCalendarResponseDto> {
    return this.search.calendar(query);
  }

  @Get(':searchId')
  @ApiOperation({ summary: 'A stored search and its results' })
  @ApiOkResponse({ type: SearchResponseDto })
  get(
    @Param('searchId', ParseUUIDPipe) searchId: string,
  ): Promise<SearchResponseDto> {
    return this.search.get(searchId);
  }

  @Get(':searchId/results/:resultId')
  @ApiOperation({ summary: 'One result with its breakdown and conditions' })
  @ApiOkResponse({ type: SearchResultDetailDto })
  result(
    @Param('searchId', ParseUUIDPipe) searchId: string,
    @Param('resultId', ParseUUIDPipe) resultId: string,
  ): Promise<SearchResultDetailDto> {
    return this.search.result(searchId, resultId);
  }
}
