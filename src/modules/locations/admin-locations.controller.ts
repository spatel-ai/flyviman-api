import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiCreatedResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Paginated } from '../../common/dto/paginated.js';
import { Role } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import {
  AdminListLocationsDto,
  AdminLocationResponseDto,
  CreateLocationDto,
  UpdateLocationDto,
} from './dto/admin-location.dto.js';
import {
  createInput,
  toAdminLocationDto,
  updateInput,
} from './location.mappers.js';
import { LocationsService } from './locations.service.js';

@ApiTags('admin: locations')
@ApiCookieAuth()
@Roles(Role.OPS, Role.SUPER_ADMIN)
@Controller('admin/locations')
export class AdminLocationsController {
  constructor(private readonly locations: LocationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List locations',
    description: 'Active and inactive, with charges, by name.',
  })
  @ApiOkResponse({ type: [AdminLocationResponseDto] })
  async list(
    @Query() query: AdminListLocationsDto,
  ): Promise<Paginated<AdminLocationResponseDto>> {
    const result = await this.locations.adminList(query);
    return new Paginated(
      result.items.map(toAdminLocationDto),
      result.page,
      result.pageSize,
      result.total,
    );
  }

  @Get(':id')
  @ApiOperation({ summary: 'One location, with charges' })
  @ApiOkResponse({ type: AdminLocationResponseDto })
  async detail(
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AdminLocationResponseDto> {
    return toAdminLocationDto(await this.locations.adminGet(id));
  }

  @Post()
  @ApiOperation({
    summary: 'Add a location',
    description:
      'Audited. IATA and ICAO codes are stored in capitals and must be unique (409 `LOCATION_CODE_IN_USE`).',
  })
  @ApiCreatedResponse({ type: AdminLocationResponseDto })
  async create(
    @Body() body: CreateLocationDto,
  ): Promise<AdminLocationResponseDto> {
    return toAdminLocationDto(await this.locations.create(createInput(body)));
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Change a location, its capabilities or charges',
    description:
      'Send only the fields to change. Audited with the values before and after. `isActive: false` hides the location from search and from new trips.',
  })
  @ApiOkResponse({ type: AdminLocationResponseDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateLocationDto,
  ): Promise<AdminLocationResponseDto> {
    return toAdminLocationDto(
      await this.locations.update(id, updateInput(body)),
    );
  }
}
