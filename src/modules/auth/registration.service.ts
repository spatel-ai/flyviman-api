import { HttpStatus, Injectable, OnModuleInit } from '@nestjs/common';
import { AppException } from '../../common/errors/app.exception.js';
import { uniqueOrNull } from '../../common/errors/unique.js';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import {
  ACCOUNT_TOKEN_TTL_SECONDS,
  AccountTokensService,
} from '../users/account-tokens.service.js';
import { ConsentsService } from '../users/consents.service.js';
import {
  Identifier,
  UserAccount,
  UsersService,
} from '../users/users.service.js';
import { AuthService, ClientInfo } from './auth.service.js';
import type { SessionTokens } from './auth.cookies.js';
import { LoginFailures } from './login-failures.js';
import {
  assertAcceptablePassword,
  hashPassword,
} from '../../common/crypto/password.js';
import {
  PendingRegistration,
  VerificationSent,
  VerificationService,
} from './verification.service.js';

export type { VerificationSent };

interface PendingCustomer extends PendingRegistration {
  kind: 'customer';
  firstName: string;
  lastName: string;
  passwordHash: string | null;
}

/**
 * Registration, verification and password recovery. Every public answer is
 * the same whether or not an account exists, so none of these routes can be
 * used to find out who is registered.
 */
@Injectable()
export class RegistrationService implements OnModuleInit {
  constructor(
    private readonly prisma: PrismaService,
    private readonly users: UsersService,
    private readonly customers: CustomersService,
    private readonly consents: ConsentsService,
    private readonly verification: VerificationService,
    private readonly accountTokens: AccountTokensService,
    private readonly notifications: NotificationsService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly failures: LoginFailures,
  ) {}

  onModuleInit(): void {
    this.verification.registerCompletion('customer', (pending, identifier) =>
      this.createCustomer(pending as PendingCustomer, identifier),
    );
  }

  /**
   * Starts a customer registration. Nothing is stored in the database until
   * the code is verified; what was entered travels with the verification
   * attempt, so only the browser that registered can complete it.
   */
  async registerCustomer(input: {
    firstName: string;
    lastName: string;
    email?: string;
    password?: string;
    phone?: string;
  }): Promise<VerificationSent> {
    const identifier = this.identifierFor(input);
    const passwordHash =
      'email' in identifier ? await this.newPasswordHash(input.password) : null;
    await this.verification.throttle(identifier);

    // An address that already has an account gets an attempt that can never
    // succeed and no message, with the same answer.
    const taken = await this.users.findAccountBy(identifier);
    const pending: PendingCustomer = {
      kind: 'customer',
      firstName: input.firstName,
      lastName: input.lastName,
      passwordHash,
    };
    return this.verification.start(identifier, taken ? {} : { pending });
  }

  /**
   * Sends a code: to a mobile number so its customer can sign in, or again
   * for a verification attempt that is still open.
   */
  async requestCode(input: {
    phone?: string;
    verificationId?: string;
  }): Promise<VerificationSent> {
    if (input.verificationId && !input.phone) {
      return this.verification.resend(input.verificationId);
    }
    if (!input.phone || input.verificationId) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The request is not valid.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'phone', issue: 'send either phone or verificationId' }],
      );
    }

    const identifier = { phone: input.phone };
    await this.verification.throttle(identifier);
    const user = await this.users.findAccountBy(identifier);
    // Code sign-in is for customers. Operator and internal accounts sign in
    // with a password, and an invited account only through its invitation.
    const eligible =
      user?.role === Role.CUSTOMER && user.status === UserStatus.ACTIVE;
    return this.verification.start(
      identifier,
      eligible ? { userId: user.id } : {},
    );
  }

  /** Checks a code, completes a registration if it carries one, and signs in. */
  async verifyCode(
    input: { verificationId: string; code: string },
    client: ClientInfo,
  ): Promise<{ tokens: SessionTokens; user: UserAccount }> {
    const attempt = await this.verification.check(
      input.verificationId,
      input.code,
    );

    let account: UserAccount | null;
    if (attempt.pending) {
      account = await this.verification.completionFor(attempt.pending.kind)(
        attempt.pending,
        attempt.identifier,
      );
    } else {
      account = attempt.userId
        ? await this.users.findAccount(attempt.userId)
        : null;
      if (account?.status === UserStatus.SUSPENDED) {
        throw new AppException(
          'AUTH_ACCOUNT_SUSPENDED',
          'This account is suspended. Contact support.',
          HttpStatus.FORBIDDEN,
        );
      }
      if (account?.role !== Role.CUSTOMER) account = null;
      if (account && 'phone' in attempt.identifier) {
        ({ account } = await this.users.markVerified(account.id, 'phone'));
      }
    }
    if (!account || account.status !== UserStatus.ACTIVE) {
      throw this.verification.expired();
    }

    const tokens = await this.auth.startSession(account, client);
    return { tokens, user: account };
  }

  async forgotPassword(email: string): Promise<void> {
    const identifier = { email };
    await this.verification.throttle(identifier, 'password-reset');
    const user = await this.users.findAccountBy(identifier);
    if (!user?.email || user.status !== UserStatus.ACTIVE) return;

    const token = await this.accountTokens.issue(user.id, 'password-reset');
    await this.audit.record({
      action: 'auth.password_reset_requested',
      entityType: 'User',
      entityId: user.id,
      actor: null,
    });
    await this.notifications.send({
      userId: user.id,
      channel: 'EMAIL',
      templateKey: 'auth.password_reset',
      to: user.email,
      secret: true,
      variables: {
        link: this.users.passwordLink(token),
        minutes: ACCOUNT_TOKEN_TTL_SECONDS['password-reset'] / 60,
      },
    });
  }

  /**
   * Sets a new password from an emailed link (reset or staff invitation),
   * then signs the account out everywhere. One transaction, so the change
   * never happens without its audit record.
   */
  async resetPassword(token: string, password: string): Promise<void> {
    assertAcceptablePassword(password);
    const passwordHash = await hashPassword(password);
    const record = await this.accountTokens.consume(token);
    const user = record ? await this.users.findAccount(record.userId) : null;
    const usable =
      record &&
      user &&
      (record.purpose === 'invitation'
        ? user.status === UserStatus.PENDING_VERIFICATION
        : user.status === UserStatus.ACTIVE);
    if (!usable) {
      throw new AppException(
        'AUTH_TOKEN_INVALID',
        'This link is not valid or has expired. Request a new one.',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await this.users.setPassword(user.id, passwordHash, tx);
      if (record.purpose === 'invitation') {
        // Receiving the invitation proves ownership of the email address.
        await this.users.markVerified(user.id, 'email', tx);
      }
      await this.auth.revokeAllSessions(user.id, tx);
      await this.audit.record(
        {
          action:
            record.purpose === 'invitation'
              ? 'auth.invitation_accepted'
              : 'auth.password_reset',
          entityType: 'User',
          entityId: user.id,
          actor: { id: user.id, role: user.role },
        },
        tx,
      );
    });
    // The owner has proven themselves by email: lift any sign-in lock.
    if (user.email) await this.failures.clearAll(user.email);
  }

  private async createCustomer(
    pending: PendingCustomer,
    identifier: Identifier,
  ): Promise<UserAccount | null> {
    const account = await uniqueOrNull(() =>
      this.prisma.$transaction(async (tx) => {
        // Someone else may have completed a registration for this address
        // while this attempt was open.
        if (await this.users.findAccountBy(identifier, tx)) return null;
        const user = await this.users.create(
          {
            ...identifier,
            passwordHash: pending.passwordHash ?? undefined,
            role: Role.CUSTOMER,
            verified: true,
          },
          tx,
        );
        await this.customers.upsertProfile(
          user.id,
          { firstName: pending.firstName, lastName: pending.lastName },
          tx,
        );
        await this.consents.recordRegistration(user.id, tx);
        await this.audit.record(
          {
            action: 'user.register',
            entityType: 'User',
            entityId: user.id,
            actor: { id: user.id, role: user.role },
            after: { status: user.status, role: user.role },
          },
          tx,
        );
        return user;
      }),
    );
    if (!account) return null;

    const variables = { firstName: pending.firstName };
    if (account.email) {
      await this.notifications.send({
        userId: account.id,
        channel: 'EMAIL',
        templateKey: 'customer.welcome',
        to: account.email,
        variables,
      });
    }
    await this.notifications.send({
      userId: account.id,
      channel: 'IN_APP',
      templateKey: 'customer.welcome',
      variables,
    });
    return account;
  }

  private async newPasswordHash(password: string | undefined): Promise<string> {
    if (!password) {
      throw new AppException(
        'VALIDATION_ERROR',
        'The request is not valid.',
        HttpStatus.BAD_REQUEST,
        [{ field: 'password', issue: 'is required with email' }],
      );
    }
    assertAcceptablePassword(password);
    return hashPassword(password);
  }

  private identifierFor(input: { email?: string; phone?: string }): Identifier {
    if (input.email && !input.phone) return { email: input.email };
    if (input.phone && !input.email) return { phone: input.phone };
    throw new AppException(
      'VALIDATION_ERROR',
      'The request is not valid.',
      HttpStatus.BAD_REQUEST,
      [{ field: 'email', issue: 'send either email or phone, not both' }],
    );
  }
}
