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
| Sessions | `@nestjs/jwt` access tokens and rotating opaque refresh tokens in cookies; passwords hashed with `argon2` |
| Redis | `ioredis` (`src/redis`): one-time codes, reset and invitation tokens, idempotency keys, sign-in failure counts |
| Rate limiting | `@nestjs/throttler` (in-memory counters) |
| Logging | `nestjs-pino`, structured JSON with the request ID |
| Unit tests | Vitest, `*.spec.ts` next to the code |
| Integration tests | Playwright request client, `e2e/*.e2e.ts` |
| Lint and format | oxlint (type-aware), Prettier |
| Payments (M9) | Razorpay, behind `PaymentGatewayProvider` |

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
| Integration tests | `npm run test:e2e` (builds, migrates, seeds and starts the API itself; needs `npm run db:up`) |
| Seed accounts, policies, templates and locations | `npm run db:seed` |
| Export the API description for the web app | `npm run openapi:export` (writes `openapi.json`; then `npm run api:types` in `flyviman-web`) |
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
  app.setup.ts            global prefix, logger, CORS, Helmet, cookies, validation, API reference
  app.module.ts           registers every module, the envelope, error filter and idempotency interceptor
  seed.ts                 accounts, policies and notification templates (`npm run db:seed`)
  openapi-export.ts       writes openapi.json (`npm run openapi:export`)
  config/                 environment validation
  common/                 cross-cutting code: errors, filters, interceptors, middleware, DTO helpers,
                          request context, logging, rate limiting, idempotency, field encryption
  prisma/                 PrismaService (global)
  redis/                  shared Redis connection (global)
  modules/<name>/         one folder per business module (see the module map)
  integrations/           adapters for external providers, each with a mock
  generated/prisma/       generated client, not committed
prisma/schema.prisma      database schema
prisma/migrations/        migrations; hand-written SQL where Prisma cannot express a constraint
prisma/data/              reference data the seed loads (locations-in.json, from OurAirports)
scripts/build-locations.mjs  rebuilds prisma/data/locations-in.json; run only to refresh the data
prisma7.config.ts         Prisma configuration
e2e/                      Playwright API tests; helpers in e2e/support (sign-in, test data, outbox)
openapi.json              exported API description, read by flyviman-web
```

The module map, with what each module owns and may depend on, is in `../docs/architecture/high-level-design.md`.

## Conventions

- **Every response is enveloped** by `ResponseEnvelopeInterceptor`: `{ data, meta }`. Controllers return plain DTOs; list endpoints return `new Paginated(items, page, pageSize, total)`.
- **Every error is enveloped** by `AllExceptionsFilter`: `{ error: { code, message, details, requestId } }`. Throw `AppException` with a code from the catalogue in `../docs/api/api-design.md`.
- **Routes are private by default.** Mark a public route `@Public()`. Every other route needs `@Roles(...)` or `@AnyRole()`; a private route with neither is refused. Get the caller with `@CurrentUser()`. All in `src/modules/auth/auth.decorators.ts`. Check ownership in the service with the caller's own ID.
- **State-changing requests are CSRF-checked** by a global guard. Only requests authorised by something other than the session use `@SkipCsrf()`: provider webhooks (signature) and the storage mock's signed URLs.
- **Audit** material actions with `AuditService.record()` (pass the transaction client so the record commits with the change), or `@Audited()` on a handler when the route itself says what happened. Never put personal data, secrets or medical details in `before`, `after` or `reason`.
- **Money-moving and booking-creating routes** are marked `@Idempotent()` (`src/common/idempotency`).
- **Optional but not nullable** fields in update DTOs use `@OptionalNotNull()`, not `@IsOptional()`, which lets `null` through to the database.
- **Controllers are thin.** Validate with DTOs, authorise, call a service, return a response DTO. One controller per audience (`/…`, `/operator/…`, `/admin/…`).
- **Never return a Prisma entity.** Map to a response DTO.
- **Modules touch only their own tables** and use other modules through their exported services.
- **Status changes go through one transition function** per state machine, which also records the event or audit entry.
- **Money** is integer minor units with a currency. **Timestamps** are UTC.
- **New environment variables** are added to `EnvironmentVariables` in `src/config/env.validation.ts` and to `.env.example` in the same change.
- **External providers** are called only through `src/integrations/`. Tests always use the mock.
- **No personal, medical or payment data in logs.** Requests are logged as method, path and status only. Do not log error messages from the database or a provider: they can repeat the data.
- **Answers that could reveal whether an account exists do not.** Registration, code and recovery routes behave the same either way.
- **Development helpers** (messaging outbox, storage mock, local seed accounts) need `ENABLE_DEV_TOOLS=true`, which is refused in production and on any non-localhost web origin. The proof-of-concept host instead runs `MESSAGING_PROVIDER=sink` and `STORAGE_PROVIDER=local` with development tools off (D-064); neither is fit for production. See `src/integrations/README.md` and `../docs/deployment.md`.
- **Prefer Nest's first-party packages** listed in `AGENTS.md`, after reading the package's documentation page. Several (for example `@nestjs/idempotency`, `@nestjs/webhooks`) were at 0.0.x when this project was set up; check maturity before depending on one.

## Testing

Strategy and conventions: `../docs/testing-strategy.md`.

- Pure logic (pricing rules, transition tables, mappers): Vitest unit tests.
- Everything that crosses HTTP, the database or a provider adapter: Playwright API tests in `e2e/`, written with the `/playwright-test` skill.
- A change is not done until `npm run lint`, `npm run typecheck`, `npm test`, `npm run test:e2e` and `npm run build` pass. CI (`.github/workflows/ci.yml`) runs all of them on every pull request and push to `main`, and also fails when `openapi.json` is out of date (`../docs/testing-strategy.md`).

## Skills and agents

`/nest-module`, `/api-endpoint`, `/db-migration`, `/pricing-rule`, `/playwright-test`; agents `code-reviewer`, `security-reviewer`, `test-runner`. They live in `../.claude/`, so start Claude Code from the workspace root to have them available.
