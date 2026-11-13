import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { RateLimitGuard } from '../../common/rate-limit/rate-limit.js';
import { CustomersModule } from '../customers/customers.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { UsersModule } from '../users/users.module.js';
import { AuthController } from './auth.controller.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.cookies.js';
import { CsrfGuard, JwtAuthGuard, RolesGuard } from './auth.guards.js';
import { AuthService } from './auth.service.js';
import { LoginFailures } from './login-failures.js';
import { RegistrationService } from './registration.service.js';
import { TokenService } from './token.service.js';
import { VerificationService } from './verification.service.js';

@Module({
  imports: [
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
  controllers: [AuthController],
  providers: [
    AuthService,
    TokenService,
    LoginFailures,
    VerificationService,
    RegistrationService,
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
  constructor(private readonly tokens: TokenService) {}

  onModuleInit(): void {
    // How the rate limiter recognises a session (see RateLimitGuard):
    // - a refresh is counted against the refresh token presented. A made-up
    //   token gets its own counter, which is harmless: it cannot be guessed
    //   and is refused after one indexed lookup.
    // - any other request with an access token whose signature verifies is
    //   counted against that user. Sign-in and registration never carry one
    //   that matters, so they stay counted by address.
    RateLimitGuard.identify = async (request) => {
      const cookies = (request.cookies ?? {}) as Record<
        string,
        string | undefined
      >;
      const path = String(request.path ?? '');
      if (path.endsWith('/auth/refresh')) {
        const refresh = cookies[REFRESH_COOKIE];
        return refresh ? `refresh:${this.tokens.hashToken(refresh)}` : null;
      }
      if (path.includes('/auth/')) return null;
      const access = cookies[ACCESS_COOKIE];
      const claims = access
        ? await this.tokens.verifyAccessToken(access)
        : null;
      return claims ? `user:${claims.sub}` : null;
    };
  }
}
