# Form Service — Playwright E2E Tests

## Prerequisites

All three services must be running before you execute the test suite. Playwright does NOT start them for you.

### 1. Infrastructure

```bash
docker compose up form-postgres form-minio redis
```

### 2. Migrations + seed

```bash
# From repo root
pnpm -F form-api db:migrate
pnpm tsx form-api/scripts/seed-e2e.ts
```

### 3. Start services (three terminals)

```bash
pnpm -F form-api dev          # http://localhost:4200
pnpm -F form-admin dev        # http://localhost:4201
pnpm -F form-web dev          # http://localhost:4202
```

### 4. Install Playwright browser (once)

```bash
pnpm -F form-api e2e:install
```

### 5. Set environment variables

```bash
export FORM_SESSION_SECRET=<your-dev-session-secret>
export E2E_ADMIN_TOKEN=$(pnpm tsx form-api/scripts/issue-test-session.ts \
  --sub 00000000-0000-0000-0000-000000000001 --admin)
export E2E_USER_SESSION=$(pnpm tsx form-api/scripts/issue-test-session.ts \
  --sub 00000000-0000-0000-0000-000000000002)
```

## Running the suite

```bash
pnpm -F form-api e2e
```

To run a single spec:

```bash
pnpm -F form-api e2e -- --grep "language.profile.v1"
```

## Test inventory

| File | What it covers |
|---|---|
| `language-profile-event.spec.ts` | Full redirect flow: create form + event, visit /e/<event_key>, fill multi-page form, submit, check status API returns `filled: true` |
| `webhook-replay.spec.ts` | Webhook retry: echo server 500 on first call, 200 on second; verify deliveries endpoint shows both attempts |
| `embed-sdk.spec.ts` | Embedded iframe: load embed-host.html, assert `form-resize` postMessage, submit, assert `form-submit` postMessage |
| `anonymous-submit.spec.ts` | Anonymous form: submit without login, assert `account_id` null and `anonymous_token` cookie set |
| `rate-limit.spec.ts` | Rate limiting: 30 rapid submits yield at least one 429 with backoff guidance in body |

Total: 5 Playwright tests.

## Stub server

The stub language-api can be started separately for manual integration testing:

```bash
pnpm -F form-api e2e:stub-language-api
# listens on http://localhost:4298
```

It accepts `POST /internal/forms/language-profile/submit`, verifies the
`X-Form-Signature` HMAC, and returns 200 on success.
