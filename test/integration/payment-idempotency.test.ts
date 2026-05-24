/**
 * Integration test — Stripe webhook idempotency (in-process Fastify).
 *
 * Skips automatically when INTEGRATION_TESTS env var is not set so local devs
 * without a running Postgres don't see red. CI sets INTEGRATION_TESTS=true.
 *
 * Strategy:
 *   - `stripe` SDK is intercepted via vi.hoisted + vi.mock before any module
 *     import so that no real Stripe HTTP calls are made.
 *   - `stripe.webhooks.constructEvent` returns a fabricated Stripe event
 *     with a fixed event.id.
 *   - A real FormSubmission row is seeded so the FK from FormPayment is
 *     satisfied. Then a FormPayment row is inserted with the matching
 *     stripePaymentIntentId.
 *   - The SAME webhook body is posted TWICE to
 *     POST /v1/internal/stripe/webhook.
 *   - First call: 200 { idempotent: false (omitted) }, row updated.
 *   - Second call: 200 { idempotent: true }, row unchanged.
 */

// ── Skip guard ─────────────────────────────────────────────────────────────────

const RUN = Boolean(process.env.INTEGRATION_TESTS)

// ── Hoist Stripe mock BEFORE any other import ──────────────────────────────────

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'

const FIXED_EVENT_ID = 'evt_integration_idempotency_001'
const FIXED_INTENT_ID = 'pi_integration_test_001'

const mockConstructEvent = vi.hoisted(() => vi.fn())
const mockPaymentIntentsRetrieve = vi.hoisted(() => vi.fn())

vi.mock('stripe', () => {
  function MockStripe(this: any) {
    this.paymentIntents = {
      create: vi.fn(),
      retrieve: mockPaymentIntentsRetrieve,
    }
    this.webhooks = {
      constructEvent: mockConstructEvent,
    }
  }
  return { default: MockStripe }
})

// Also mock env so STRIPE_ vars are present without a real .env
vi.mock('../../src/config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config/env.js')>()
  return {
    env: {
      ...original.env,
      STRIPE_SECRET_KEY: 'sk_test_mock',
      STRIPE_WEBHOOK_SECRET: 'whsec_mock_integration',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
    },
  }
})

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import crypto from 'node:crypto'
import { buildServer } from '../../src/server.js'

// ── Prisma factory ────────────────────────────────────────────────────────────

function buildPrisma(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 3,
    idleTimeoutMillis: 10_000,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWebhookBody() {
  // A minimal Stripe payment_intent.succeeded event JSON body.
  // The actual bytes don't matter because constructEvent is mocked.
  return Buffer.from(
    JSON.stringify({
      id: FIXED_EVENT_ID,
      type: 'payment_intent.succeeded',
      data: { object: { id: FIXED_INTENT_ID, created: Math.floor(Date.now() / 1000) } },
    }),
  )
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('payment-idempotency integration', () => {
  let prisma: PrismaClient
  let app: Awaited<ReturnType<typeof buildServer>>
  let submissionId: string
  let formPaymentId: string

  const FORM_SLUG = 'payment-idempotency-integration-test'
  const OWNER = 'integration-seed'

  beforeAll(async () => {
    prisma = buildPrisma()
    await prisma.$connect()

    // ── Seed: form + published version ──────────────────────────────────────
    let form = await prisma.formDefinition.findFirst({ where: { slug: FORM_SLUG } })

    if (!form) {
      form = await prisma.formDefinition.create({
        data: {
          type: 'dynamic',
          title: 'Payment Idempotency Integration Test',
          slug: FORM_SLUG,
          currentVersion: 1,
          ownerAccountId: OWNER,
        },
      })

      const spec = {
        id: form.id,
        version: 1,
        title: 'Payment Idempotency Test',
        type: 'dynamic',
        access: { mode: 'public_anonymous', require_account: false, anonymous_allowed: true },
        pages: [{ id: 'pg_1', title: 'Page 1', fields: [] }],
        payment: {
          mode: 'fixed',
          amount_minor: 1500,
          currency: 'usd',
          capture_intent: 'on_submit',
          required_for_submit: true,
        },
      }

      await prisma.formVersion.create({
        data: {
          formId: form.id,
          version: 1,
          specJson: spec,
          schemaHash: crypto.createHash('sha256').update(JSON.stringify(spec)).digest('hex'),
          publishedAt: new Date(),
          publishedBy: OWNER,
          isCurrent: true,
        },
      })
    }

    // ── Seed: a submission row so the FormPayment FK is satisfied ─────────
    const sub = await prisma.formSubmission.create({
      data: {
        formId: form.id,
        version: 1,
        payloadJsonb: {},
        ipHash: 'hash_integration',
        userAgent: 'integration-test',
        source: 'api',
      },
    })
    submissionId = sub.id

    // ── Seed: a FormPayment row with stripePaymentIntentId + no stripeEventId ──
    const prismaAny = prisma as unknown as Record<string, any>
    const payment = await prismaAny['formPayment'].create({
      data: {
        submissionId,
        stripePaymentIntentId: FIXED_INTENT_ID,
        amountMinor: 1500,
        currency: 'usd',
        status: 'pending',
        stripeEventId: null,
        stripeAccountId: null,
      },
    })
    formPaymentId = payment.id

    // ── Boot Fastify in-process ──────────────────────────────────────────────
    app = await buildServer()
    await app.ready()

    // ── Configure the mock: constructEvent returns our fixed event ───────────
    mockConstructEvent.mockReturnValue({
      id: FIXED_EVENT_ID,
      type: 'payment_intent.succeeded',
      data: {
        object: {
          id: FIXED_INTENT_ID,
          created: Math.floor(Date.now() / 1000),
        },
      },
    })
  })

  afterAll(async () => {
    // Clean up in reverse FK order
    const prismaAny = prisma as unknown as Record<string, any>
    await prismaAny['formPayment'].deleteMany({ where: { id: formPaymentId } })
    await prisma.formSubmission.deleteMany({ where: { id: submissionId } })

    await app.close()
    await prisma.$disconnect()
  })

  const STRIPE_SIG = 't=1234567890,v1=fakesignature'

  it('first webhook call returns 200 and updates the form_payments row', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/stripe/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': STRIPE_SIG,
      },
      body: makeWebhookBody(),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ idempotent?: boolean; ignored?: boolean }>()
    // First call: idempotent key should NOT be returned (or explicitly false)
    expect(body.idempotent).toBeUndefined()
    expect(body.ignored).toBeUndefined()

    // Verify DB row was updated
    const prismaAny = prisma as unknown as Record<string, any>
    const row = await prismaAny['formPayment'].findUnique({ where: { id: formPaymentId } })
    expect(row).not.toBeNull()
    expect(row.stripeEventId).toBe(FIXED_EVENT_ID)
    expect(row.status).toBe('succeeded')
  })

  it('second webhook call (same event id) returns 200 { idempotent: true } and row is unchanged', async () => {
    // Record the row state before re-posting
    const prismaAny = prisma as unknown as Record<string, any>
    const before = await prismaAny['formPayment'].findUnique({ where: { id: formPaymentId } })

    const res = await app.inject({
      method: 'POST',
      url: '/v1/internal/stripe/webhook',
      headers: {
        'content-type': 'application/json',
        'stripe-signature': STRIPE_SIG,
      },
      body: makeWebhookBody(),
    })

    expect(res.statusCode).toBe(200)
    const body = res.json<{ idempotent?: boolean }>()
    expect(body.idempotent).toBe(true)

    // Row must be identical (createdAt + status + stripeEventId unchanged)
    const after = await prismaAny['formPayment'].findUnique({ where: { id: formPaymentId } })
    expect(after.stripeEventId).toBe(before.stripeEventId)
    expect(after.status).toBe(before.status)
    expect(after.createdAt.toISOString()).toBe(before.createdAt.toISOString())
  })

  it('stripe_event_id column on form_payments matches the fixed event id', async () => {
    const prismaAny = prisma as unknown as Record<string, any>
    const row = await prismaAny['formPayment'].findUnique({
      where: { stripeEventId: FIXED_EVENT_ID },
    })
    expect(row).not.toBeNull()
    expect(row.stripeEventId).toBe(FIXED_EVENT_ID)
  })
})
