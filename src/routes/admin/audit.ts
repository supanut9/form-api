/**
 * Admin audit log endpoint.
 *
 *   GET /admin/audit?page=1&per_page=50&actor_account_id&subject_type&from&to
 *
 * Returns the cms-style envelope { data, total, page, per_page } the existing
 * settings/audit page expects.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { AuditService } from '../../core/audit/audit.service.js'

const SUBJECT_TYPES = [
  'Form',
  'FormVersion',
  'Submission',
  'FormEvent',
  'Webhook',
  'WebhookDelivery',
  'ApiToken',
  'Role',
  'AccountRole',
] as const

const querySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  per_page: z.coerce.number().int().min(1).max(200).default(50),
  actor_account_id: z.string().optional(),
  subject_type: z.enum(SUBJECT_TYPES).optional(),
  subject_id: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
})

export const auditAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get(
    '/admin/audit',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'AuditLog'),
      ],
      schema: {
        tags: ['admin', 'audit'],
        querystring: querySchema,
      },
    },
    async (request) => {
      const service = new AuditService(app.prisma)
      const result = await service.list({
        actorAccountId: request.query.actor_account_id,
        subjectType: request.query.subject_type,
        subjectId: request.query.subject_id,
        from: request.query.from ? new Date(request.query.from) : undefined,
        to: request.query.to ? new Date(request.query.to) : undefined,
        limit: request.query.per_page,
        offset: (request.query.page - 1) * request.query.per_page,
      })

      return {
        data: result.rows.map((r) => ({
          id: r.id,
          actor_account_id: r.actorAccountId,
          action: r.action,
          subject_type: r.subjectType,
          subject_id: r.subjectId,
          diff_json: r.diffJson,
          at: r.at.toISOString(),
        })),
        total: result.total,
        page: request.query.page,
        per_page: request.query.per_page,
      }
    },
  )
}

export default auditAdminRoutes
