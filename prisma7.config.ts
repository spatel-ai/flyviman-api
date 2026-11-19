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
  },
  // Migrations (and `prisma db execute`) run as the owner of the tables. The
  // API itself connects with DATABASE_URL as the restricted role. Without
  // MIGRATION_DATABASE_URL both use DATABASE_URL, as before.
  datasource: {
    url: process.env["MIGRATION_DATABASE_URL"] || process.env["DATABASE_URL"],
  },
});
