/**
 * Plan catalog + workspace usage endpoints.
 *
 *   GET /v1/admin/plans
 *     — Public catalog of all available plans. No auth required.
 *
 *   GET /v1/admin/workspaces/me/usage
 *     — Current workspace's plan + resource usage (forms count, submission
 *       rolling quota). Requires auth + populated request.workspaceId
 *       (added by L17's workspace scope plugin).
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { PlanService } from '../../core/workspaces/plan.service.js'
import { getRedisConnection } from '../../queues/connection.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function currentYearMonth(): string {
  const now = new Date()
  const y = now.getUTCFullYear()
  const m = String(now.getUTCMonth() + 1).padStart(2, '0')
  return `${y}-${m}`
}

function nextMonthResetAt(): string {
  const now = new Date()
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)).toISOString()
}

// ── Plugin ────────────────────────────────────────────────────────────────────

export const plansAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── GET /v1/admin/plans ─────────────────────────────────────────────────────
  // Public plan catalog — anyone can view plan tiers.

  app.get(
    '/v1/admin/plans',
    {
      schema: {
        tags: ['plans'],
        description: 'List all available workspace plans (public catalog).',
      },
    },
    async (_request, reply) => {
      // L17 adds WorkspacePlan model; access via (prisma as any) to avoid
      // compile errors before L17's migration is applied.
      const prisma = app.prisma as any
      const plans = await prisma.workspacePlan.findMany({
        orderBy: { monthlySubmissionQuota: 'asc' },
      })
      return reply.send({ plans })
    },
  )

  // ── GET /v1/admin/workspaces/me/usage ───────────────────────────────────────
  // Returns the current workspace's plan + live usage counters.

  app.get(
    '/v1/admin/workspaces/me/usage',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['plans', 'workspaces'],
        description:
          'Current workspace plan and live usage (forms count, submission quota).',
      },
    },
    async (request, reply) => {
      // L17's scope plugin sets request.workspaceId. If it is absent we cannot
      // serve workspace-scoped usage — return 400.
      const workspaceId = (request as any).workspaceId as string | undefined
      if (!workspaceId) {
        return reply.status(400).send({
          error: {
            code: 'workspace_context_missing',
            message: 'No workspace context on this request',
          },
        })
      }

      const redis = getRedisConnection()
      const planService = new PlanService(app.prisma, redis)

      const plan = await planService.getEffectivePlan(workspaceId)

      // Form count (non-archived)
      const prisma = app.prisma as any
      const formsCount: number = await prisma.formDefinition.count({
        where: { workspaceId, archivedAt: null },
      })

      // Submission rolling counter from Redis
      const yearMonth = currentYearMonth()
      const redisKey = `submissions:${workspaceId}:${yearMonth}`
      const raw = await redis.get(redisKey)
      const submissionsCount = raw ? parseInt(raw, 10) : 0

      return reply.send({
        plan,
        usage: {
          forms: {
            current: formsCount,
            limit: plan.maxForms,
          },
          submissions: {
            current: submissionsCount,
            limit: plan.monthlySubmissionQuota,
            reset_at: nextMonthResetAt(),
          },
        },
      })
    },
  )
}

export default plansAdminRoutes
