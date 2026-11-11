# flyviman-api

Backend for the Flyviman aviation booking platform (NestJS, PostgreSQL, Prisma).

## Requirements

- Node.js 22 or later
- npm 11 or later for adding packages (npm 10 installs from the lockfile but can fail resolving new ones; `npx npm@latest install <package>` works as a stand-in)
- Docker, for local PostgreSQL and Redis

## Getting started

```bash
cp .env.example .env
npm install                 # also generates the Prisma client
npm run db:up               # PostgreSQL and Redis
npx prisma migrate dev      # apply migrations
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

## Documentation

Design documents live in `../docs`. Conventions for working in this repository are in `CLAUDE.md`.
