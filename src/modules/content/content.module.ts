import { Module } from '@nestjs/common';
import {
  AdminBannersController,
  AdminFaqsController,
  AdminPoliciesController,
} from './admin-content.controller.js';
import { AdminContentService } from './admin-content.service.js';
import { ContentController } from './content.controller.js';
import { ContentService } from './content.service.js';

@Module({
  controllers: [
    ContentController,
    AdminBannersController,
    AdminFaqsController,
    AdminPoliciesController,
  ],
  providers: [ContentService, AdminContentService],
  exports: [ContentService],
})
export class ContentModule {}
