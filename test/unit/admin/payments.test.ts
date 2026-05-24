/**
 * Unit tests for the admin payments route.
 *
 * Uses an in-memory mock Prisma harness — no real database required.
 * Covers:
 *   - list filters by status
 *   - list filters by date range
 *   - detail returns a stripe_dashboard_url
 *   - 404 on unknown payment id
 *   - 404 when form is not found
 */

import { describe, it, expect, beforeEach } from 'vitest'
import Fastify from 'fastify'
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod'
import { paymentsAdminRoutes } from '../../../src/routes/admin/payments.js'
import { buildSuperAdminAbility } from '../../../src/core/auth/rbac.js'

// ── Fixtures ──────────────────────────────────────────────────────────────────

const FORM_ID = '11111111-1111-1111-1111-111111111111'
const FORM_SLUG = 'test-form'
const SUB_ID = '22222222-2222-2222-2222-222222222222'
const PAY_ID_1 = '33333333-3333-3333-3333-333333333333'
const PAY_ID_2 = '44444444-4444-4444-4444-444444444444'

const baseForm = {
  id: FORM_ID,
  slug: FORM_SLUG,
  title: 'Test Form',
  type: 'dynamic',
  currentVersion: 1,
  ownerAccountId: 'acct_1',
  archivedAt: null,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-01T00:00:00Z'),
}

const basePayment1 = {
  id: PAY_ID_1,
  createdAt: new Date('2026-05-01T10:00:00Z'),
  updatedAt: new Date('2026-05-01T10:00:00Z'),
  submissionId: SUB_ID,
  stripePaymentIntentId: 'pi_test_001',
  amountMinor: 1500,
  currency: 'usd',
  status: 'succeeded',
  capturedAt: new Date('2026-05-01T10:01:00Z'),
  stripeEventId: 'evt_001',
  stripeAccountId: null,
  submission: { submittedAt: new Date('2026-05-01T10:00:00Z'), formId: FORM_ID },
}

const basePayment2 = {
  id: PAY_ID_2,
  createdAt: new Date('2026-05-10T12:00:00Z'),
  updatedAt: new Date('2026-05-10T12:00:00Z'),
  submissionId: SUB_ID,
  stripePaymentIntentId: 'pi_test_002',
  amountMinor: 500,
  currency: 'usd',
  status: 'pending',
  capturedAt: null,
  stripeEventId: null,
  stripeAccountId: null,
  submission: { submittedAt: new Date('2026-05-10T12:00:00Z'), formId: FORM_ID },
}

// ── Mock Prisma ───────────────────────────────────────────────────────────────

function buildMockPrisma(opts: {
  formRow?: typeof baseForm | null
  payments?: typeof basePayment1[]
}) {
  const { formRow = baseForm, payments = [basePayment1, basePayment2] } = opts

  const formDefinition = {
    findUnique: async ({ where }: any) => {
      if (!formRow) return null
      if (where.id && where.id !== formRow.id) return null
      if (where.slug && where.slug !== formRow.slug) return null
      return formRow
    },
  }

  const formPayment = {
    findMany: async ({ where, take, skip, orderBy: _o, include: _i }: any) => {
      let results = payments.map((p) => ({ ...p }))

      // status filter
      if (where?.status) {
        results = results.filter((p) => p.status === where.status)
      }

      // date range filter on createdAt
      if (where?.createdAt) {
        if (where.createdAt.gte) {
          results = results.filter(
            (p) => p.createdAt >= new Date(where.createdAt.gte),
          )
        }
        if (where.createdAt.lte) {
          results = results.filter(
            (p) => p.createdAt <= new Date(where.createdAt.lte),
          )
        }
      }

      const offset = skip ?? 0
      const limit = take ?? results.length
      return results.slice(offset, offset + limit)
    },
    count: async ({ where }: any) => {
      let results = payments.slice()
      if (where?.status) {
        results = results.filter((p) => p.status === where.status)
      }
      if (where?.createdAt) {
        if (where.createdAt.gte) {
          results = results.filter(
            (p) => p.createdAt >= new Date(where.createdAt.gte),
          )
        }
        if (where.createdAt.lte) {
          results = results.filter(
            (p) => p.createdAt <= new Date(where.createdAt.lte),
          )
        }
      }
      return results.length
    },
    findUnique: async ({ where }: any) => {
      const p = payments.find((row) => row.id === where.id)
      return p ? { ...p } : null
    },
  }

  return { formDefinition, formPayment }
}

// ── Build test app ────────────────────────────────────────────────────────────

async function buildTestApp(opts: {
  formRow?: typeof baseForm | null
  payments?: typeof basePayment1[]
} = {}) {
  const mockPrisma = buildMockPrisma(opts)
  const app = Fastify()
  app.setValidatorCompiler(validatorCompiler)
  app.setSerializerCompiler(serializerCompiler)

  app.decorate('prisma', mockPrisma)
  app.decorate('authenticate', async (req: any) => {
    req.session = {
      sub: 'acct_admin',
      roles: ['super-admin'],
      abilities: buildSuperAdminAbility(),
      sid: 'test-session',
      iat: 0,
    }
  })

  await app.register(paymentsAdminRoutes)
  return app
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Admin payments routes', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>

  beforeEach(async () => {
    app = await buildTestApp()
  })

  // ── List: basic ─────────────────────────────────────────────────────────────

  it('returns 200 with items and total for a valid form id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/forms/${FORM_ID}/payments`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(2)
    expect(body.items).toHaveLength(2)
    expect(body.items[0]).toHaveProperty('stripePaymentIntentId')
  })

  it('resolves form by slug', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/forms/${FORM_SLUG}/payments`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe(2)
  })

  it('returns 404 when form is not found', async () => {
    const localApp = await buildTestApp({ formRow: null })
    const res = await localApp.inject({
      method: 'GET',
      url: `/v1/admin/forms/nonexistent-form/payments`,
    })
    expect(res.statusCode).toBe(404)
  })

  // ── List: status filter ─────────────────────────────────────────────────────

  it('filters by status=succeeded', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/forms/${FORM_ID}/payments?status=succeeded`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items[0].status).toBe('succeeded')
  })

  it('filters by status=pending', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/forms/${FORM_ID}/payments?status=pending`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items[0].status).toBe('pending')
  })

  it('returns empty when status=failed and no payments match', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/forms/${FORM_ID}/payments?status=failed`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(0)
    expect(body.items).toHaveLength(0)
  })

  // ── List: date range filter ──────────────────────────────────────────────────

  it('filters by from date — excludes earlier payment', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/forms/${FORM_ID}/payments?from=2026-05-05T00:00:00Z`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items[0].id).toBe(PAY_ID_2)
  })

  it('filters by to date — excludes later payment', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/forms/${FORM_ID}/payments?to=2026-05-05T00:00:00Z`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.total).toBe(1)
    expect(body.items[0].id).toBe(PAY_ID_1)
  })

  it('handles from+to range narrowing to zero results', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/forms/${FORM_ID}/payments?from=2026-06-01T00:00:00Z&to=2026-06-02T00:00:00Z`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().total).toBe(0)
  })

  // ── Detail: dashboard URL ───────────────────────────────────────────────────

  it('GET /v1/admin/payments/:id returns full row + stripe_dashboard_url (test mode)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/payments/${PAY_ID_1}`,
    })
    expect(res.statusCode).toBe(200)
    const body = res.json()
    expect(body.id).toBe(PAY_ID_1)
    expect(body.stripe_dashboard_url).toBe(
      `https://dashboard.stripe.com/test/payments/pi_test_001`,
    )
  })

  it('detail includes submission timestamp', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/payments/${PAY_ID_1}`,
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().submission.submittedAt).toBeDefined()
  })

  // ── Detail: 404 ─────────────────────────────────────────────────────────────

  it('returns 404 for unknown payment id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/admin/payments/00000000-0000-0000-0000-000000000000`,
    })
    expect(res.statusCode).toBe(404)
  })
})
