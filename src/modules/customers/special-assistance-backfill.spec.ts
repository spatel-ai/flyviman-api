import { ConfigService } from '@nestjs/config';
import {
  ENCRYPTED_PATTERN,
  FieldCipher,
} from '../../common/crypto/field-cipher.js';
import { encryptLegacySpecialAssistance } from './special-assistance-backfill.js';

const cipher = new FieldCipher({
  getOrThrow: () => Buffer.alloc(32, 7).toString('base64'),
} as unknown as ConfigService);

/** A passenger table in memory, enough for the data migration's two calls. */
function fakePrisma(rows: { id: string; specialAssistance: string | null }[]) {
  const pattern = new RegExp(ENCRYPTED_PATTERN);
  return {
    $queryRaw: vi.fn(() =>
      Promise.resolve(
        rows
          .filter(
            (row) =>
              row.specialAssistance !== null &&
              !pattern.test(row.specialAssistance),
          )
          .map((row) => ({ ...row })),
      ),
    ),
    passenger: {
      updateMany: vi.fn(
        ({
          where,
          data,
        }: {
          where: { id: string; specialAssistance: string };
          data: { specialAssistance: string };
        }) => {
          const row = rows.find(
            (r) =>
              r.id === where.id &&
              r.specialAssistance === where.specialAssistance,
          );
          if (row) row.specialAssistance = data.specialAssistance;
          return Promise.resolve({ count: row ? 1 : 0 });
        },
      ),
    },
  };
}

function run(prisma: ReturnType<typeof fakePrisma>) {
  return encryptLegacySpecialAssistance(prisma as never, (plain) =>
    cipher.encrypt(plain),
  );
}

describe('encryptLegacySpecialAssistance', () => {
  it('encrypts a plain-text row so it reads back unchanged', async () => {
    const rows = [{ id: 'a', specialAssistance: 'Wheelchair to the aircraft' }];
    const prisma = fakePrisma(rows);
    expect(await run(prisma)).toBe(1);
    expect(rows[0].specialAssistance).not.toContain('Wheelchair');
    expect(cipher.decrypt(rows[0].specialAssistance)).toBe(
      'Wheelchair to the aircraft',
    );
  });

  it('leaves ciphertext and empty notes alone and is safe to repeat', async () => {
    const stored = cipher.encrypt('Oxygen');
    const rows = [
      { id: 'a', specialAssistance: stored },
      { id: 'b', specialAssistance: null },
      { id: 'c', specialAssistance: 'Escort' },
      { id: 'd', specialAssistance: '' },
    ];
    const prisma = fakePrisma(rows);
    expect(await run(prisma)).toBe(2);
    expect(rows[0].specialAssistance).toBe(stored);
    expect(rows[1].specialAssistance).toBeNull();
    expect(cipher.decrypt(rows[2].specialAssistance!)).toBe('Escort');
    expect(cipher.decrypt(rows[3].specialAssistance!)).toBe('');
    const after = rows.map((row) => row.specialAssistance);
    expect(await run(prisma)).toBe(0);
    expect(rows.map((row) => row.specialAssistance)).toEqual(after);
  });

  it('never overwrites a note changed since it was read', async () => {
    const rows = [{ id: 'a', specialAssistance: 'Escort' }];
    const prisma = fakePrisma(rows);
    const newer = cipher.encrypt('Stretcher');
    prisma.$queryRaw.mockImplementationOnce(() => {
      const read = rows.map((row) => ({ ...row }));
      rows[0].specialAssistance = newer;
      return Promise.resolve(read);
    });
    expect(await run(prisma)).toBe(0);
    expect(rows[0].specialAssistance).toBe(newer);
  });
});
