# flyviman-api

NestJS backend for the Flyviman aviation booking platform: one modular monolith serving the customer site, the operator portal and the admin portal.

Workspace rules, the business rules that must never be broken, and the index of design documents are in `../CLAUDE.md`. Read that first.

@AGENTS.md

## Stack (as installed)

| Concern | Choice |
|---|---|
| Framework | NestJS 12, Express adapter, ES modules |
| Language | TypeScript 6, strict |
| Database | PostgreSQL 17 through Prisma ORM 7 with the `@prisma/adapter-pg` driver adapter |
| Validation | class-validator and class-transformer through the global `ValidationPipe` |
| API reference | `@nestjs/swagger`, served at `/api/docs` (JSON at `/api/docs-json`) |
| Configuration | `@nestjs/config`, validated at start-up in `src/config/env.validation.ts` |
| Unit tests | Vitest, `*.spec.ts` next to the code |
| Integration tests | Playwright request client, `e2e/*.e2e.ts` |
| Lint and format | oxlint (type-aware), Prettier |
| Payments (M7) | Razorpay, behind `PaymentGatewayProvider` |

Because this is an ES module project: relative imports end in `.js`, use `import.meta.dirname` instead of `__dirname`, and mocks are `vi.fn()`.

## Commands

Run from this directory.

| Task | Command |
|---|---|
| Start services (PostgreSQL, Redis) | `npm run db:up` |
| Run in watch mode | `npm run start:dev` (http://localhost:4000/api/v1) |
| Lint | `npm run lint` |
| Type check | `npm run typecheck` |
| Unit tests | `npm test` |
| Integration tests | `npm run test:e2e` (builds and starts the API itself) |
| Build | `npm run build` |
| Format | `npm run format` |
| Validate schema | `npm run prisma:validate` |
| Create a migration | `npx prisma migrate dev --name <name>` (use the `/db-migration` skill) |
| Regenerate the Prisma client | `npm run prisma:generate` (also runs after `npm install`) |

**Installing packages:** npm 10 can fail when resolving new packages here with `Cannot read properties of null (reading 'edgesOut')`; installing from the existing lockfile works. To add or upgrade a package use npm 11 or later, or `npx npm@latest install <package>`. Keep `prisma` and `@prisma/client` on the same 7.x version.

## Layout

```
src/
  main.ts                 bootstrap
  app.setup.ts            global prefix, CORS, validation, envelope, error filter, API reference
  app.module.ts           registers every module
  config/                 environment validation
  common/                 cross-cutting code: errors, filters, interceptors, middleware, DTO helpers
  prisma/                 PrismaService (global)
  modules/<name>/         one folder per business module (see the module map)
  integrations/           adapters for external providers, each with a mock
  generated/prisma/       generated client, not committed
prisma/schema.prisma      database schema
prisma7.config.ts         Prisma configuration
e2e/                      Playwright API tests
```

The module map, with what each module owns and may depend on, is in `../docs/architecture/high-level-design.md`.

## Conventions

- **Every response is enveloped** by `ResponseEnvelopeInterceptor`: `{ data, meta }`. Controllers return plain DTOs; list endpoints return `new Paginated(items, page, pageSize, total)`.
- **Every error is enveloped** by `AllExceptionsFilter`: `{ error: { code, message, details, requestId } }`. Throw `AppException` with a code from the catalogue in `../docs/api/api-design.md`.
- **Controllers are thin.** Validate with DTOs, authorise, call a service, return a response DTO. One controller per audience (`/…`, `/operator/…`, `/admin/…`).
- **Never return a Prisma entity.** Map to a response DTO.
- **Modules touch only their own tables** and use other modules through their exported services.
- **Status changes go through one transition function** per state machine, which also records the event or audit entry.
- **Money** is integer minor units with a currency. **Timestamps** are UTC.
- **New environment variables** are added to `EnvironmentVariables` in `src/config/env.validation.ts` and to `.env.example` in the same change.
- **External providers** are called only through `src/integrations/`. Tests always use the mock.
- **No personal, medical or payment data in logs.**
- **Prefer Nest's first-party packages** listed in `AGENTS.md`, after reading the package's documentation page. Several (for example `@nestjs/idempotency`, `@nestjs/webhooks`) were at 0.0.x when this project was set up; check maturity before depending on one.

## Testing

Strategy and conventions: `../docs/testing-strategy.md`.

- Pure logic (pricing rules, transition tables, mappers): Vitest unit tests.
- Everything that crosses HTTP, the database or a provider adapter: Playwright API tests in `e2e/`, written with the `/playwright-test` skill.
- A change is not done until `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` and `npm run build` pass.

## Skills and agents

`/nest-module`, `/api-endpoint`, `/db-migration`, `/pricing-rule`, `/playwright-test`; agents `code-reviewer`, `security-reviewer`, `test-runner`. They live in `../.claude/`, so start Claude Code from the workspace root to have them available.
