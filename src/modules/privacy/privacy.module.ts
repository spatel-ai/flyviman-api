import { Module } from '@nestjs/common';
import { AirAmbulanceModule } from '../air-ambulance/air-ambulance.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { BookingsModule } from '../bookings/bookings.module.js';
import { CustomersModule } from '../customers/customers.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { EmptyLegsModule } from '../empty-legs/empty-legs.module.js';
import { EnquiriesModule } from '../enquiries/enquiries.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { PaymentsModule } from '../payments/payments.module.js';
import { UsersModule } from '../users/users.module.js';
import { AdminErasureController } from './admin-erasure.controller.js';
import { ErasureService } from './erasure.service.js';
import { MeErasureController } from './me-erasure.controller.js';

/**
 * Erasure of a customer's personal data (W5-8b). Owns no table: it decides
 * whether an account may be erased and runs one transaction in which each
 * owning module scrubs its own records. Nothing depends on it.
 */
@Module({
  imports: [
    UsersModule,
    AuthModule,
    CustomersModule,
    BookingsModule,
    PaymentsModule,
    AirAmbulanceModule,
    DocumentsModule,
    NotificationsModule,
    EnquiriesModule,
    EmptyLegsModule,
  ],
  controllers: [MeErasureController, AdminErasureController],
  providers: [ErasureService],
})
export class PrivacyModule {}
