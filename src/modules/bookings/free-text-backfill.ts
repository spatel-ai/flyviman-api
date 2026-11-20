import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
} from '@nestjs/common';
import {
  ENCRYPTED_PATTERN,
  FieldCipher,
  isEncrypted,
} from '../../common/crypto/field-cipher.js';
import { Prisma, type PrismaClient } from '../../generated/prisma/client.js';
import { PrismaService } from '../../prisma/prisma.service.js';

const BATCH = 500;

/**
 * The customer's free-text columns stored in plain text before they were
 * encrypted. Fixed names, never input: they are spliced into the SQL.
 */
export const FREE_TEXT_COLUMNS = [
  { table: 'ChangeRequest', column: 'details' },
  { table: 'Booking', column: 'cancellationReason' },
] as const;

/**
 * Data migration for `FREE_TEXT_COLUMNS`, as `encryptLegacySpecialAssistance`
 * does for passengers: encrypts every value still in plain text and returns
 * how many it changed. Safe to repeat (ciphertext is never selected again),
 * and each row is replaced only if it still holds the value read, so
 * instances starting together never overwrite each other. Raw SQL, so
 * `updatedAt` keeps the time of the real change. Values are never logged.
 * Decision notes are kept in append-only booking events and stay as written;
 * they are read as plain text (`change-requests.ts`).
 */
export async function encryptLegacyFreeText(
  prisma: Pick<PrismaClient, '$queryRaw' | '$executeRaw'>,
  encrypt: (plain: string) => string,
): Promise<number> {
  let changed = 0;
  for (const { table, column } of FREE_TEXT_COLUMNS) {
    const from = Prisma.raw(`"${table}"`);
    const field = Prisma.raw(`"${column}"`);
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      const rows = await prisma.$queryRaw<{ id: string; value: string }[]>`
        SELECT "id", ${field} AS "value" FROM ${from}
        WHERE ${field} IS NOT NULL
          AND ${field} !~ ${ENCRYPTED_PATTERN}
          AND "id" > ${after}::uuid
        ORDER BY "id" LIMIT ${BATCH}`;
      for (const row of rows) {
        if (isEncrypted(row.value)) continue;
        changed += await prisma.$executeRaw`
          UPDATE ${from} SET ${field} = ${encrypt(row.value)}
          WHERE "id" = ${row.id}::uuid AND ${field} = ${row.value}`;
      }
      if (rows.length < BATCH) break;
      after = rows[rows.length - 1].id;
    }
  }
  return changed;
}

/**
 * Runs the data migration before the API accepts requests. A failure stops
 * the start; only the error's name is kept, since a database error can
 * repeat the value.
 */
@Injectable()
export class FreeTextBackfill implements OnApplicationBootstrap {
  private readonly logger = new Logger(FreeTextBackfill.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly cipher: FieldCipher,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    let changed: number;
    try {
      changed = await encryptLegacyFreeText(this.prisma, (plain) =>
        this.cipher.encrypt(plain),
      );
    } catch (error) {
      throw new Error(
        `Encrypting booking free text failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
    }
    if (changed > 0) {
      this.logger.log(`Encrypted ${changed} booking free-text values`);
    }
  }
}
