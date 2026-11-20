import { Module } from '@nestjs/common';
import { OperatorsModule } from '../../operators/operators.module.js';
import { UsersModule } from '../../users/users.module.js';
import { NotificationsModule } from '../notifications.module.js';
import { NotificationEventsService } from './notification-events.service.js';

/**
 * The notification matrix in use (M10). A module of its own, above users,
 * operators and notifications, because the first two depend on the third.
 */
@Module({
  imports: [NotificationsModule, UsersModule, OperatorsModule],
  providers: [NotificationEventsService],
  exports: [NotificationEventsService],
})
export class NotificationEventsModule {}
