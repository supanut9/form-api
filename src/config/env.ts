import 'dotenv/config'
import { z } from 'zod'

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'])
    .default('info'),
  HOST: z.string().default('0.0.0.0'),
  PORT: z.coerce.number().int().positive().default(4200),

  // form-postgres runs on host port 55438.
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1).default('redis://localhost:56379'),

  JWT_SECRET: z.string().min(16).default('dev-secret-change-me-at-least-16-chars'),

  OIDC_ISSUER: z.string().min(1).default('http://localhost:4000'),
  OIDC_CLIENT_ID: z.string().min(1).default('form-admin-dev'),
  OIDC_CLIENT_SECRET: z.string().min(1).default('dev-secret'),

  FORM_BOOTSTRAP_ADMIN_SUB: z.string().optional(),
  FORM_EMERGENCY_TOKEN: z.string().optional(),
  FORM_EMERGENCY_TOKEN_PROD_ALLOW: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),

  // ---------------------------------------------------------------------------
  // Wave 2 Lane L5a — FORMS_ prefixed OIDC + JWT auth vars (cms-api mirror)
  // ---------------------------------------------------------------------------
  FORMS_OIDC_ISSUER_URL: z.string().min(1).optional(),
  FORMS_OIDC_CLIENT_ID: z.string().min(1).default('form-admin'),
  FORMS_OIDC_CLIENT_SECRET: z.string().optional(),
  FORMS_JWT_SECRET: z.string().min(32).optional(),
  FORMS_ACCESS_TOKEN_TTL: z.string().default('15m'),
  FORMS_REFRESH_TOKEN_TTL: z.string().default('30d'),
  FORMS_BOOTSTRAP_ADMIN_SUB: z.string().optional(),
  FORMS_EMERGENCY_TOKEN: z.string().optional(),
  FORMS_SESSION_COOKIE_NAME: z.string().default('forms_session'),
  FORMS_SESSION_COOKIE_DOMAIN: z.string().optional(),

  WEBHOOK_SECRETS_KEY: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, 'WEBHOOK_SECRETS_KEY must be 64 hex chars (32 bytes)')
    .default('0'.repeat(64)),

  PUBLIC_FORM_WEB_URL: z.string().url().default('http://localhost:4202'),

  S3_ENDPOINT: z.string().url().default('http://localhost:59010'),
  S3_BUCKET: z.string().min(1).default('form-uploads'),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1).default('form'),
  S3_SECRET_KEY: z.string().min(1).default('form-dev-secret'),
  S3_PUBLIC_URL: z.string().url().optional(),

  SENTRY_DSN: z.string().url().optional(),

  // ---------------------------------------------------------------------------
  // Phase 3C L22 — ClickHouse analytics drain (optional; service boots without these)
  // ---------------------------------------------------------------------------
  CLICKHOUSE_URL: z.string().url().optional(),
  CLICKHOUSE_USERNAME: z.string().optional(),
  CLICKHOUSE_PASSWORD: z.string().optional(),
  CLICKHOUSE_DATABASE: z.string().optional(),

  // Set to 'true' to start the nightly Postgres→ClickHouse drain cron.
  ENABLE_ANALYTICS_DRAIN: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),

  // Set to 'true' to DELETE source Postgres rows after a successful CH insert.
  // Defaults to false so first drain runs are non-destructive.
  DRAIN_DELETE_SOURCE: z
    .union([z.literal('true'), z.literal('false')])
    .default('false')
    .transform((v) => v === 'true'),

  // ---------------------------------------------------------------------------
  // Phase 3B — Stripe payment integration (optional; service boots without these)
  // ---------------------------------------------------------------------------
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PUBLISHABLE_KEY: z.string().optional(),
  STRIPE_ENV: z.enum(['test', 'live']).default('test'),
})

const parsed = envSchema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((i) => `  ${i.path.join('.')}: ${i.message}`)
    .join('\n')
  throw new Error(`[form-api] Environment validation failed:\n${issues}`)
}

export const env = parsed.data
export type Env = typeof env
