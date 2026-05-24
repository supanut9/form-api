/**
 * Unit tests for PlanService.
 *
 * Uses an in-memory mock Prisma client and a minimal inline Redis mock.
 * No ioredis-mock dependency — a plain Map + expire tracking is sufficient.
 */

process.env['DATABASE_URL'] = 'postgresql://test:test@localhost:55438/test'
process.env['FORMS_JWT_SECRET'] = 'test-jwt-secret-must-be-at-least-32-chars!!'

import { describe, it, expect, beforeEach } from 'vitest'
import { PlanService } from '../../../src/core/workspaces/plan.service.js'

// ---------------------------------------------------------------------------
// Inline Redis mock (~20 lines; no external dep)
// ---------------------------------------------------------------------------

type RedisMockState = Map<string, string>

function buildRedisMock(state: RedisMockState = new Map()) {
  return {
    _state: state,
    async get(key: string): Promise<string | null> {
      return state.get(key) ?? null
    },
    async incr(key: string): Promise<number> {
      const prev = parseInt(state.get(key) ?? '0', 10)
      const next = prev + 1
      state.set(key, String(next))
      return next
    },
    // Mimics EXPIRE key seconds NX — only sets if no expiry (here: if not in ttl map).
    // We track "has expiry" with a separate set and ignore the NX semantics for tests.
    async expire(_key: string, _seconds: number, _mode?: string): Promise<number> {
      return 1
    },
  }
}

// ---------------------------------------------------------------------------
// Workspace plan fixture
// ---------------------------------------------------------------------------

const FREE_PLAN = {
  id: 'plan-free',
  slug: 'free' as const,
  name: 'Free',
  monthlySubmissionQuota: 100,
  maxForms: 3,
  maxFileSizeMb: 5,
  paymentsEnabled: false,
  experimentsEnabled: false,
  analyticsRetentionDays: 30,
  stripePriceId: null,
}

const PRO_PLAN = {
  id: 'plan-pro',
  slug: 'pro' as const,
  name: 'Pro',
  monthlySubmissionQuota: 10_000,
  maxForms: 100,
  maxFileSizeMb: 50,
  paymentsEnabled: true,
  experimentsEnabled: true,
  analyticsRetentionDays: 365,
  stripePriceId: 'price_pro_monthly',
}

const WORKSPACE_ID = 'ws-00000000-0000-0000-0000-000000000001'

// ---------------------------------------------------------------------------
// Mock Prisma factory
// ---------------------------------------------------------------------------

function buildMockPrisma(plan = FREE_PLAN, formCount = 0) {
  return {
    workspace: {
      findUnique: async ({ where }: any) => {
        if (where.id === WORKSPACE_ID) {
          return { id: WORKSPACE_ID, plan }
        }
        return null
      },
    },
    formDefinition: {
      count: async (_args: any) => formCount,
    },
  } as any
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PlanService.getEffectivePlan', () => {
  it('returns the plan for a known workspace', async () => {
    const prisma = buildMockPrisma(FREE_PLAN)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    const plan = await service.getEffectivePlan(WORKSPACE_ID)
    expect(plan.slug).toBe('free')
    expect(plan.maxForms).toBe(3)
  })

  it('returns cached plan on second call', async () => {
    let calls = 0
    const prisma = {
      workspace: {
        findUnique: async () => {
          calls++
          return { id: WORKSPACE_ID, plan: FREE_PLAN }
        },
      },
      formDefinition: { count: async () => 0 },
    } as any
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await service.getEffectivePlan(WORKSPACE_ID)
    await service.getEffectivePlan(WORKSPACE_ID)
    expect(calls).toBe(1)
  })

  it('re-fetches after invalidateWorkspace', async () => {
    let calls = 0
    const prisma = {
      workspace: {
        findUnique: async () => {
          calls++
          return { id: WORKSPACE_ID, plan: FREE_PLAN }
        },
      },
      formDefinition: { count: async () => 0 },
    } as any
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await service.getEffectivePlan(WORKSPACE_ID)
    service.invalidateWorkspace(WORKSPACE_ID)
    await service.getEffectivePlan(WORKSPACE_ID)
    expect(calls).toBe(2)
  })

  it('throws workspace_not_found for unknown workspace', async () => {
    const prisma = {
      workspace: { findUnique: async () => null },
      formDefinition: { count: async () => 0 },
    } as any
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.getEffectivePlan('unknown-ws')).rejects.toMatchObject({
      code: 'workspace_not_found',
    })
  })
})

// ---------------------------------------------------------------------------

describe('PlanService.assertCanCreateForm', () => {
  it('passes when current form count is under limit', async () => {
    const prisma = buildMockPrisma(FREE_PLAN, 2) // limit is 3, current is 2
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertCanCreateForm(WORKSPACE_ID)).resolves.toBeUndefined()
  })

  it('passes exactly at limit - 1', async () => {
    const prisma = buildMockPrisma(FREE_PLAN, 2)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)
    await expect(service.assertCanCreateForm(WORKSPACE_ID)).resolves.toBeUndefined()
  })

  it('throws plan_cap_exceeded when at the limit', async () => {
    const prisma = buildMockPrisma(FREE_PLAN, 3) // count == maxForms
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertCanCreateForm(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'plan_cap_exceeded',
      details: expect.objectContaining({ cap: 'max_forms', current: 3, limit: 3 }),
    })
  })

  it('throws plan_cap_exceeded when over the limit', async () => {
    const prisma = buildMockPrisma(FREE_PLAN, 10)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertCanCreateForm(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'plan_cap_exceeded',
    })
  })
})

// ---------------------------------------------------------------------------

describe('PlanService.assertCanAcceptSubmission / recordSubmission', () => {
  it('passes when counter is zero', async () => {
    const prisma = buildMockPrisma(FREE_PLAN)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertCanAcceptSubmission(WORKSPACE_ID)).resolves.toBeUndefined()
  })

  it('passes when counter is below quota', async () => {
    const state: RedisMockState = new Map()
    const yearMonth = new Date().toISOString().slice(0, 7)
    state.set(`submissions:${WORKSPACE_ID}:${yearMonth}`, '50')
    const prisma = buildMockPrisma(FREE_PLAN) // quota = 100
    const redis = buildRedisMock(state)
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertCanAcceptSubmission(WORKSPACE_ID)).resolves.toBeUndefined()
  })

  it('throws quota_exhausted when counter equals quota', async () => {
    const state: RedisMockState = new Map()
    const yearMonth = new Date().toISOString().slice(0, 7)
    state.set(`submissions:${WORKSPACE_ID}:${yearMonth}`, '100') // exactly at quota
    const prisma = buildMockPrisma(FREE_PLAN) // quota = 100
    const redis = buildRedisMock(state)
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertCanAcceptSubmission(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'quota_exhausted',
      details: expect.objectContaining({
        cap: 'monthly_submissions',
        current: 100,
        limit: 100,
      }),
    })
  })

  it('throws quota_exhausted with reset_at when over quota', async () => {
    const state: RedisMockState = new Map()
    const yearMonth = new Date().toISOString().slice(0, 7)
    state.set(`submissions:${WORKSPACE_ID}:${yearMonth}`, '150')
    const prisma = buildMockPrisma(FREE_PLAN)
    const redis = buildRedisMock(state)
    const service = new PlanService(prisma, redis as any)

    const err = await service.assertCanAcceptSubmission(WORKSPACE_ID).catch((e) => e)
    expect(err.code).toBe('quota_exhausted')
    expect(err.details.reset_at).toBeDefined()
    expect(new Date(err.details.reset_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('recordSubmission increments the counter atomically', async () => {
    const state: RedisMockState = new Map()
    const prisma = buildMockPrisma(FREE_PLAN)
    const redis = buildRedisMock(state)
    const service = new PlanService(prisma, redis as any)

    const r1 = await service.recordSubmission(WORKSPACE_ID)
    expect(r1.monthCount).toBe(1)

    const r2 = await service.recordSubmission(WORKSPACE_ID)
    expect(r2.monthCount).toBe(2)
  })

  it('monthly key resets for a different month prefix', async () => {
    const state: RedisMockState = new Map()
    // Seed a key for a previous month
    state.set(`submissions:${WORKSPACE_ID}:2026-04`, '99')
    const prisma = buildMockPrisma(FREE_PLAN)
    const redis = buildRedisMock(state)
    const service = new PlanService(prisma, redis as any)

    // Current month key doesn't exist → counter starts at 0
    await expect(service.assertCanAcceptSubmission(WORKSPACE_ID)).resolves.toBeUndefined()
  })
})

// ---------------------------------------------------------------------------

describe('PlanService feature gates', () => {
  it('getFeatureGates returns correct values for free plan', async () => {
    const prisma = buildMockPrisma(FREE_PLAN)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    const gates = await service.getFeatureGates(WORKSPACE_ID)
    expect(gates.payments_enabled).toBe(false)
    expect(gates.experiments_enabled).toBe(false)
    expect(gates.max_file_size_mb).toBe(5)
    expect(gates.analytics_retention_days).toBe(30)
  })

  it('getFeatureGates returns correct values for pro plan', async () => {
    const prisma = buildMockPrisma(PRO_PLAN)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    const gates = await service.getFeatureGates(WORKSPACE_ID)
    expect(gates.payments_enabled).toBe(true)
    expect(gates.experiments_enabled).toBe(true)
    expect(gates.max_file_size_mb).toBe(50)
  })

  it('assertPaymentsEnabled passes on pro plan', async () => {
    const prisma = buildMockPrisma(PRO_PLAN)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertPaymentsEnabled(WORKSPACE_ID)).resolves.toBeUndefined()
  })

  it('assertPaymentsEnabled throws feature_not_in_plan on free plan', async () => {
    const prisma = buildMockPrisma(FREE_PLAN)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertPaymentsEnabled(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'feature_not_in_plan',
      details: expect.objectContaining({ feature: 'payments' }),
    })
  })

  it('assertExperimentsEnabled passes on pro plan', async () => {
    const prisma = buildMockPrisma(PRO_PLAN)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertExperimentsEnabled(WORKSPACE_ID)).resolves.toBeUndefined()
  })

  it('assertExperimentsEnabled throws feature_not_in_plan on free plan', async () => {
    const prisma = buildMockPrisma(FREE_PLAN)
    const redis = buildRedisMock()
    const service = new PlanService(prisma, redis as any)

    await expect(service.assertExperimentsEnabled(WORKSPACE_ID)).rejects.toMatchObject({
      code: 'feature_not_in_plan',
      details: expect.objectContaining({ feature: 'experiments' }),
    })
  })
})
