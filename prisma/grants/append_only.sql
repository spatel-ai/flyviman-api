-- Run by `npm run db:grant` after the privileges migration
-- (20261119130000_app_role_privileges), whose blanket grant would otherwise
-- give the API role UPDATE and DELETE again on append-only tables created by
-- later migrations. Each such table is revoked in the migration that creates
-- it and listed here too. Idempotent; skips a table not yet created.
DO $$
DECLARE
  t text;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'flyviman_app') THEN
    RETURN;
  END IF;
  FOREACH t IN ARRAY ARRAY['PaymentEvent'] LOOP
    IF to_regclass(format('public.%I', t)) IS NOT NULL THEN
      EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON %I FROM flyviman_app', t);
    END IF;
  END LOOP;
END $$;
