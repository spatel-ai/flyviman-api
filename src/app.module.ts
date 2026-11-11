import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { validateEnv } from './config/env.validation.js';
import { PrismaModule } from './prisma/prisma.module.js';
import { HealthModule } from './modules/health/health.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { UsersModule } from './modules/users/users.module.js';
import { CustomersModule } from './modules/customers/customers.module.js';
import { OperatorsModule } from './modules/operators/operators.module.js';
import { AircraftModule } from './modules/aircraft/aircraft.module.js';
import { AvailabilityModule } from './modules/availability/availability.module.js';
import { LocationsModule } from './modules/locations/locations.module.js';
import { EmptyLegsModule } from './modules/empty-legs/empty-legs.module.js';
import { SearchModule } from './modules/search/search.module.js';
import { MatchingModule } from './modules/matching/matching.module.js';
import { PricingModule } from './modules/pricing/pricing.module.js';
import { QuotesModule } from './modules/quotes/quotes.module.js';
import { BookingsModule } from './modules/bookings/bookings.module.js';
import { PaymentsModule } from './modules/payments/payments.module.js';
import { AirAmbulanceModule } from './modules/air-ambulance/air-ambulance.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { ContentModule } from './modules/content/content.module.js';
import { ReportsModule } from './modules/reports/reports.module.js';
import { AuditModule } from './modules/audit/audit.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, validate: validateEnv }),
    PrismaModule,
    HealthModule,
    AuthModule,
    UsersModule,
    CustomersModule,
    OperatorsModule,
    AircraftModule,
    AvailabilityModule,
    LocationsModule,
    EmptyLegsModule,
    SearchModule,
    MatchingModule,
    PricingModule,
    QuotesModule,
    BookingsModule,
    PaymentsModule,
    AirAmbulanceModule,
    NotificationsModule,
    DocumentsModule,
    ContentModule,
    ReportsModule,
    AuditModule,
  ],
})
export class AppModule {}
