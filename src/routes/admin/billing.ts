/**
 * Admin billing endpoints for workspace plan management.
 *
 *   POST /v1/admin/workspaces/me/billing/checkout
 *     — Start a Stripe checkout session for a plan upgrade.
 *     — Body: { plan_slug, success_url, cancel_url }
 *     — Returns: { url }
 *     — RBAC: workspace role must be owner or admin.
 *
 *   POST /v1/admin/workspaces/me/billing/portal
 *     — Start a Stripe Customer Portal session for self-service billing.
 *     — Body: { return_url }
 *     — Returns: { url }
 *     — RBAC: workspace role must be owner or admin.
 *
 *   GET /v1/admin/workspaces/me/billing/events
 *     — Paginated list of WorkspaceBillingEvent rows for audit transparency.
 *     — Query: ?limit=&offset=
 *
 * Workspace context is resolved by the workspace-scope plugin (L17) which
 * populates request.workspaceId and request.workspaceRole.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import type { WorkspaceRole } from '@prisma/client'
import { BillingService } from '../../core/workspaces/billing.service.js'

// ---------------------------------------------------------------------------
// RBAC helper
// ---------------------------------------------------------------------------

const BILLING_ROLES: WorkspaceRole[] = ['owner', 'admin']

function assertBillingRole(role: WorkspaceRole | undefined): void {
  if (!role || !BILLING_ROLES.includes(role)) {
    const err = new Error('Only workspace owners and admins can manage billing') as Error & {
      code: string
      statusCode: number
    }
    err.code = 'forbidden'
    err.statusCode = 403
    throw err
  }
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const checkoutBodySchema = z.object({
  plan_slug: z.string().min(1),
  success_url: z.string().url(),
  cancel_url: z.string().url(),
})

const portalBodySchema = z.object({
  return_url: z.string().url(),
})

const eventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const billingAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── POST /v1/admin/workspaces/me/billing/checkout ─────────────────────────

  app.post(
    '/v1/admin/workspaces/me/billing/checkout',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['admin', 'billing'],
        description: 'Create a Stripe checkout session for a plan upgrade.',
        body: checkoutBodySchema,
      },
    },
    async (request, reply) => {
      const workspaceId = (request as any).workspaceId as string | undefined
      const workspaceRole = (request as any).workspaceRole as WorkspaceRole | undefined

      if (!workspaceId) {
        return reply.status(400).send({
          error: { code: 'workspace_context_missing', message: 'No workspace context on this request' },
        })
      }

      assertBillingRole(workspaceRole)

      const { plan_slug, success_url, cancel_url } = request.body
      const billing = new BillingService(fastify.prisma)

      const result = await billing.createCheckoutSession({
        workspaceId,
        planSlug: plan_slug,
        successUrl: success_url,
        cancelUrl: cancel_url,
      })

      return reply.status(200).send(result)
    },
  )

  // ── POST /v1/admin/workspaces/me/billing/portal ───────────────────────────

  app.post(
    '/v1/admin/workspaces/me/billing/portal',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['admin', 'billing'],
        description: 'Create a Stripe Customer Portal session.',
        body: portalBodySchema,
      },
    },
    async (request, reply) => {
      const workspaceId = (request as any).workspaceId as string | undefined
      const workspaceRole = (request as any).workspaceRole as WorkspaceRole | undefined

      if (!workspaceId) {
        return reply.status(400).send({
          error: { code: 'workspace_context_missing', message: 'No workspace context on this request' },
        })
      }

      assertBillingRole(workspaceRole)

      const { return_url } = request.body
      const billing = new BillingService(fastify.prisma)

      const result = await billing.createPortalSession({
        workspaceId,
        returnUrl: return_url,
      })

      return reply.status(200).send(result)
    },
  )

  // ── GET /v1/admin/workspaces/me/billing/events ────────────────────────────

  app.get(
    '/v1/admin/workspaces/me/billing/events',
    {
      preHandler: [fastify.authenticate],
      schema: {
        tags: ['admin', 'billing'],
        description: 'Paginated list of workspace billing events (Stripe webhook history).',
        querystring: eventsQuerySchema,
      },
    },
    async (request, reply) => {
      const workspaceId = (request as any).workspaceId as string | undefined

      if (!workspaceId) {
        return reply.status(400).send({
          error: { code: 'workspace_context_missing', message: 'No workspace context on this request' },
        })
      }

      const { limit, offset } = request.query
      const prisma = fastify.prisma as any

      const [total, events] = await Promise.all([
        prisma.workspaceBillingEvent.count({ where: { workspaceId } }),
        prisma.workspaceBillingEvent.findMany({
          where: { workspaceId },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
      ])

      return reply.send({ total, events })
    },
  )
}

export default billingAdminRoutes
