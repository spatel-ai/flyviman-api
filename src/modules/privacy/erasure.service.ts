import { HttpStatus, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { requestContext } from '../../common/context/request-context.js';
import { erasureBlockers } from '../../common/erasure.js';
import { AppException } from '../../common/errors/app.exception.js';
import { forgetIdempotencyKeys } from '../../common/idempotency/idempotency.store.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { Role, UserStatus } from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AirAmbulanceErasureService } from '../air-ambulance/air-ambulance-erasure.service.js';
import { AuditService } from '../audit/audit.service.js';
import type { AuthUser } from '../auth/auth-user.js';
import { AuthService } from '../auth/auth.service.js';
import {
  type VerificationSent,
  VerificationService,
} from '../auth/verification.service.js';
import { BookingErasureService } from '../bookings/booking-erasure.service.js';
import { CustomersService } from '../customers/customers.service.js';
import { DocumentsService } from '../documents/documents.service.js';
import { EmptyLegsService } from '../empty-legs/empty-legs.service.js';
import { EnquiriesService } from '../enquiries/enquiries.service.js';
import { NotificationsService } from '../notifications/notifications.service.js';
import { RefundsService } from '../payments/refunds.service.js';
import { AccountTokensService } from '../users/account-tokens.service.js';
import { UsersService } from '../users/users.service.js';

/** How the customer confirms their own erasure. */
export type ErasureProof =
  { password: string } | { verificationId: string; code: string };

function conflict(message: string): AppException {
  return new AppException(
    'USER_INVALID_TRANSITION',
    message,
    HttpStatus.CONFLICT,
  );
}

/**
 * Erasure of a customer's personal data (DPDP Act, W5-8b). Anonymises
 * rather than deletes: the account row and the booking, payment and audit
 * records stay for the legal and financial record, stripped of personal
 * data, in one transaction. Each module scrubs its own tables. Kept as they
 * are: consents (the proof that consent was given, with its address), the
 * audit log and booking timelines (append-only), stored searches (trip
 * parameters, no identity) and promotion uses.
 */
@Injectable()
export class ErasureService {
  private readonly logger = new Logger(ErasureService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly audit: AuditService,
    private readonly users: UsersService,
    private readonly tokens: AccountTokensService,
    private readonly auth: AuthService,
    private readonly verification: VerificationService,
    private readonly customers: CustomersService,
    private readonly bookings: BookingErasureService,
    private readonly refunds: RefundsService,
    private readonly airAmbulance: AirAmbulanceErasureService,
    private readonly documents: DocumentsService,
    private readonly notifications: NotificationsService,
    private readonly enquiries: EnquiriesService,
    private readonly emptyLegs: EmptyLegsService,
  ) {}

  /**
   * Sends a code to confirm the customer's own erasure: to their mobile
   * number, or their email address when they have none. Limited like every
   * code (one a minute, five an hour per address).
   */
  async sendCode(user: AuthUser): Promise<VerificationSent> {
    const account = await this.users.findAccount(user.id);
    const identifier = account?.phone
      ? { phone: account.phone }
      : account?.email
        ? { email: account.email }
        : null;
    // Every customer registered with one of the two.
    if (!identifier) throw new Error('Customer account without an address');
    await this.verification.throttle(identifier);
    // Bound to erasure: refused by every sign-in and registration route.
    return this.verification.start(identifier, {
      userId: user.id,
      purpose: 'erasure',
    });
  }

  /**
   * The customer's own request. Refused (409) before the proof is checked,
   * so a code is not used up on an answer it cannot change.
   */
  async eraseOwn(user: AuthUser, proof: ErasureProof): Promise<void> {
    await this.assertErasable(user.id, this.prisma);
    if ('password' in proof) {
      await this.auth.confirmPassword(
        user.id,
        proof.password,
        requestContext.get()?.ipAddress ?? null,
      );
    } else {
      // Only a code sent by `sendCode`: a sign-in code is refused.
      const attempt = await this.verification.check(
        proof.verificationId,
        proof.code,
        'erasure',
      );
      if (attempt.pending || attempt.userId !== user.id) {
        throw this.verification.expired();
      }
    }
    await this.erase(user.id);
  }

  /**
   * A request received another way (email, letter), carried out by a super
   * administrator with a reason. Customer accounts only: internal staff and
   * operator accounts are suspended, not erased here.
   */
  async eraseByAdmin(id: string, reason: string): Promise<Date> {
    return this.erase(id, reason);
  }

  private async erase(id: string, reason?: string): Promise<Date> {
    const now = new Date();
    const storageKeys = await this.prisma.$transaction(async (tx) => {
      // The lock each of the customer's booking requests takes, then the
      // account row: a request in flight finishes first and is seen below.
      const key = `booking_customer:${id}`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
      const account = await this.users.lockForErasure(id, tx);
      if (!account) {
        throw new AppException(
          'NOT_FOUND',
          'User not found.',
          HttpStatus.NOT_FOUND,
        );
      }
      if (account.role !== Role.CUSTOMER) {
        throw conflict(
          'Only customer accounts can be erased. Suspend a staff or operator account instead.',
        );
      }
      if (account.status === UserStatus.ERASED) {
        throw conflict('This account has already been erased.');
      }
      await this.assertErasable(id, tx);

      // Records first, then the files they pointed at, then the account.
      const airAmbulance = await this.airAmbulance.erase(id, tx);
      const keys = await this.documents.forgetOwnedFiles(id, tx);
      const bookings = await this.bookings.erase(id, tx);
      const { passengers } = await this.customers.erase(id, tx);
      const notifications = await this.notifications.eraseFor(id, tx);
      const enquiries = await this.enquiries.eraseFrom(account, tx);
      const emptyLegAlerts = await this.emptyLegs.forgetInterests(id, tx);
      const idempotencyKeys = await forgetIdempotencyKeys(tx, id);
      const sessions = await this.auth.deleteAllSessions(id, tx);
      await this.users.anonymise(id, now, tx);
      // Counts only: nothing that was erased is copied into the audit log.
      await this.audit.record(
        {
          action: 'user.erase',
          entityType: 'User',
          entityId: id,
          before: { status: account.status },
          after: {
            status: UserStatus.ERASED,
            bookings: bookings.bookings,
            passengerSnapshots: bookings.passengers,
            changeRequests: bookings.changeRequests,
            savedPassengers: passengers,
            airAmbulanceRequests: airAmbulance.requests,
            airAmbulanceMedicalRecords: airAmbulance.medical,
            airAmbulanceDocuments: airAmbulance.documents,
            files: keys.length,
            notifications,
            enquiries,
            emptyLegAlerts,
            idempotencyKeys,
            sessions,
          },
          reason,
        },
        tx,
      );
      return keys;
    });

    // After the commit, never failing the request: the erasure stands.
    // Emailed links would be refused anyway (the account is not active).
    await Promise.all([
      this.tokens.revokeFor(id, 'invitation'),
      this.tokens.revokeFor(id, 'password-reset'),
    ]).catch(() =>
      this.logger.warn('Could not revoke the emailed links of an erased user'),
    );
    const left = await this.documents.deleteStored(storageKeys);
    if (left.length > 0) {
      // Storage keys are generated by the server and hold no personal data.
      this.logger.error(
        `Erasure could not delete ${left.length} stored files: ${left.join(', ')}`,
      );
    }
    return now;
  }

  /** 409 `USER_ERASURE_BLOCKED`, with each reason, unless it may be erased. */
  private async assertErasable(
    id: string,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const own = await this.bookings.facts(id, db);
    const airAmbulance = await this.airAmbulance.facts(id, db);
    const { total: refundsDue } = await this.refunds.due(1, 1, {
      customerId: id,
      db,
    });
    const blockers = erasureBlockers(
      { ...own, airAmbulance, refundsDue },
      {
        now: new Date(),
        holdDays: this.config.getOrThrow<number>('ERASURE_HOLD_DAYS'),
      },
    );
    if (blockers.length > 0) {
      throw new AppException(
        'USER_ERASURE_BLOCKED',
        'This account cannot be erased yet: something is still open on it.',
        HttpStatus.CONFLICT,
        blockers.map((issue) => ({ field: 'reason', issue })),
      );
    }
  }
}
