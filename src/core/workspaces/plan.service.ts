/**
 * PlanService — workspace plan enforcement
 *
 * Enforces feature gates and quota caps for a workspace.
 *
 * - Plan rows live in the `workspace_plans` table (added by L17 migration).
 * - The workspace's current plan is loaded via Prisma and cached in-memory
 *   (LRU, TTL 60 s) to avoid a DB round-trip on every request.
 * - Rolling monthly submission counters live in Redis using the existing
 *   BullMQ ioredis connection (src/queues/connection.ts).
 *
 * Redis key shape:
 *   submissions:{workspaceId}:{YYYY-MM}
 *
 * Atomicity story for quota counting:
 *   INCR returns the new counter value atomically. On the first INCR of the
 *   month the key does not exist yet; Redis creates it with value 0 and
 *   returns 1. We then issue `EXPIRE key 2764800 NX` (32 days in seconds).
 *   The NX flag means the expiry is only set if the key has NO expiry —
 *   subsequent INCRs within the same month do not reset the TTL, so the
 *   counter naturally expires ~32 days after the first write of the month
 *   (always well into the next calendar month). Redis 7 supports EXPIRE NX.
 *
 * L17 Prisma model contract (read-only here, no schema.prisma changes):
 *   WorkspacePlan { id, slug, name, monthlySubmissionQuota, maxForms,
 *                   maxFileSizeMb, paymentsEnabled, experimentsEnabled,
 *                   analyticsRetentionDays, stripePriceId }
 *   Workspace     { id, planId, ... }
 */

import { LRUCache } from 'lru-cache'
import type { PrismaClient } from '@prisma/client'
import type IORedis from 'ioredis'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspacePlan {
  id: string
  slug: 'free' | 'starter' | 'pro' | 'business'
  name: string
  monthlySubmissionQuota: number
  maxForms: number
  maxFileSizeMb: number
  paymentsEnabled: boolean
  experimentsEnabled: boolean
  analyticsRetentionDays: number
  stripePriceId: string | null
}

export interface FeatureGates {
  payments_enabled: boolean
  experiments_enabled: boolean
  analytics_retention_days: number
  max_file_size_mb: number
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function planCapError(
  cap: string,
  extra: Record<string, unknown>,
): Error & { code: string; details: Record<string, unknown> } {
  const err = new Error(`Plan cap exceeded: ${cap}`) as Error & {
    code: string
    details: Record<string, unknown>
  }
  err.code = 'plan_cap_exceeded'
  err.details = { cap, ...extra }
  return err
}

function quotaExhaustedError(
  extra: Record<string, unknown>,
): Error & { code: string; details: Record<string, unknown> } {
  const err = new Error('Monthly submission quota exhausted') as Error & {
    code: string
    details: Record<string, unknown>
  }
  err.code = 'quota_exhausted'
  err.details = { cap: 'monthly_submissions', ...extra }
  return err
}

function featureGateError(
  feature: string,
): Error & { code: string; details: Record<string, unknown> } {
  const err = new Error(`Feature not available in current plan: ${feature}`) as Error & {
    code: string
    details: Record<string, unknown>
  }
  err.code = 'feature_not_in_plan'
  err.details = { feature }
  return err
}

// ---------------------------------------------------------------------------
// Redis key helpers
// ---------------------------------------------------------------------------

function submissionKey(workspaceId: string, yearMonth: string): string {
  return `submissions:${workspaceId}:${yearMonth}`
}

function currentYearMonth(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

/** First second of next calendar month (UTC) — used as reset_at for the caller. */
function nextMonthResetAt(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1))
}

// 32 days in seconds — generous enough to outlive any calendar month
const EXPIRE_SECONDS = 32 * 24 * 60 * 60

// ---------------------------------------------------------------------------
// PlanService
// ---------------------------------------------------------------------------

export class PlanService {
  private readonly _prisma: PrismaClient
  private readonly _redis: IORedis
  private readonly _cache: LRUCache<string, WorkspacePlan>

  constructor(prisma: PrismaClient, redis: IORedis) {
    this._prisma = prisma
    this._redis = redis
    this._cache = new LRUCache<string, WorkspacePlan>({
      max: 1000,
      ttl: 60_000, // 60 s
    })
  }

  // ── Plan loading ────────────────────────────────────────────────────────────

  /**
   * Returns the plan for the workspace, served from an in-memory LRU cache
   * with a 60-second TTL. Use getEffectivePlanFresh for a guaranteed fresh read.
   */
  async getEffectivePlan(workspaceId: string): Promise<WorkspacePlan> {
    const cached = this._cache.get(workspaceId)
    if (cached) return cached
    return this.getEffectivePlanFresh(workspaceId)
  }

  /** Bypasses the LRU cache and always hits the database. */
  async getEffectivePlanFresh(workspaceId: string): Promise<WorkspacePlan> {
    // L17 adds Workspace and WorkspacePlan models; access via (prisma as any)
    // so this file compiles before L17's migration is applied.
    const prisma = this._prisma as any

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: {
        plan: {
          select: {
            id: true,
            slug: true,
            name: true,
            monthlySubmissionQuota: true,
            maxForms: true,
            maxFileSizeMb: true,
            paymentsEnabled: true,
            experimentsEnabled: true,
            analyticsRetentionDays: true,
            stripePriceId: true,
          },
        },
      },
    })

    if (!workspace) {
      const err = new Error(`Workspace not found: ${workspaceId}`) as Error & { code: string }
      err.code = 'workspace_not_found'
      throw err
    }

    const plan: WorkspacePlan = workspace.plan
    this._cache.set(workspaceId, plan)
    return plan
  }

  /**
   * Drops the LRU cache entry for a workspace.
   * Called by the billing service (L19) when a plan changes via Stripe webhook.
   */
  invalidateWorkspace(workspaceId: string): void {
    this._cache.delete(workspaceId)
  }

  // ── Form count gate ─────────────────────────────────────────────────────────

  /**
   * Throws plan_cap_exceeded if the workspace has reached its max_forms limit.
   */
  async assertCanCreateForm(workspaceId: string): Promise<void> {
    const plan = await this.getEffectivePlan(workspaceId)
    const prisma = this._prisma as any

    const current: number = await prisma.formDefinition.count({
      where: {
        workspaceId,
        archivedAt: null,
      },
    })

    if (current >= plan.maxForms) {
      throw planCapError('max_forms', { current, limit: plan.maxForms })
    }
  }

  // ── Submission quota gate ───────────────────────────────────────────────────

  /**
   * Checks the Redis rolling monthly counter.
   * Throws quota_exhausted if the workspace has hit its monthly submission quota.
   */
  async assertCanAcceptSubmission(workspaceId: string): Promise<void> {
    const plan = await this.getEffectivePlan(workspaceId)
    const yearMonth = currentYearMonth()
    const key = submissionKey(workspaceId, yearMonth)

    const raw = await this._redis.get(key)
    const current = raw ? parseInt(raw, 10) : 0

    if (current >= plan.monthlySubmissionQuota) {
      throw quotaExhaustedError({
        current,
        limit: plan.monthlySubmissionQuota,
        reset_at: nextMonthResetAt().toISOString(),
      })
    }
  }

  /**
   * Atomically increments the rolling monthly counter AFTER a successful
   * submission row insert. Returns the new counter value.
   *
   * INCR is atomic. EXPIRE NX sets the TTL only on the first write of the
   * month (Redis 7) so subsequent increments don't reset the window.
   */
  async recordSubmission(workspaceId: string): Promise<{ monthCount: number }> {
    const yearMonth = currentYearMonth()
    const key = submissionKey(workspaceId, yearMonth)

    const newCount = await this._redis.incr(key)
    // NX: only set expiry if key has no TTL (first write of the month)
    await this._redis.expire(key, EXPIRE_SECONDS, 'NX')

    return { monthCount: newCount }
  }

  // ── Feature gates ───────────────────────────────────────────────────────────

  async getFeatureGates(workspaceId: string): Promise<FeatureGates> {
    const plan = await this.getEffectivePlan(workspaceId)
    return {
      payments_enabled: plan.paymentsEnabled,
      experiments_enabled: plan.experimentsEnabled,
      analytics_retention_days: plan.analyticsRetentionDays,
      max_file_size_mb: plan.maxFileSizeMb,
    }
  }

  async assertPaymentsEnabled(workspaceId: string): Promise<void> {
    const plan = await this.getEffectivePlan(workspaceId)
    if (!plan.paymentsEnabled) {
      throw featureGateError('payments')
    }
  }

  async assertExperimentsEnabled(workspaceId: string): Promise<void> {
    const plan = await this.getEffectivePlan(workspaceId)
    if (!plan.experimentsEnabled) {
      throw featureGateError('experiments')
    }
  }
}
