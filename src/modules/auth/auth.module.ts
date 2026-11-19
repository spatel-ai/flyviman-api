import { Module, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';
import { RateLimitGuard } from '../../common/rate-limit/rate-limit.js';
import { CustomersModule } from '../customers/customers.module.js';
import { NotificationsModule } from '../notifications/notifications.module.js';
import { UsersModule } from '../users/users.module.js';
import { UsersService } from '../users/users.service.js';
import { AuthController } from './auth.controller.js';
import { ACCESS_COOKIE, REFRESH_COOKIE } from './auth.cookies.js';
import { CsrfGuard, JwtAuthGuard, RolesGuard } from './auth.guards.js';
import { AuthService } from './auth.service.js';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { LoginFailures } from './login-failures.js';
import { RefreshRotations } from './refresh-rotations.js';
import { RefreshSuccessors } from './refresh-successors.js';
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
    RefreshSuccessors,
    RefreshRotations,
    FieldCipher,
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
  constructor(
    private readonly tokens: TokenService,
    private readonly auth: AuthService,
    private readonly users: UsersService,
  ) {}

  onModuleInit(): void {
    // An administrator's suspension ends every sign-in of the account at
    // once, in the suspension's own transaction.
    this.users.registerSessionRevoker((userId, db) =>
      this.auth.revokeAllSessions(userId, db),
    );
    // Racing refreshes of one token (a page's link prefetches after an idle
    // spell) are not counted: only one can rotate it, and the rest receive
    // the same pair, at most REFRESH_REPLAY_MAX times (D-111). A refresh
    // with no cookie is still counted by address.
    RateLimitGuard.exempt = async (request) => {
      if (!String(request.path ?? '').endsWith('/auth/refresh')) return false;
      const refresh = (
        (request.cookies ?? {}) as Record<string, string | undefined>
      )[REFRESH_COOKIE];
      return refresh
        ? this.auth.isRefreshInPlay(refresh).catch(() => false)
        : false;
    };
    // How the rate limiter recognises a session (see RateLimitGuard):
    // - a refresh is counted against the refresh token presented when that
    //   token belongs to a session. A token that matches none (made up, or
    //   unreadable) is counted by address, so inventing a new token each
    //   time does not get a fresh allowance.
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
        if (!refresh) return null;
        const known = await this.auth
          .isRefreshKnown(refresh)
          .catch(() => false);
        return known ? `refresh:${this.tokens.hashToken(refresh)}` : null;
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
