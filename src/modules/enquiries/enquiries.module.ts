import { Module } from '@nestjs/common';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AdminEnquiriesController } from './admin-enquiries.controller.js';
import { EnquiriesController } from './enquiries.controller.js';
import { EnquiriesService } from './enquiries.service.js';

@Module({
  imports: [NotificationsModule],
  controllers: [EnquiriesController, AdminEnquiriesController],
  providers: [EnquiriesService],
  // For erasure (privacy module).
  exports: [EnquiriesService],
})
export class EnquiriesModule {}
