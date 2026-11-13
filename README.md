# flyviman-api

Backend for the Flyviman aviation booking platform (NestJS, PostgreSQL, Prisma).

## Requirements

- Node.js 22.12 or later
- npm 11 or later for adding packages (npm 10 installs from the lockfile but can fail resolving new ones; `npx npm@latest install <package>` works as a stand-in)
- Docker, for local PostgreSQL and Redis

## Getting started

```bash
cp .env.example .env
npm install                 # also generates the Prisma client
npm run db:up               # PostgreSQL and Redis
npx prisma migrate dev      # apply migrations
npm run db:seed             # accounts, policies, templates, locations
npm run start:dev
```

- API: http://localhost:4000/api/v1
- Health: http://localhost:4000/api/v1/health
- API reference: http://localhost:4000/api/docs

## Checks

```bash
npm run lint
npm run typecheck
npm test            # unit tests (Vitest)
npm run test:e2e    # API integration tests (Playwright)
npm run build
```

## What is built

Milestones M0 to M2 and M3 steps 1 to 8 (`../docs/progress.md` has the detail and `../docs/roadmap.md` what comes next):

- **Foundations:** sign-in with rotating refresh tokens, roles checked against the database on every request, CSRF protection, rate limits, an append-only audit log, structured logs with request IDs.
- **Identity:** customer registration by email or mobile with one-time codes, password reset, profiles and saved passengers; operator registration, compliance documents and review; internal staff accounts.
- **Fleet:** airports and heliports (OurAirports), aircraft profiles with photos and documents, review and approval by operations, an availability calendar with conflict rules.
- **Operator staff:** operator administrators invite staff, give them "manage aircraft" and/or "manage availability" on chosen aircraft (or all), and suspend or remove them (`/operator/staff`).
- **Document expiry:** a daily job alerts operator administrators 30 days, 7 days and on the day before a certificate or insurance lapses; operations see `GET /admin/documents/expiring`; an aircraft with an expired required document is flagged as not searchable. Notifications go through an outbox with retries.
- **Not yet:** search and pricing (M4), scheduled airlines, empty legs, bookings, payments, air ambulance; real messaging and storage providers.

The route catalogue is `../docs/api/api-routes.md`; request and response shapes are in `openapi.json` (the interactive reference at `/api/docs` runs outside production only).

## Deployment

The proof-of-concept host runs on Render from `render.yaml` (branch `main`), with the web app on Vercel proxying `/api/v1` to it. Steps, variables and limits: `../docs/deployment.md`. It is not production: messages are discarded, uploads live on the instance's disk, and seeded passwords must be at least 24 characters there.

## Documentation

Design documents live in `../docs`. Conventions for working in this repository are in `CLAUDE.md`.
