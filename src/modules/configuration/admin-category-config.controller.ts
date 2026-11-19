import { Controller, Get } from '@nestjs/common';
import {
  ApiCookieAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Role } from '../../generated/prisma/enums.js';
import { Roles } from '../auth/auth.decorators.js';
import { CategoryConfigService } from './category-config.service.js';
import { CategoryConfigResponseDto } from './dto/category-config.dto.js';

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
      'Platform booking mode and payment model per category and region, by region then category. Read only until M10.',
  })
  @ApiOkResponse({ type: [CategoryConfigResponseDto] })
  async list(): Promise<CategoryConfigResponseDto[]> {
    const rows = await this.config.list();
    return rows.map((row) => ({
      category: row.category,
      region: row.region,
      isEnabled: row.isEnabled,
      bookingMode: row.bookingMode,
      paymentModel: row.paymentModel,
      updatedAt: row.updatedAt.toISOString(),
    }));
  }
}
