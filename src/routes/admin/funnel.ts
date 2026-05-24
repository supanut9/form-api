/**
 * Admin funnel read routes.
 *
 *   GET /v1/admin/forms/:formIdOrSlug/funnel?from=&to=&version=
 *     → FunnelService.getFormFunnel
 *
 *   GET /v1/admin/forms/:formIdOrSlug/funnel/daily?from=&to=&event_name=
 *     → FunnelService.getDailyCounts
 *
 * Both routes require authenticate + requirePermission('read', 'Form').
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { FunnelService } from '../../core/analytics/funnel.service.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

// ── Schemas ───────────────────────────────────────────────────────────────────

const paramsSchema = z.object({ formIdOrSlug: z.string().min(1) })

const funnelQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to:   z.string().datetime({ offset: true }),
  version: z.coerce.number().int().positive().optional(),
})

const dailyQuerySchema = z.object({
  from: z.string().datetime({ offset: true }),
  to:   z.string().datetime({ offset: true }),
  event_name: z
    .enum([
      'view',
      'page_enter',
      'page_exit',
      'field_focus',
      'submit_attempt',
      'submit_ok',
      'submit_error',
    ])
    .optional(),
})

// ── Plugin ────────────────────────────────────────────────────────────────────

export const funnelAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── GET /v1/admin/forms/:formIdOrSlug/funnel ──────────────────────────────
  app.get(
    '/v1/admin/forms/:formIdOrSlug/funnel',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Form')],
      schema: {
        tags: ['admin', 'analytics'],
        params: paramsSchema,
        querystring: funnelQuerySchema,
      },
    },
    async (request, reply) => {
      const arg = request.params.formIdOrSlug
      const formDef = isUuid(arg)
        ? await app.prisma.formDefinition.findUnique({ where: { id: arg } })
        : await app.prisma.formDefinition.findUnique({ where: { slug: arg } })

      if (!formDef) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Form not found' } })
      }

      const { from, to, version } = request.query
      const service = new FunnelService(app.prisma)
      const result = await service.getFormFunnel(formDef.id, {
        from: new Date(from),
        to:   new Date(to),
        version: version ?? null,
      })

      return reply.send(result)
    },
  )

  // ── GET /v1/admin/forms/:formIdOrSlug/funnel/daily ────────────────────────
  app.get(
    '/v1/admin/forms/:formIdOrSlug/funnel/daily',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Form')],
      schema: {
        tags: ['admin', 'analytics'],
        params: paramsSchema,
        querystring: dailyQuerySchema,
      },
    },
    async (request, reply) => {
      const arg = request.params.formIdOrSlug
      const formDef = isUuid(arg)
        ? await app.prisma.formDefinition.findUnique({ where: { id: arg } })
        : await app.prisma.formDefinition.findUnique({ where: { slug: arg } })

      if (!formDef) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Form not found' } })
      }

      const { from, to, event_name } = request.query
      const service = new FunnelService(app.prisma)
      const rows = await service.getDailyCounts(formDef.id, {
        from: new Date(from),
        to:   new Date(to),
        eventName: event_name ?? null,
      })

      return reply.send(rows)
    },
  )
}

export default funnelAdminRoutes
