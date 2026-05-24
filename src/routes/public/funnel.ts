/**
 * POST /v1/public/forms/:slug/funnel
 *
 * Client-side batch ingest for funnel events (page_enter, page_exit,
 * field_focus, view, submit_attempt, submit_ok, submit_error).
 *
 * Auth model: anonymous only — no session required.
 *   - Reads/sets the `form_anon` cookie (same name + maxAge as submit.ts).
 *   - Resolves slug → formId + currentVersion via FormService.
 *   - Rate-limited: 60 req/min per IP.
 *
 * Returns 202 { accepted, dropped }.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { FunnelIngester } from '../../core/analytics/event.ingester.js'
import { FormService } from '../../core/forms/form.service.js'
import { ANON_COOKIE, ANON_COOKIE_MAX_AGE } from '../../core/analytics/anonymous-token.js'
import { hashIp, hashUserAgent } from '../../core/utils/hash.js'
import type { FunnelEventName } from '@prisma/client'

// ── Schemas ───────────────────────────────────────────────────────────────────

const paramsSchema = z.object({ slug: z.string().min(1) })

const funnelEventSchema = z.object({
  name: z.enum([
    'view',
    'page_enter',
    'page_exit',
    'field_focus',
    'submit_attempt',
    'submit_ok',
    'submit_error',
  ]),
  page_id: z.string().optional().nullable(),
  field_id: z.string().optional().nullable(),
  occurred_at: z.string().min(1),          // ISO-8601 string; time-window guard in ingester
  submission_id: z.string().uuid().optional().nullable(),
})

const bodySchema = z.object({
  events: z.array(funnelEventSchema).min(1).max(50),
})

// ── Plugin ────────────────────────────────────────────────────────────────────

export const publicFunnelRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/v1/public/forms/:slug/funnel',
    {
      schema: {
        tags: ['public', 'analytics'],
        description: 'Client-side batch ingest for funnel events.',
        params: paramsSchema,
        body: bodySchema,
      },
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      // ── Resolve form ─────────────────────────────────────────────────────────
      const formService = new FormService(app.prisma)
      const form = await formService.getFormWithCurrentVersion(request.params.slug)

      if (!form) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Form not found' } })
      }

      // ── Anonymous token (issue on first view) ────────────────────────────────
      let anonymousToken = request.cookies?.[ANON_COOKIE] ?? null
      if (!anonymousToken) {
        anonymousToken = randomUUID()
        reply.setCookie(ANON_COOKIE, anonymousToken, {
          httpOnly: true,
          sameSite: 'lax',
          path: '/',
          maxAge: ANON_COOKIE_MAX_AGE,
        })
      }

      // ── Fingerprint hashes ───────────────────────────────────────────────────
      const ipHash = hashIp(request.ip)
      const uaRaw = String(request.headers['user-agent'] ?? '').slice(0, 512)
      const userAgentHash = hashUserAgent(uaRaw)

      // ── Ingest ───────────────────────────────────────────────────────────────
      const ingester = new FunnelIngester(app.prisma)
      const result = await ingester.ingestBatch({
        formId: form.id,
        version: form.currentVersion,
        anonymousToken,
        ipHash,
        userAgentHash,
        events: request.body.events.map((ev) => ({
          name: ev.name as FunnelEventName,
          page_id: ev.page_id ?? null,
          field_id: ev.field_id ?? null,
          occurred_at: ev.occurred_at,
          submission_id: ev.submission_id ?? null,
        })),
      })

      return reply.status(202).send(result)
    },
  )
}

export default publicFunnelRoutes
