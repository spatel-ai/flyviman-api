import { Module } from '@nestjs/common';
import { ContentModule } from '../content/content.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { AccountTokensService } from './account-tokens.service.js';
import { AdminUsersController } from './admin-users.controller.js';
import { ConsentsService } from './consents.service.js';
import { MeNotificationPreferencesController } from './me-notification-preferences.controller.js';
import { UsersService } from './users.service.js';

@Module({
  imports: [ContentModule, NotificationsModule],
  controllers: [AdminUsersController, MeNotificationPreferencesController],
  providers: [UsersService, ConsentsService, AccountTokensService],
  exports: [UsersService, ConsentsService, AccountTokensService],
})
export class UsersModule {}
