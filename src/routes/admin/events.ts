/**
 * Admin endpoints for FormEvent CRUD.
 *
 *   POST   /admin/events          → create (event_key + form_id + flags)
 *   GET    /admin/events          → list (optional ?form_id filter)
 *   GET    /admin/events/:id      → detail
 *   PATCH  /admin/events/:id      → update flags / description / version
 *   DELETE /admin/events/:id      → remove (refuses if fills exist)
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { EventService } from '../../core/events/event.service.js'
import { AuditService } from '../../core/audit/audit.service.js'

const idParamsSchema = z.object({ id: z.string().min(1) })

const createBodySchema = z.object({
  event_key: z.string().min(3).max(80),
  form_id: z.string().uuid(),
  optional: z.boolean().default(false),
  description: z.string().max(500).default(''),
})

const updateBodySchema = z.object({
  optional: z.boolean().optional(),
  description: z.string().max(500).optional(),
  current_version: z.number().int().positive().optional(),
})

const listQuerySchema = z.object({
  form_id: z.string().uuid().optional(),
})

export const eventsAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/admin/events',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'FormEvent'),
      ],
      schema: {
        tags: ['admin', 'events'],
        body: createBodySchema,
      },
    },
    async (request, reply) => {
      const service = new EventService(app.prisma)
      try {
        const ev = await service.createEvent({
          eventKey: request.body.event_key,
          formId: request.body.form_id,
          optional: request.body.optional,
          description: request.body.description,
        })
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'event.create',
          subjectType: 'FormEvent',
          subjectId: ev.id,
          diff: {
            event_key: ev.eventKey,
            form_id: ev.formId,
            optional: ev.optional,
          },
        })
        return reply.status(201).send(serialize(ev))
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'invalid_event_key') {
          return reply
            .status(400)
            .send({ error: { code: 'invalid_event_key', message: e.message } })
        }
        if (e.code === 'form_not_found') {
          return reply
            .status(404)
            .send({ error: { code: 'form_not_found', message: e.message } })
        }
        // Prisma unique violation (P2002) → 409
        if (
          (err as { code?: string }).code === 'P2002'
        ) {
          return reply
            .status(409)
            .send({ error: { code: 'event_key_taken', message: 'event_key already used' } })
        }
        throw err
      }
    },
  )

  app.get(
    '/admin/events',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'FormEvent'),
      ],
      schema: {
        tags: ['admin', 'events'],
        querystring: listQuerySchema,
      },
    },
    async (request) => {
      const service = new EventService(app.prisma)
      const rows = await service.listEvents({ formId: request.query.form_id })
      return rows.map(serialize)
    },
  )

  app.get(
    '/admin/events/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'FormEvent'),
      ],
      schema: {
        tags: ['admin', 'events'],
        params: idParamsSchema,
      },
    },
    async (request, reply) => {
      const service = new EventService(app.prisma)
      const ev = await service.getEvent(request.params.id)
      if (!ev) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Event not found' } })
      }
      return serialize(ev)
    },
  )

  app.patch(
    '/admin/events/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'FormEvent'),
      ],
      schema: {
        tags: ['admin', 'events'],
        params: idParamsSchema,
        body: updateBodySchema,
      },
    },
    async (request, reply) => {
      const service = new EventService(app.prisma)
      try {
        const patch: Parameters<EventService['updateEvent']>[1] = {}
        if (request.body.optional !== undefined) patch.optional = request.body.optional
        if (request.body.description !== undefined)
          patch.description = request.body.description
        if (request.body.current_version !== undefined)
          patch.currentVersion = request.body.current_version
        const ev = await service.updateEvent(request.params.id, patch)
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'event.update',
          subjectType: 'FormEvent',
          subjectId: ev.id,
          diff: patch,
        })
        return serialize(ev)
      } catch {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Event not found' } })
      }
    },
  )

  app.delete(
    '/admin/events/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'FormEvent'),
      ],
      schema: {
        tags: ['admin', 'events'],
        params: idParamsSchema,
      },
    },
    async (request, reply) => {
      // Block deletion if any fills exist (would orphan event-key references).
      const ev = await app.prisma.formEvent.findUnique({
        where: { id: request.params.id },
        select: { eventKey: true },
      })
      if (!ev) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Event not found' } })
      }
      const fillCount = await app.prisma.formEventFill.count({
        where: { eventKey: ev.eventKey },
      })
      if (fillCount > 0) {
        return reply.status(409).send({
          error: {
            code: 'has_fills',
            message: `Refusing to delete event with ${fillCount} fill record(s)`,
          },
        })
      }
      const service = new EventService(app.prisma)
      await service.deleteEvent(request.params.id)
      void new AuditService(app.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'event.delete',
        subjectType: 'FormEvent',
        subjectId: request.params.id,
        diff: { event_key: ev.eventKey },
      })
      return reply.status(204).send()
    },
  )
}

function serialize(ev: {
  id: string
  eventKey: string
  formId: string
  currentVersion: number
  optional: boolean
  description: string
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: ev.id,
    event_key: ev.eventKey,
    form_id: ev.formId,
    current_version: ev.currentVersion,
    optional: ev.optional,
    description: ev.description,
    created_at: ev.createdAt.toISOString(),
    updated_at: ev.updatedAt.toISOString(),
  }
}

export default eventsAdminRoutes
