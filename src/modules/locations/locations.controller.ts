import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Public } from '../auth/auth.decorators.js';
import { ListLocationsDto, LocationResponseDto } from './dto/location.dto.js';
import { toLocationDto } from './location.mappers.js';
import { LocationsService } from './locations.service.js';

@ApiTags('locations')
@Public()
@Controller('locations')
export class LocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Search airports and heliports',
    description:
      'Active locations only. Without `q`, lists them by name, airports first.',
  })
  @ApiOkResponse({ type: [LocationResponseDto] })
  async search(
    @Query() query: ListLocationsDto,
  ): Promise<Paginated<LocationResponseDto>> {
    const result = await this.locations.search(query);
    return new Paginated(
      result.items.map(toLocationDto),
      result.page,
      result.pageSize,
      result.total,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One location' })
  @ApiOkResponse({ type: LocationResponseDto })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<LocationResponseDto> {
    return toLocationDto(await this.locations.getActive(id));
  }
}
