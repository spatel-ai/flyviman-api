-- The API connects as the restricted role "flyviman_app"; migrations and the
-- seed run as the owner of the tables (MIGRATION_DATABASE_URL). The role may
-- read and write rows, but it owns nothing, so it cannot alter or drop a
-- table or disable or drop a trigger, and it may only insert into the
-- append-only AuditLog and BookingEvent.
--
-- Idempotent: `npm run db:grant` runs this file again (prisma db execute),
-- for when the role is created after this migration was applied. A role is
-- shared by every database on the server; its password is never set here.

-- Create the role, without a login, if the owner may create roles. Whoever
-- runs the database gives it LOGIN and a password (docs/deployment.md).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyviman_app') THEN
    CREATE ROLE flyviman_app NOLOGIN;
  END IF;
EXCEPTION
  -- Another database on the same server created it at the same moment.
  WHEN duplicate_object OR unique_violation THEN NULL;
  WHEN insufficient_privilege THEN
    RAISE NOTICE 'flyviman_app: this user cannot create roles; create it by hand, then run npm run db:grant';
END $$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyviman_app') THEN
    RAISE NOTICE 'flyviman_app does not exist: no privileges granted';
    RETURN;
  END IF;

  EXECUTE format('GRANT CONNECT ON DATABASE %I TO flyviman_app', current_database());
  GRANT USAGE ON SCHEMA public TO flyviman_app;
  GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO flyviman_app;
  GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO flyviman_app;
  -- Tables and sequences the owner creates in later migrations.
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO flyviman_app;
  ALTER DEFAULT PRIVILEGES IN SCHEMA public
    GRANT USAGE, SELECT ON SEQUENCES TO flyviman_app;

  -- Append-only tables. A later append-only table revokes the same in the
  -- migration that creates it.
  REVOKE UPDATE, DELETE, TRUNCATE ON "AuditLog", "BookingEvent" FROM flyviman_app;
  -- Migration history belongs to the owner alone.
  REVOKE ALL ON "_prisma_migrations" FROM flyviman_app;
END $$;
