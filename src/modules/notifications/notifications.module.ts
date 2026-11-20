import { Module } from '@nestjs/common';
import { MessagingModule } from '../../integrations/messaging/messaging.module.js';
import { DevNotificationsController } from './dev-notifications.controller.js';
import { MeNotificationsController } from './me-notifications.controller.js';
import { NotificationsService } from './notifications.service.js';

@Module({
  imports: [MessagingModule],
  controllers: [MeNotificationsController, DevNotificationsController],
  providers: [NotificationsService],
  exports: [NotificationsService],
})
export class NotificationsModule {}
