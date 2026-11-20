import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD, DiscoveryModule } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import {
  RateLimitGuard,
  RateLimitIdentity,
} from '../../common/rate-limit/rate-limit.js';
import { CustomersModule } from '../customers/customers.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { UsersModule } from '../users/users.module.js';
import { UsersService } from '../users/users.service.js';
import { AdminRolesController } from './admin-roles.controller.js';
import { AuthController } from './auth.controller.js';
import { CsrfGuard, JwtAuthGuard, RolesGuard } from './auth.guards.js';
import { AuthService } from './auth.service.js';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { LoginFailures } from './login-failures.js';
import { RefreshRotations } from './refresh-rotations.js';
import { RefreshSuccessors } from './refresh-successors.js';
import { RegistrationService } from './registration.service.js';
import { SessionRateLimitIdentity } from './session-rate-limit-identity.js';
import { TokenService } from './token.service.js';
import { VerificationService } from './verification.service.js';

@Module({
  imports: [
    DiscoveryModule,
    UsersModule,
    CustomersModule,
    NotificationsModule,
    JwtModule.registerAsync({
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_ACCESS_SECRET'),
        signOptions: {
          algorithm: 'HS256',
          expiresIn: config.getOrThrow<number>('ACCESS_TOKEN_TTL_SECONDS'),
        },
        verifyOptions: { algorithms: ['HS256'] },
      }),
    }),
  ],
  controllers: [AuthController, AdminRolesController],
  providers: [
    AuthService,
    TokenService,
    LoginFailures,
    RefreshSuccessors,
    RefreshRotations,
    FieldCipher,
    VerificationService,
    RegistrationService,
    { provide: RateLimitIdentity, useClass: SessionRateLimitIdentity },
    // Global guards run in this order on every request.
    { provide: APP_GUARD, useClass: RateLimitGuard },
    { provide: APP_GUARD, useClass: CsrfGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
  // AuthService for revokeAllSessions (operator staff suspension, D-068).
  exports: [VerificationService, AuthService],
})
export class AuthModule implements OnModuleInit {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  onModuleInit(): void {
    // An administrator's suspension ends every sign-in of the account at
    // once, in the suspension's own transaction.
    this.users.registerSessionRevoker((userId, db) =>
      this.auth.revokeAllSessions(userId, db),
    );
  }
}
