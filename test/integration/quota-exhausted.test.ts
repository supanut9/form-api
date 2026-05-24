/**
 * Integration test — monthly submission quota exhaustion.
 *
 * Seeds wsA on the `starter` plan (monthlySubmissionQuota = 1000).
 * Pre-populates the Redis counter to 999.
 * Submit once → assertCanAcceptSubmission + recordSubmission succeed.
 * Submit again → assertCanAcceptSubmission throws quota_exhausted.
 * Verifies the Redis counter increments to 1001 (soft denial: write still happens
 * via recordSubmission even when quota is exceeded — the quota gate is checked
 * BEFORE writing, so recordSubmission is only called for accepted submissions).
 *
 * The test directly calls PlanService methods — no HTTP layer required.
 *
 * Gated on INTEGRATION_TESTS=true.
 */

// ── Skip guard ─────────────────────────────────────────────────────────────────

const RUN = Boolean(process.env.INTEGRATION_TESTS)

// ── Mocks ─────────────────────────────────────────────────────────────────────

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

function currentYearMonth(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe.skipIf(!RUN)('quota-exhausted integration', () => {
  let prisma: PrismaClient
  let redis: IORedis
  let planService: PlanService

  let wsAId: string
  const OWNER = 'quota-exhausted-integration-owner'
  let redisKey: string

  beforeAll(async () => {
    prisma = buildPrisma()
    await prisma.$connect()

    redis = buildRedis()
    await redis.connect()

    planService = new PlanService(prisma, redis)

    const prismaAny = prisma as any

    // Resolve starter plan
    const starterPlan = await prismaAny.workspacePlan.findUnique({ where: { slug: 'starter' } })
    if (!starterPlan) throw new Error('starter plan not seeded — run migration 20260701 first')
    // starter: monthlySubmissionQuota = 1000 (per migration seed)
    expect(starterPlan.monthlySubmissionQuota).toBe(1000)

    // Seed workspace on starter plan
    const ws = await prismaAny.workspace.create({
      data: {
        slug: `quota-exhausted-wsa-${Date.now()}`,
        name: 'Quota Exhausted WS-A',
        planId: starterPlan.id,
        createdByAccountId: OWNER,
      },
    })
    wsAId = ws.id

    await prismaAny.workspaceMember.create({
      data: { workspaceId: wsAId, accountId: OWNER, role: 'owner', joinedAt: new Date() },
    })

    // Determine the Redis key and pre-populate to 999
    redisKey = `submissions:${wsAId}:${currentYearMonth()}`
    await redis.set(redisKey, '999')
  })

  afterAll(async () => {
    // Clean up Redis key
    await redis.del(redisKey)

    const prismaAny = prisma as any
    await prismaAny.workspaceMember.deleteMany({ where: { workspaceId: wsAId } })
    await prismaAny.workspace.deleteMany({ where: { id: wsAId } })

    await redis.quit()
    await prisma.$disconnect()
  })

  it('1000th submission (counter at 999) is accepted — assertCanAcceptSubmission passes', async () => {
    // Counter is 999, quota is 1000 → should pass
    await expect(planService.assertCanAcceptSubmission(wsAId)).resolves.toBeUndefined()
  })

  it('recordSubmission increments counter to 1000', async () => {
    const { monthCount } = await planService.recordSubmission(wsAId)
    expect(monthCount).toBe(1000)

    const raw = await redis.get(redisKey)
    expect(parseInt(raw!, 10)).toBe(1000)
  })

  it('1001st submission (counter at 1000) is denied — quota_exhausted with reset_at', async () => {
    const err = await planService.assertCanAcceptSubmission(wsAId).catch((e) => e)
    expect(err.code).toBe('quota_exhausted')
    expect(err.details.current).toBe(1000)
    expect(err.details.limit).toBe(1000)
    expect(err.details.reset_at).toBeDefined()

    const resetAt = new Date(err.details.reset_at)
    expect(resetAt.getTime()).toBeGreaterThan(Date.now())
  })

  it('recordSubmission still increments counter to 1001 (soft denial, write-through)', async () => {
    // The quota gate is a pre-check. The actual recordSubmission after a
    // successful DB insert is a separate atomic step. We call it directly here
    // to verify the counter increments regardless (it is not a write-prevention;
    // soft denial happens in assertCanAcceptSubmission before the write).
    const { monthCount } = await planService.recordSubmission(wsAId)
    expect(monthCount).toBe(1001)

    const raw = await redis.get(redisKey)
    expect(parseInt(raw!, 10)).toBe(1001)
  })
})
