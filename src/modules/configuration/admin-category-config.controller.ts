import {
  Body,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
} from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import {
  CategoryConfigService,
  type CategoryConfigRow,
} from './category-config.service.js';
import {
  CategoryConfigResponseDto,
  UpdateCategoryConfigDto,
} from './dto/category-config.dto.js';

function toDto(row: CategoryConfigRow): CategoryConfigResponseDto {
  return {
    id: row.id,
    category: row.category,
    region: row.region,
    isEnabled: row.isEnabled,
    bookingMode: row.bookingMode,
    paymentModel: row.paymentModel,
    depositPercent: row.depositPercent,
    updatedAt: row.updatedAt.toISOString(),
  };
}

@ApiTags('admin: configuration')
@ApiCookieAuth()
@Roles(Role.OPS, Role.FINANCE_ADMIN, Role.SUPER_ADMIN)
@Controller('admin/category-config')
export class AdminCategoryConfigController {
  constructor(private readonly config: CategoryConfigService) {}

  @Get()
  @ApiOperation({
    summary: 'Service category configuration',
    description:
      'Platform booking mode, payment model and Model C deposit percent per category and region, by region then category. Super administrators change a row with `PATCH /admin/category-config/:id`.',
  })
  @ApiOkResponse({ type: [CategoryConfigResponseDto] })
  async list(): Promise<CategoryConfigResponseDto[]> {
    const rows = await this.config.list();
    return rows.map(toDto);
  }

  @Patch(':id')
  @Roles(Role.SUPER_ADMIN)
  @ApiOperation({
    summary: 'Change a service category configuration',
    description:
      'Changes whether a category is offered, its platform booking mode, payment model and Model C deposit percent; fields left out stay as they are. `reason` is required and the change is audited with before and after (`category_config.update`). 409 `CATEGORY_CONFIG_CHANGED` when the row changed since `expectedUpdatedAt` (its current `updatedAt` in `details`); 422 `CATEGORY_CONFIG_INVALID` for air ambulance on `INSTANT` (business rule 7); 404 for an unknown row. A disabled category is hidden from search and takes no new bookings or requests. New bookings use the new booking mode, payment model and deposit percent; each is saved on the booking, so bookings already made keep theirs. A change sending the current values writes nothing.',
  })
  @ApiOkResponse({ type: CategoryConfigResponseDto })
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() body: UpdateCategoryConfigDto,
  ): Promise<CategoryConfigResponseDto> {
    return toDto(await this.config.update(id, body));
  }
}
