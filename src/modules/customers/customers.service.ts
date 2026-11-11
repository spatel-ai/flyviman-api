import { HttpStatus, Injectable } from '@nestjs/common';
import { FieldCipher } from '../../common/crypto/field-cipher.js';
import { AppException } from '../../common/errors/app.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import type {
  Gender,
  IdentityDocumentType,
} from '../../generated/prisma/enums.js';
import { PrismaService } from '../../prisma/prisma.service.js';

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

function notFound(): AppException {
  return new AppException(
    'NOT_FOUND',
    'Passenger not found.',
    HttpStatus.NOT_FOUND,
  );
}

/** Owns CustomerProfile and Passenger. */
@Injectable()
export class CustomersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: FieldCipher,
  ) {}

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
    await this.profileIdOrThrow(userId);
    return this.prisma.customerProfile.update({
      where: { userId },
      data: { ...rest, dateOfBirth: date(dateOfBirth) },
      select: PROFILE,
    });
  }

  // --- Saved passengers ---------------------------------------------------
  // Every query is scoped to the caller's own profile, so another customer's
  // passenger is indistinguishable from one that does not exist.

  async listPassengers(userId: string): Promise<PassengerRecord[]> {
    const rows = await this.prisma.passenger.findMany({
      where: { customer: { userId }, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return rows.map((row) => this.present(row));
  }

  async addPassenger(
    userId: string,
    input: PassengerInput & { firstName: string; lastName: string },
  ): Promise<PassengerRecord> {
    const customerId = await this.profileIdOrThrow(userId);
    const count = await this.prisma.passenger.count({
      where: { customerId, deletedAt: null },
    });
    if (count >= MAX_PASSENGERS) {
      throw new AppException(
        'PASSENGER_LIMIT_REACHED',
        `You can save up to ${MAX_PASSENGERS} passengers.`,
        HttpStatus.UNPROCESSABLE_ENTITY,
      );
    }
    const row = await this.prisma.passenger.create({
      data: {
        customerId,
        firstName: input.firstName,
        lastName: input.lastName,
        ...this.columns(input),
      },
    });
    return this.present(row);
  }

  async updatePassenger(
    userId: string,
    id: string,
    input: PassengerInput,
  ): Promise<PassengerRecord> {
    await this.ownedOrThrow(userId, id);
    const row = await this.prisma.passenger.update({
      where: { id },
      data: {
        firstName: input.firstName,
        lastName: input.lastName,
        ...this.columns(input),
      },
    });
    return this.present(row);
  }

  async removePassenger(userId: string, id: string): Promise<void> {
    await this.ownedOrThrow(userId, id);
    // Soft delete: bookings will refer to passengers. The identity document
    // is erased, since nothing needs it once the passenger is removed.
    await this.prisma.passenger.update({
      where: { id },
      data: {
        deletedAt: new Date(),
        documentType: null,
        documentNumber: null,
        documentExpiry: null,
      },
    });
  }

  private async profileIdOrThrow(userId: string): Promise<string> {
    const profile = await this.prisma.customerProfile.findUnique({
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

  private async ownedOrThrow(userId: string, id: string): Promise<void> {
    const owned = await this.prisma.passenger.findFirst({
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
      specialAssistance: input.specialAssistance,
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
      specialAssistance: row.specialAssistance,
    };
  }
}
