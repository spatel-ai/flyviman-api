import { Module } from '@nestjs/common';
import { OperatorsModule } from '../operators/operators.module.js';
import { AdminCategoryConfigController } from './admin-category-config.controller.js';
import { CategoryConfigService } from './category-config.service.js';

/** Platform configuration: booking mode and payment model per category (C2). */
@Module({
  imports: [OperatorsModule],
  controllers: [AdminCategoryConfigController],
  providers: [CategoryConfigService],
  exports: [CategoryConfigService],
})
export class ConfigurationModule {}
