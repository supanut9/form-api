/**
 * Admin read-only endpoints for form payments.
 *
 *   GET /v1/admin/forms/:formIdOrSlug/payments  — paginated list
 *   GET /v1/admin/payments/:id                  — single row + Stripe dashboard URL
 *
 * NO write paths — intent creation, reconciliation, and refunds are owned by Lane L8.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { env } from '../../config/env.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

function stripeDashboardUrl(paymentIntentId: string): string {
  const prefix = env.STRIPE_ENV === 'live' ? '' : 'test/'
  return `https://dashboard.stripe.com/${prefix}payments/${paymentIntentId}`
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const listParamsSchema = z.object({ formIdOrSlug: z.string().min(1) })

const listQuerySchema = z.object({
  status: z.enum(['pending', 'succeeded', 'failed', 'refunded']).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

const detailParamsSchema = z.object({ id: z.string().min(1) })

// ── Plugin ────────────────────────────────────────────────────────────────────

export const paymentsAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── GET /v1/admin/forms/:formIdOrSlug/payments ────────────────────────────
  app.get(
    '/v1/admin/forms/:formIdOrSlug/payments',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Form')],
      schema: {
        tags: ['admin', 'payments'],
        params: listParamsSchema,
        querystring: listQuerySchema,
      },
    },
    async (request, reply) => {
      const arg = request.params.formIdOrSlug

      // Resolve formId from id or slug
      const formDef = isUuid(arg)
        ? await app.prisma.formDefinition.findUnique({ where: { id: arg } })
        : await app.prisma.formDefinition.findUnique({ where: { slug: arg } })

      if (!formDef) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Form not found' } })
      }

      const { status, from, to, limit, offset } = request.query

      // Build the where clause for payments via their submission relation
      const where: Record<string, unknown> = {
        submission: { formId: formDef.id },
      }
      if (status) where['status'] = status
      if (from || to) {
        where['createdAt'] = {
          ...(from ? { gte: new Date(from) } : {}),
          ...(to ? { lte: new Date(to) } : {}),
        }
      }

      const [items, total] = await Promise.all([
        app.prisma.formPayment.findMany({
          where,
          include: {
            submission: {
              select: { submittedAt: true },
            },
          },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
        }),
        app.prisma.formPayment.count({ where }),
      ])

      return reply.send({ items, total })
    },
  )

  // ── GET /v1/admin/payments/:id ─────────────────────────────────────────────
  app.get(
    '/v1/admin/payments/:id',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Form')],
      schema: {
        tags: ['admin', 'payments'],
        params: detailParamsSchema,
      },
    },
    async (request, reply) => {
      const payment = await app.prisma.formPayment.findUnique({
        where: { id: request.params.id },
        include: {
          submission: {
            select: { submittedAt: true, formId: true },
          },
        },
      })

      if (!payment) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Payment not found' } })
      }

      return reply.send({
        ...payment,
        stripe_dashboard_url: stripeDashboardUrl(payment.stripePaymentIntentId),
      })
    },
  )
}

export default paymentsAdminRoutes
