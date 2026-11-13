import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminOperatorsController } from './admin-operators.controller.js';
import { OperatorController } from './operator.controller.js';
import { OperatorStaffController } from './operator-staff.controller.js';
import { OperatorStaffService } from './operator-staff.service.js';
import { OperatorsService } from './operators.service.js';

@Module({
  imports: [UsersModule, AuthModule, DocumentsModule, NotificationsModule],
  controllers: [
    OperatorController,
    OperatorStaffController,
    AdminOperatorsController,
  ],
  providers: [OperatorsService, OperatorStaffService],
  exports: [OperatorsService],
})
export class OperatorsModule {}
