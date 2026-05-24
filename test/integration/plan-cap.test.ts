/**
 * Integration test — plan form-count cap and plan upgrade unblocking.
 *
 * Seeds wsA on the `free` plan (maxForms = 10 per migration seed).
 * Creates 10 forms — all succeed.
 * 11th create via PlanService.assertCanCreateForm → throws plan_cap_exceeded.
 * Upgrades wsA's planId to `pro` via direct Prisma update + invalidateWorkspace.
 * 11th create now succeeds.
 *
 * Gated on INTEGRATION_TESTS=true.
 */

// ── Skip guard ─────────────────────────────────────────────────────────────────

const RUN = Boolean(process.env.INTEGRATION_TESTS)

// ── Mocks (required before any src/ import) ────────────────────────────────────

import { vi, describe, it, expect, beforeAll, afterAll } from 'vitest'

vi.mock('stripe', () => {
  function MockStripe(this: any) {
    this.paymentIntents = { create: vi.fn(), retrieve: vi.fn() }
    this.webhooks = { constructEvent: vi.fn() }
  }
  return { default: MockStripe }
})

vi.mock('../../src/config/env.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/config/env.js')>()
  return {
    env: {
      ...original.env,
      STRIPE_SECRET_KEY: 'sk_test_mock',
      STRIPE_WEBHOOK_SECRET: 'whsec_mock',
      STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
    },
  }
})

// ── Imports ───────────────────────────────────────────────────────────────────

import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import pg from 'pg'
import IORedis from 'ioredis'
import { PlanService } from '../../src/core/workspaces/plan.service.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildPrisma(): PrismaClient {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_URL!,
    max: 3,
    idleTimeoutMillis: 10_000,
  })
  const adapter = new PrismaPg(pool)
  return new PrismaClient({ adapter })
}

function buildRedis(): IORedis {
  return new IORedis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: 2,
    lazyConnect: true,
  })
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('plan-cap integration', () => {
  let prisma: PrismaClient
  let redis: IORedis
  let planService: PlanService

  let wsAId: string
  let freePlanId: string
  let proPlanId: string
  const OWNER = 'plan-cap-integration-owner'
  const seededFormIds: string[] = []

  beforeAll(async () => {
    prisma = buildPrisma()
    await prisma.$connect()

    redis = buildRedis()
    await redis.connect()

    planService = new PlanService(prisma, redis)

    const prismaAny = prisma as any

    // Resolve plan ids
    const freePlan = await prismaAny.workspacePlan.findUnique({ where: { slug: 'free' } })
    const proPlan = await prismaAny.workspacePlan.findUnique({ where: { slug: 'pro' } })
    if (!freePlan || !proPlan) throw new Error('plans not seeded — run migration 20260701 first')
    freePlanId = freePlan.id
    proPlanId = proPlan.id

    // Seed workspace on free plan
    const ws = await prismaAny.workspace.create({
      data: {
        slug: `plan-cap-wsa-${Date.now()}`,
        name: 'Plan Cap WS-A',
        planId: freePlanId,
        createdByAccountId: OWNER,
      },
    })
    wsAId = ws.id

    await prismaAny.workspaceMember.create({
      data: { workspaceId: wsAId, accountId: OWNER, role: 'owner', joinedAt: new Date() },
    })
  })

  afterAll(async () => {
    // Clean up forms, members, workspace
    if (seededFormIds.length > 0) {
      await prisma.formDefinition.deleteMany({ where: { id: { in: seededFormIds } } })
    }
    const prismaAny = prisma as any
    await prismaAny.workspaceMember.deleteMany({ where: { workspaceId: wsAId } })
    await prismaAny.workspace.deleteMany({ where: { id: wsAId } })

    await redis.quit()
    await prisma.$disconnect()
  })

  it('creates 10 forms without hitting the free plan cap (maxForms = 10)', async () => {
    for (let i = 1; i <= 10; i++) {
      // Assert can create (should not throw)
      await expect(planService.assertCanCreateForm(wsAId)).resolves.toBeUndefined()

      const form = await prisma.formDefinition.create({
        data: {
          type: 'dynamic',
          title: `Cap Test Form ${i}`,
          slug: `plan-cap-form-${wsAId.slice(0, 8)}-${i}`,
          currentVersion: 1,
          ownerAccountId: OWNER,
          workspaceId: wsAId,
        },
      })
      seededFormIds.push(form.id)
    }

    // Verify 10 forms exist for this workspace
    const count = await prisma.formDefinition.count({
      where: { workspaceId: wsAId, archivedAt: null },
    })
    expect(count).toBe(10)
  })

  it('11th assertCanCreateForm throws plan_cap_exceeded on free plan', async () => {
    await expect(planService.assertCanCreateForm(wsAId)).rejects.toMatchObject({
      code: 'plan_cap_exceeded',
      details: expect.objectContaining({
        cap: 'max_forms',
        current: 10,
        limit: 10,
      }),
    })
  })

  it('after upgrading to pro and invalidating cache, 11th create is allowed', async () => {
    // Upgrade wsA to pro
    const prismaAny = prisma as any
    await prismaAny.workspace.update({
      where: { id: wsAId },
      data: { planId: proPlanId },
    })

    // Invalidate the LRU cache so next call re-fetches from DB
    planService.invalidateWorkspace(wsAId)

    // Now assertCanCreateForm should pass (pro maxForms = 500)
    await expect(planService.assertCanCreateForm(wsAId)).resolves.toBeUndefined()

    // Actually create the 11th form
    const form11 = await prisma.formDefinition.create({
      data: {
        type: 'dynamic',
        title: 'Cap Test Form 11',
        slug: `plan-cap-form-${wsAId.slice(0, 8)}-11`,
        currentVersion: 1,
        ownerAccountId: OWNER,
        workspaceId: wsAId,
      },
    })
    seededFormIds.push(form11.id)

    const count = await prisma.formDefinition.count({
      where: { workspaceId: wsAId, archivedAt: null },
    })
    expect(count).toBe(11)
  })
})
