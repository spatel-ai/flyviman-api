import { defineConfig } from "prisma/config";

// Load a local .env when there is one (Node's own loader, so no dotenv
// dependency: a production install without dev dependencies still works).
// Hosts such as Render set the variables directly and have no .env file.
try {
  process.loadEnvFile();
} catch {
  // No .env file: rely on the environment.
}

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
    // `migrate dev` replays every migration in a shadow database that has no
    // "_prisma_migrations" table, so the REVOKE on it in
    // 20261119130000_app_role_privileges would fail there. An empty stand-in
    // lets the replay run; Prisma ignores the table when it compares schemas.
    // An applied migration is never edited (its checksum would change).
    initShadowDb: 'CREATE TABLE "_prisma_migrations" ("id" VARCHAR(36) PRIMARY KEY);',
  },
  // Required by Prisma for `migrations.initShadowDb`; no external tables are
  // declared, so nothing else changes.
  experimental: {
    externalTables: true,
  },
  // Migrations (and `prisma db execute`) run as the owner of the tables. The
  // API itself connects with DATABASE_URL as the restricted role. Without
  // MIGRATION_DATABASE_URL both use DATABASE_URL, as before.
  datasource: {
    url: process.env["MIGRATION_DATABASE_URL"] || process.env["DATABASE_URL"],
  },
});
