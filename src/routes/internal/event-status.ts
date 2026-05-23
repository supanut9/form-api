/**
 * Internal event status endpoint.
 *
 *   GET /internal/events/:eventKey/status?account_id=...
 *   GET /internal/events/:eventKey/status?anonymous_token=...
 *
 * Used by other services (e.g. language-api) to ask "has this user filled
 * event X?". Authentication is by service token (`fak_…`) with the
 * `events.read` scope. Rate limit is permissive (per-token) since service
 * callers can fan out heavily.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { env } from '../../config/env.js'
import { FillService } from '../../core/events/fill.service.js'
import { requireServiceToken } from '../../core/auth/service-token.js'

const paramsSchema = z.object({ eventKey: z.string().min(1) })
const querySchema = z.object({
  account_id: z.string().min(1).optional(),
  anonymous_token: z.string().min(1).optional(),
})

export const eventStatusInternalRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get(
    '/internal/events/:eventKey/status',
    {
      preHandler: [requireServiceToken('events.read')],
      schema: {
        tags: ['internal', 'events'],
        params: paramsSchema,
        querystring: querySchema,
      },
      config: {
        rateLimit: { max: 1000, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const { account_id, anonymous_token } = request.query
      if (!account_id && !anonymous_token) {
        return reply.status(400).send({
          error: {
            code: 'missing_identity',
            message: 'Either account_id or anonymous_token query param is required',
          },
        })
      }

      const ev = await app.prisma.formEvent.findUnique({
        where: { eventKey: request.params.eventKey },
        include: { form: { select: { id: true, slug: true, archivedAt: true } } },
      })
      if (!ev || ev.form.archivedAt) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Event not found' } })
      }

      const fillService = new FillService(app.prisma)
      const status = await fillService.getStatus({
        eventKey: ev.eventKey,
        identity: {
          accountId: account_id ?? null,
          anonymousToken: anonymous_token ?? null,
        },
      })

      const formUrl = ev.form.slug
        ? `${env.PUBLIC_FORM_WEB_URL}/f/${ev.form.slug}?event_key=${encodeURIComponent(ev.eventKey)}`
        : null

      return {
        event_key: ev.eventKey,
        optional: ev.optional,
        form_url: formUrl,
        filled: status.filled,
        filled_at: status.filled_at,
        submission_id: status.submission_id,
      }
    },
  )
}

export default eventStatusInternalRoutes
