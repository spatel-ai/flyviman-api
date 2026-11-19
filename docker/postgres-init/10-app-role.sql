-- Local development and CI only: the API's restricted role (DATABASE_URL in
-- .env.example), with the same throwaway password style as docker-compose.yml.
-- Its privileges come from the migration 20261119130000_app_role_privileges.
-- Runs on a fresh volume (docker-entrypoint-initdb.d); safe to run again.
--
-- A role is shared by every database on a server, so this known password
-- must never reach a shared one. The script runs only over the server's own
-- socket or loopback (docker-entrypoint-initdb.d, or
-- `docker compose exec -T postgres psql ...`), and aborts over the network.
DO $$
BEGIN
  IF inet_server_addr() IS NOT NULL AND NOT inet_server_addr() <<= ANY (ARRAY['127.0.0.0/8', '::1/128']::inet[]) THEN
    RAISE EXCEPTION 'flyviman_app: 10-app-role.sql sets a known local password and runs only on a local development server. Run it inside the container (docker compose exec -T postgres psql -U flyviman -d flyviman < docker/postgres-init/10-app-role.sql); on any other server create the role by hand (docs/deployment.md).';
  END IF;

  CREATE ROLE flyviman_app LOGIN PASSWORD 'flyviman_app';
EXCEPTION
  WHEN duplicate_object OR unique_violation THEN
    ALTER ROLE flyviman_app LOGIN PASSWORD 'flyviman_app';
END $$;
