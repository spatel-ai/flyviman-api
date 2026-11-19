import 'dotenv/config';
import { expect, test } from '@playwright/test';
import { withPrisma } from './support/db.js';

/**
 * The API connects as the restricted role (DATABASE_URL), which owns no
 * table: it cannot alter the schema, disable or drop the append-only
 * triggers, or remove audit and booking-timeline rows. Each failure must be
 * a missing privilege (42501), not the trigger refusing, which would also
 * stop the owner.
 */
async function refused(sql: string, reason: RegExp) {
  const error = await withPrisma((prisma) => prisma.$executeRawUnsafe(sql))
    .then(() => undefined)
    .catch((caught: unknown) => caught);
  expect(error, sql).toBeDefined();
  const cause = (
    error as {
      meta?: {
        driverAdapterError?: { cause?: { code?: string; message?: string } };
      };
    }
  ).meta?.driverAdapterError?.cause;
  expect(cause?.code, sql).toBe('42501');
  expect(cause?.message, sql).toMatch(reason);
}

test.describe('The API database role', () => {
  test('is the restricted role, not a superuser or the tables owner', async () => {
    const [row] = await withPrisma(
      (prisma) =>
        prisma.$queryRaw<
          { role: string; superuser: boolean; owner: boolean }[]
        >`SELECT current_user::text AS role,
          (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser,
          pg_has_role((SELECT relowner FROM pg_class WHERE oid = '"AuditLog"'::regclass), 'USAGE') AS owner`,
    );
    expect(row).toEqual({
      role: 'flyviman_app',
      superuser: false,
      owner: false,
    });
  });

  for (const table of ['AuditLog', 'BookingEvent']) {
    test(`may only read and insert ${table}`, async () => {
      await refused(`DELETE FROM "${table}"`, /permission denied/);
      await refused(
        `UPDATE "${table}" SET "id" = "id" WHERE false`,
        /permission denied/,
      );
      await refused(`TRUNCATE "${table}"`, /permission denied/);
      const [row] = await withPrisma((prisma) =>
        prisma.$queryRawUnsafe<{ read: boolean; insert: boolean }[]>(
          `SELECT has_table_privilege('"${table}"', 'SELECT') AS read,
                  has_table_privilege('"${table}"', 'INSERT') AS insert`,
        ),
      );
      expect(row).toEqual({ read: true, insert: true });
    });

    test(`cannot disable, drop or replace ${table}'s triggers`, async () => {
      await refused(
        `ALTER TABLE "${table}" DISABLE TRIGGER "${table}_append_only"`,
        /must be owner/,
      );
      await refused(
        `ALTER TABLE "${table}" DISABLE TRIGGER ALL`,
        /must be owner/,
      );
      await refused(
        `DROP TRIGGER "${table}_no_truncate" ON "${table}"`,
        /must be owner/,
      );
      const fn =
        table === 'AuditLog'
          ? 'audit_log_append_only'
          : 'booking_event_append_only';
      await refused(
        `CREATE OR REPLACE FUNCTION "${fn}"() RETURNS trigger AS $$ BEGIN RETURN OLD; END; $$ LANGUAGE plpgsql`,
        // No CREATE on the schema is checked first; ownership after it.
        /permission denied for schema public|must be owner/,
      );
    });
  }

  test('cannot alter or drop tables, or create them', async () => {
    await refused('ALTER TABLE "User" ADD COLUMN "x" int', /must be owner/);
    await refused('DROP TABLE "AuditLog"', /must be owner/);
    await refused('CREATE TABLE "Intruder" (id int)', /permission denied/);
    await refused('DELETE FROM "_prisma_migrations"', /permission denied/);
  });
});
