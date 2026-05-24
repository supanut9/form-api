/**
 * Admin funnel read routes.
 *
 *   GET /v1/admin/forms/:formIdOrSlug/funnel?from=&to=&version=
 *   GET /v1/admin/forms/:formIdOrSlug/funnel/daily?from=&to=&event_name=
 *   GET /v1/admin/workspaces/me/drain-state
 *
 * The first two routes pick a backend via FunnelReaderFactory:
 *   - Postgres FunnelService for free/starter/pro workspaces (default).
 *   - ClickHouse FunnelReaderClickHouse for business workspaces when
 *     CLICKHOUSE_URL is set.  Falls back to Postgres if env is unset.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { createFunnelReader } from '../../core/analytics/funnel.factory.js'
import { getClickHouse } from '../../lib/clickhouse.js'

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
      const reader = await createFunnelReader(
        app.prisma,
        getClickHouse,
        formDef.workspaceId ?? null,
      )
      const result = await reader.getFormFunnel(formDef.id, {
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
      const reader = await createFunnelReader(
        app.prisma,
        getClickHouse,
        formDef.workspaceId ?? null,
      )
      const rows = await reader.getDailyCounts(formDef.id, {
        from: new Date(from),
        to:   new Date(to),
        eventName: event_name ?? null,
      })

      return reply.send(rows)
    },
  )

  // ── GET /v1/admin/workspaces/me/drain-state ───────────────────────────────
  // Returns the drain state for the caller's current workspace, or null if
  // the drain has never run. Useful for "Last synced N hours ago" in the UI.
  app.get(
    '/v1/admin/workspaces/me/drain-state',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'Form')],
      schema: {
        tags: ['admin', 'analytics'],
      },
    },
    async (request, reply) => {
      // The workspace is resolved from the request context (set by workspace-scope plugin).
      // If there is no workspace context fall back to the first workspace the user owns.
      const workspaceId: string | undefined =
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (request as any).workspaceId as string | undefined

      if (!workspaceId) {
        return reply.send(null)
      }

      const state = await app.prisma.workspaceDrainState.findUnique({
        where: { workspaceId },
      })

      return reply.send(state ?? null)
    },
  )
}

export default funnelAdminRoutes
