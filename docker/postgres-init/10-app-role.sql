-- Local development and CI only: the API's restricted role (DATABASE_URL in
-- .env.example), with the same throwaway password style as docker-compose.yml.
-- Its privileges come from the migration 20261119130000_app_role_privileges.
-- Runs on a fresh volume (docker-entrypoint-initdb.d); safe to run again.
DO $$
BEGIN
  CREATE ROLE flyviman_app LOGIN PASSWORD 'flyviman_app';
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN
    ALTER ROLE flyviman_app LOGIN PASSWORD 'flyviman_app';
END $$;
