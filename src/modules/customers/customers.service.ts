import {
  HttpStatus,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import { FieldCipher, isEncrypted } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  Gender,
  IdentityDocumentType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';
import { AuditService } from '../audit/audit.service.js';
import { UsersService } from '../users/users.service.js';
import { encryptLegacySpecialAssistance } from './special-assistance-backfill.js';

export interface Profile {
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  nationality: string | null;
}

export interface PassengerInput {
  firstName?: string;
  lastName?: string;
  dateOfBirth?: string | null;
  gender?: Gender;
  nationality?: string | null;
  documentType?: IdentityDocumentType | null;
  documentNumber?: string | null;
  documentExpiry?: string | null;
  specialAssistance?: string | null;
}

export interface PassengerRecord {
  id: string;
  firstName: string;
  lastName: string;
  dateOfBirth: Date | null;
  gender: Gender;
  nationality: string | null;
  documentType: IdentityDocumentType | null;
  /** Decrypted. Only ever returned to the passenger's owner. */
  documentNumber: string | null;
  documentExpiry: Date | null;
  /** Decrypted. Only ever returned to the passenger's owner. */
  specialAssistance: string | null;
}

/** Upper bound on saved passengers per customer. */
export const MAX_PASSENGERS = 50;

const PROFILE = {
  firstName: true,
  lastName: true,
  dateOfBirth: true,
  nationality: true,
} as const;

function date(value: string | null | undefined): Date | null | undefined {
  return value === undefined || value === null ? value : new Date(value);
}

/**
 * The fields a passenger change sent, by name only, for its audit record:
 * never their values (identity documents and assistance notes, rule 8).
 */
export function sentFields(input: PassengerInput): string[] {
  return Object.entries(input)
    .filter(([, value]) => value !== undefined)
    .map(([name]) => name)
    .sort();
}

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Passenger not found.',
    HttpStatus.NOT_FOUND,
  );
}

/** Owns CustomerProfile and Passenger. */
@Injectable()
export class CustomersService implements OnApplicationBootstrap {
  private readonly logger = new Logger(CustomersService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: FieldCipher,
    private readonly users: UsersService,
    private readonly audit: AuditService,
  ) {}

  /**
   * Encrypts special-assistance notes saved in plain text before they were
   * encrypted, before the API accepts requests. A failure stops the start:
   * the notes could not be read otherwise. Only the error's name is kept,
   * since a database error can repeat the value.
   */
  async onApplicationBootstrap(): Promise<void> {
    let changed: number;
    try {
      changed = await encryptLegacySpecialAssistance(this.prisma, (plain) =>
        this.cipher.encrypt(plain),
      );
    } catch (error) {
      throw new Error(
        `Encrypting special-assistance notes failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    if (changed > 0) {
      this.logger.log(`Encrypted ${changed} special-assistance notes`);
    }
  }

  async upsertProfile(
    userId: string,
    name: { firstName: string; lastName: string },
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    await db.customerProfile.upsert({
      where: { userId },
      create: { userId, ...name },
      update: name,
    });
  }

  findProfile(userId: string): Promise<Profile | null> {
    return this.prisma.customerProfile.findUnique({
      where: { userId },
      select: PROFILE,
    });
  }

  async updateProfile(
    userId: string,
    changes: {
      firstName?: string;
      lastName?: string;
      dateOfBirth?: string | null;
      nationality?: string | null;
    },
  ): Promise<Profile> {
    const { dateOfBirth, ...rest } = changes;
    return this.prisma.$transaction(async (tx) => {
      await this.users.lockLiveCustomer(userId, tx);
      await this.profileIdOrThrow(userId, tx);
      return tx.customerProfile.update({
        where: { userId },
        data: { ...rest, dateOfBirth: date(dateOfBirth) },
        select: PROFILE,
      });
    });
  }

  // --- Saved passengers ---------------------------------------------------
  // Every query is scoped to the caller's own profile, so another customer's
  // passenger is indistinguishable from one that does not exist. A write
  // takes the customer's lock first, so none lands after their erasure.

  async listPassengers(userId: string): Promise<PassengerRecord[]> {
    const rows = await this.prisma.passenger.findMany({
      where: { customer: { userId }, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.present(row));
  }

  /**
   * The caller's own saved passengers with these ids, decrypted, in the
   * order asked for. 404 if any is not theirs or was removed.
   */
  async passengersByIds(
    userId: string,
    ids: string[],
  ): Promise<PassengerRecord[]> {
    const rows = await this.prisma.passenger.findMany({
      where: { id: { in: ids }, customer: { userId }, deletedAt: null },
    });
    const byId = new Map(rows.map((row) => [row.id, row]));
    return ids.map((id) => {
      const row = byId.get(id);
      if (!row) throw notFound();
      return this.present(row);
    });
  }

  async addPassenger(
    userId: string,
    input: PassengerInput & { firstName: string; lastName: string },
  ): Promise<PassengerRecord> {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.users.lockLiveCustomer(userId, tx);
      const customerId = await this.profileIdOrThrow(userId, tx);
      const count = await tx.passenger.count({
        where: { customerId, deletedAt: null },
      });
      if (count >= MAX_PASSENGERS) {
        throw new AppException(
          'PASSENGER_LIMIT_REACHED',
          `You can save up to ${MAX_PASSENGERS} passengers.`,
          HttpStatus.UNPROCESSABLE_ENTITY,
        );
      }
      const created = await tx.passenger.create({
        data: {
          customerId,
          firstName: input.firstName,
          lastName: input.lastName,
          ...this.columns(input),
        },
      });
      await this.recordChange(tx, 'passenger.create', created.id, input);
      return created;
    });
    return this.present(row);
  }

  async updatePassenger(
    userId: string,
    id: string,
    input: PassengerInput,
  ): Promise<PassengerRecord> {
    const row = await this.prisma.$transaction(async (tx) => {
      await this.users.lockLiveCustomer(userId, tx);
      await this.ownedOrThrow(userId, id, tx);
      const updated = await tx.passenger.update({
        where: { id },
        data: {
          firstName: input.firstName,
          lastName: input.lastName,
          ...this.columns(input),
        },
      });
      await this.recordChange(tx, 'passenger.update', id, input);
      return updated;
    });
    return this.present(row);
  }

  async removePassenger(userId: string, id: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.ownedOrThrow(userId, id, tx);
      // Soft delete: bookings will refer to passengers. The identity
      // document is erased, since nothing needs it once the passenger is
      // removed.
      await tx.passenger.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          documentType: null,
          documentNumber: null,
          documentExpiry: null,
        },
      });
      await this.recordChange(tx, 'passenger.delete', id);
    });
  }

  /** The audit record of a saved-passenger change: ids and field names. */
  private recordChange(
    tx: Prisma.TransactionClient,
    action: 'passenger.create' | 'passenger.update' | 'passenger.delete',
    id: string,
    input?: PassengerInput,
  ): Promise<void> {
    return this.audit.record(
      {
        action,
        entityType: 'Passenger',
        entityId: id,
        after: input ? { fields: sentFields(input) } : undefined,
      },
      tx,
    );
  }

  /**
   * Erasure (privacy module): deletes the customer's saved passengers and
   * profile, in the caller's transaction. Bookings keep their own snapshot,
   * whose link to a saved passenger is cleared by the foreign key.
   */
  async erase(
    userId: string,
    tx: Prisma.TransactionClient,
  ): Promise<{ passengers: number }> {
    const { count } = await tx.passenger.deleteMany({
      where: { customer: { userId } },
    });
    await tx.customerProfile.deleteMany({ where: { userId } });
    return { passengers: count };
  }

  private async profileIdOrThrow(
    userId: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<string> {
    const profile = await db.customerProfile.findUnique({
      where: { userId },
      select: { id: true },
    });
    if (!profile) {
      throw new AppException(
        'NOT_FOUND',
        'This account has no customer profile.',
        HttpStatus.NOT_FOUND,
      );
    }
    return profile.id;
  }

  private async ownedOrThrow(
    userId: string,
    id: string,
    db: Prisma.TransactionClient = this.prisma,
  ): Promise<void> {
    const owned = await db.passenger.findFirst({
      where: { id, customer: { userId }, deletedAt: null },
      select: { id: true },
    });
    if (!owned) throw notFound();
  }

  private columns(input: PassengerInput) {
    return {
      dateOfBirth: date(input.dateOfBirth),
      gender: input.gender,
      nationality: input.nationality,
      documentType: input.documentType,
      documentNumber:
        input.documentNumber === undefined || input.documentNumber === null
          ? input.documentNumber
          : this.cipher.encrypt(input.documentNumber),
      documentExpiry: date(input.documentExpiry),
      specialAssistance:
        input.specialAssistance === undefined ||
        input.specialAssistance === null
          ? input.specialAssistance
          : this.cipher.encrypt(input.specialAssistance),
    };
  }

  private present(row: Prisma.PassengerGetPayload<object>): PassengerRecord {
    return {
      id: row.id,
      firstName: row.firstName,
      lastName: row.lastName,
      dateOfBirth: row.dateOfBirth,
      gender: row.gender,
      nationality: row.nationality,
      documentType: row.documentType,
      documentNumber: row.documentNumber
        ? this.cipher.decrypt(row.documentNumber)
        : null,
      documentExpiry: row.documentExpiry,
      // Plain text can still be stored briefly while an older instance runs
      // beside a new one during a deploy; the next start encrypts it.
      specialAssistance:
        row.specialAssistance === null || !isEncrypted(row.specialAssistance)
          ? row.specialAssistance
          : this.cipher.decrypt(row.specialAssistance),
    };
  }
}
