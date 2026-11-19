-- Run by `npm run db:grant` after the privileges migration
-- (20261119130000_app_role_privileges), whose blanket grant would otherwise
-- give the API role UPDATE and DELETE again on append-only tables created by
-- later migrations. The list is derived, not hand-kept: every table in the
-- public schema with a trigger whose function is named *_append_only
-- (AuditLog, BookingEvent, PaymentEvent, PolicyVersion and any later one).
-- A new append-only table needs only that trigger. Idempotent.
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyviman_app') THEN
    RETURN;
  END IF;
  FOR t IN
    SELECT DISTINCT c.relname
    FROM pg_trigger g
    JOIN pg_proc p ON p.oid = g.tgfoid
    JOIN pg_class c ON c.oid = g.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE NOT g.tgisinternal
      AND n.nspname = 'public'
      AND p.proname LIKE '%\_append\_only'
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM flyviman_app', t);
  END LOOP;
END $$;
