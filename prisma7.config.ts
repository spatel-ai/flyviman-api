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
  datasource: {
    url: process.env["DATABASE_URL"],
  },
});
