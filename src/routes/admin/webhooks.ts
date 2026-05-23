/**
 * Admin endpoints for FormWebhook management.
 *
 *   POST   /admin/webhooks                   → create (returns secret ONCE)
 *   GET    /admin/webhooks                   → list (optional ?form_id=)
 *   GET    /admin/webhooks/:id               → detail
 *   PATCH  /admin/webhooks/:id               → update url/events/active
 *   POST   /admin/webhooks/:id/rotate-secret → returns new secret ONCE
 *   DELETE /admin/webhooks/:id               → remove (cascade deliveries)
 *
 *   GET    /admin/webhooks/:id/deliveries    → recent attempts
 *   POST   /admin/deliveries/:id/replay      → re-attempt a failed delivery
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { WebhookService } from '../../core/webhooks/webhook.service.js'
import { AuditService } from '../../core/audit/audit.service.js'

const idParamsSchema = z.object({ id: z.string().uuid() })
const listQuerySchema = z.object({ form_id: z.string().uuid().optional() })
const deliveriesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
})

const createBodySchema = z.object({
  form_id: z.string().uuid(),
  url: z.string().url(),
  events: z.array(z.enum(['submitted', 'failed'])).default(['submitted']),
  active: z.boolean().default(true),
})

const updateBodySchema = z.object({
  url: z.string().url().optional(),
  events: z.array(z.enum(['submitted', 'failed'])).optional(),
  active: z.boolean().optional(),
})

export const webhooksAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/admin/webhooks',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'Webhook'),
      ],
      schema: { tags: ['admin', 'webhooks'], body: createBodySchema },
    },
    async (request, reply) => {
      const service = new WebhookService(app.prisma)
      try {
        const created = await service.createWebhook({
          formId: request.body.form_id,
          url: request.body.url,
          events: request.body.events,
          active: request.body.active,
        })
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'webhook.create',
          subjectType: 'Webhook',
          subjectId: created.id,
          diff: { form_id: created.formId, url: created.url, events: created.events },
        })
        return reply.status(201).send({
          id: created.id,
          form_id: created.formId,
          url: created.url,
          events: created.events,
          active: created.active,
          secret: created.secret,
        })
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'invalid_url') {
          return reply
            .status(400)
            .send({ error: { code: 'invalid_url', message: e.message } })
        }
        throw err
      }
    },
  )

  app.get(
    '/admin/webhooks',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Webhook'),
      ],
      schema: { tags: ['admin', 'webhooks'], querystring: listQuerySchema },
    },
    async (request) => {
      const service = new WebhookService(app.prisma)
      const rows = await service.listWebhooks(request.query.form_id)
      return rows.map(serialize)
    },
  )

  app.get(
    '/admin/webhooks/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Webhook'),
      ],
      schema: { tags: ['admin', 'webhooks'], params: idParamsSchema },
    },
    async (request, reply) => {
      const service = new WebhookService(app.prisma)
      const row = await service.getWebhook(request.params.id)
      if (!row) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Webhook not found' } })
      }
      return serialize(row)
    },
  )

  app.patch(
    '/admin/webhooks/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'Webhook'),
      ],
      schema: {
        tags: ['admin', 'webhooks'],
        params: idParamsSchema,
        body: updateBodySchema,
      },
    },
    async (request, reply) => {
      const service = new WebhookService(app.prisma)
      try {
        const patch: Parameters<WebhookService['updateWebhook']>[1] = {}
        if (request.body.url !== undefined) patch.url = request.body.url
        if (request.body.events !== undefined) patch.events = request.body.events
        if (request.body.active !== undefined) patch.active = request.body.active
        const row = await service.updateWebhook(request.params.id, patch)
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'webhook.update',
          subjectType: 'Webhook',
          subjectId: row.id,
          diff: patch,
        })
        return serialize(row)
      } catch {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Webhook not found' } })
      }
    },
  )

  app.post(
    '/admin/webhooks/:id/rotate-secret',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'Webhook'),
      ],
      schema: { tags: ['admin', 'webhooks'], params: idParamsSchema },
    },
    async (request, reply) => {
      const service = new WebhookService(app.prisma)
      try {
        const { secret } = await service.rotateSecret(request.params.id)
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'webhook.rotate_secret',
          subjectType: 'Webhook',
          subjectId: request.params.id,
        })
        return { secret }
      } catch {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Webhook not found' } })
      }
    },
  )

  app.delete(
    '/admin/webhooks/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'Webhook'),
      ],
      schema: { tags: ['admin', 'webhooks'], params: idParamsSchema },
    },
    async (request, reply) => {
      const service = new WebhookService(app.prisma)
      try {
        await service.deleteWebhook(request.params.id)
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'webhook.delete',
          subjectType: 'Webhook',
          subjectId: request.params.id,
        })
        return reply.status(204).send()
      } catch {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Webhook not found' } })
      }
    },
  )

  app.get(
    '/admin/webhooks/:id/deliveries',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Webhook'),
      ],
      schema: {
        tags: ['admin', 'webhooks'],
        params: idParamsSchema,
        querystring: deliveriesQuerySchema,
      },
    },
    async (request) => {
      const service = new WebhookService(app.prisma)
      const result = await service.listDeliveries({
        webhookId: request.params.id,
        limit: request.query.limit,
        offset: request.query.offset,
      })
      return {
        total: result.total,
        limit: request.query.limit,
        offset: request.query.offset,
        items: result.rows.map((r) => ({
          id: r.id,
          webhook_id: r.webhookId,
          submission_id: r.submissionId,
          attempt: r.attempt,
          status: r.status,
          response_code: r.responseCode,
          response_body_excerpt: r.responseBodyExcerpt,
          scheduled_at: r.scheduledAt.toISOString(),
        })),
      }
    },
  )

  app.post(
    '/admin/deliveries/:id/replay',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('manage', 'Webhook'),
      ],
      schema: { tags: ['admin', 'webhooks'], params: idParamsSchema },
    },
    async (request, reply) => {
      const service = new WebhookService(app.prisma)
      try {
        const { newDeliveryId } = await service.replayDelivery(request.params.id)
        void new AuditService(app.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'webhook.delivery.replay',
          subjectType: 'WebhookDelivery',
          subjectId: request.params.id,
          diff: { new_delivery_id: newDeliveryId },
        })
        return reply.status(202).send({ delivery_id: newDeliveryId })
      } catch {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Delivery not found' } })
      }
    },
  )
}

function serialize(row: {
  id: string
  formId: string
  url: string
  events: string[]
  active: boolean
  lastDeliveryAt: Date | null
  createdAt: Date
}) {
  return {
    id: row.id,
    form_id: row.formId,
    url: row.url,
    events: row.events,
    active: row.active,
    last_delivery_at: row.lastDeliveryAt?.toISOString() ?? null,
    created_at: row.createdAt.toISOString(),
  }
}

export default webhooksAdminRoutes
