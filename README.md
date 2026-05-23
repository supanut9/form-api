# form-api

The backend service for the form platform. Provides a REST API (Fastify 5 + TypeScript) for creating and managing dynamic forms, collecting submissions, tracking named form events, delivering webhooks, and handling file uploads via S3-compatible storage. Runs on port **4200**. Part of a three-service form platform (`form-api`, `form-admin`, `form-web`) described fully in [`../form-plan.md`](../form-plan.md). Future cross-service architecture documentation will live at `docs/forms/forms-architecture.md`.

## Quickstart

```bash
make setup   # npm install
make test    # vitest run — healthz inject test (Wave 1 only; integration tests need DB+Redis)
make run     # tsx watch src/server.ts  →  http://localhost:4200
```

## Directory layout

| Path | Purpose |
|------|---------|
| `src/server.ts` | Fastify composition root — `buildServer()` factory + `main()` listen entrypoint |
| `src/config/env.ts` | Zod-validated env loader; throws on invalid config naming the bad key |
| `src/config/logger.ts` | pino logger factory (JSON in prod, pino-pretty in dev) |
| `src/config/sentry.ts` | Optional Sentry initialisation (lazy, only when `SENTRY_DSN` is set) |
| `src/core/` | Domain services: auth, forms, submissions, events, logic, webhooks, tokens, audit |
| `src/plugins/` | Fastify plugins: prisma, auth, and builtin feature plugins (media, webhooks) |
| `src/routes/admin/` | Admin API routes (OIDC-gated) — forms, versions, submissions, events, webhooks, tokens, roles, audit |
| `src/routes/public/` | Public-facing routes — render-spec, submit, event-status, files |
| `src/routes/internal/` | Service-to-service routes — event-status, webhook-replay |
| `src/workers/` | BullMQ workers — webhook delivery, file processing |
| `src/types/` | Fastify type augmentations (decorator declarations) |
| `prisma/` | Prisma schema and migrations (Wave 2 / Lane L4) |
| `test/` | Integration and e2e tests (require live Postgres + Redis + MinIO) |
| `var/file-storage/` | Local file storage root for dev (MinIO in prod) |

## Environment variables

Copy `.env.example` to `.env` and fill in values. See `.env.example` for documentation of each variable and which wave introduces it.

Key variables:
- `PORT` — default `4200`
- `DATABASE_URL` — required in Wave 2 (Prisma schema, port 55438 for form-postgres)
- `REDIS_URL` — required in Wave 5 (BullMQ webhooks)
- `FORM_BOOTSTRAP_ADMIN_SUB` — required in Wave 2 (OIDC super-admin bootstrap)
- `SENTRY_DSN` — optional, enables Sentry error tracking
