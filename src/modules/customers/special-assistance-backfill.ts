import {
  ENCRYPTED_PATTERN,
  isEncrypted,
} from '../../common/crypto/field-cipher.js';
import type { PrismaClient } from '../../generated/prisma/client.js';

const BATCH = 500;

/**
 * Data migration for `Passenger.specialAssistance`, which was stored in plain
 * text before it was encrypted. Encrypts every value still in plain text,
 * soft-deleted passengers included, and returns how many it changed. Runs
 * when the API starts (`CustomersService.onApplicationBootstrap`), so it is
 * safe to repeat: ciphertext is never selected again. Each row is replaced
 * only if it still holds the value read, so instances starting together
 * never overwrite each other. The values are never logged.
 */
export async function encryptLegacySpecialAssistance(
  prisma: Pick<PrismaClient, '$queryRaw' | 'passenger'>,
  encrypt: (plain: string) => string,
): Promise<number> {
  let changed = 0;
  let after = '00000000-0000-0000-0000-000000000000';
  for (;;) {
    const rows = await prisma.$queryRaw<
      { id: string; specialAssistance: string }[]
    >`
      SELECT "id", "specialAssistance" FROM "Passenger"
      WHERE "specialAssistance" IS NOT NULL
        AND "specialAssistance" !~ ${ENCRYPTED_PATTERN}
        AND "id" > ${after}::uuid
      ORDER BY "id" LIMIT ${BATCH}`;
    for (const row of rows) {
      if (isEncrypted(row.specialAssistance)) continue;
      const { count } = await prisma.passenger.updateMany({
        where: { id: row.id, specialAssistance: row.specialAssistance },
        data: { specialAssistance: encrypt(row.specialAssistance) },
      });
      changed += count;
    }
    if (rows.length < BATCH) return changed;
    after = rows[rows.length - 1].id;
  }
}
