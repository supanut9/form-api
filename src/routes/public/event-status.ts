/**
 * Public event endpoints — consumed by form-web and integrating front-ends.
 *
 *   GET /public/events/:eventKey/resolve  → { form_slug, current_version, optional, access_mode }
 *     Used by form-web's /e/:eventKey redirect to map an event_key to a form URL.
 *
 *   GET /public/events/:eventKey/status   → { event_key, filled, filled_at, optional, form_url }
 *     Reads the authenticated user's identity from the form-admin session, or
 *     falls back to the form_anon cookie. Returns fill status from
 *     FormEventFill.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { env } from '../../config/env.js'
import { EventService } from '../../core/events/event.service.js'
import { FillService } from '../../core/events/fill.service.js'
import { formSpecSchema } from '../../core/forms/types.js'

const ANON_COOKIE = 'form_anon'
const paramsSchema = z.object({ eventKey: z.string().min(1) })

export const eventStatusPublicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // -------------------------------------------------------------------------
  // GET /public/events/:eventKey/resolve
  // -------------------------------------------------------------------------
  app.get(
    '/public/events/:eventKey/resolve',
    {
      schema: {
        tags: ['public', 'events'],
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const service = new EventService(app.prisma)
      const ev = await service.getEventByKey(request.params.eventKey)
      if (!ev || ev.form.archivedAt) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Event not found' } })
      }

      // Resolve access mode from the form's current published spec, if any.
      let accessMode: 'public_anonymous' | 'private_oidc' | 'link_token' =
        'public_anonymous'
      const currentVersion = await app.prisma.formVersion.findFirst({
        where: { formId: ev.form.id, isCurrent: true },
        select: { specJson: true },
      })
      if (currentVersion?.specJson) {
        const parsed = formSpecSchema.safeParse(currentVersion.specJson)
        if (parsed.success) accessMode = parsed.data.access.mode
      }

      return {
        event_key: ev.eventKey,
        form_id: ev.form.id,
        form_slug: ev.form.slug,
        current_version: ev.currentVersion,
        optional: ev.optional,
        access_mode: accessMode,
      }
    },
  )

  // -------------------------------------------------------------------------
  // GET /public/events/:eventKey/status
  // -------------------------------------------------------------------------
  app.get(
    '/public/events/:eventKey/status',
    {
      schema: {
        tags: ['public', 'events'],
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const ev = await app.prisma.formEvent.findUnique({
        where: { eventKey: request.params.eventKey },
        include: { form: { select: { id: true, slug: true, archivedAt: true } } },
      })
      if (!ev || ev.form.archivedAt) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Event not found' } })
      }

      const accountSub = request.session?.sub ?? null
      const anonToken = request.cookies?.[ANON_COOKIE] ?? null

      const fillService = new FillService(app.prisma)
      const status = await fillService.getStatus({
        eventKey: ev.eventKey,
        identity: { accountId: accountSub, anonymousToken: anonToken },
      })

      const formUrl = ev.form.slug
        ? `${env.PUBLIC_FORM_WEB_URL}/f/${ev.form.slug}`
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

export default eventStatusPublicRoutes
