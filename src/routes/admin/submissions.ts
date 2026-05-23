/**
 * Admin endpoints for viewing form submissions.
 *
 *   GET  /admin/forms/:formId/submissions   — paginated list (newest first)
 *   GET  /admin/submissions/:id              — single submission detail
 *   DELETE /admin/submissions/:id            — hard delete (audit logged when wired)
 *
 * All paths require an authenticated admin session + read|delete on Submission.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { AuditService } from '../../core/audit/audit.service.js'

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

const formParamsSchema = z.object({ formId: z.string().min(1) })
const idParamsSchema = z.object({ id: z.string().min(1) })
const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
  status: z.enum(['submitted', 'processing', 'delivered', 'failed']).optional(),
  include_deleted: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
})

const detailQuerySchema = z.object({
  include_deleted: z
    .union([z.literal('true'), z.literal('false')])
    .optional()
    .transform((v) => v === 'true'),
})

export const submissionsAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── GET /admin/forms/:formId/submissions ────────────────────────────────
  app.get(
    '/admin/forms/:formId/submissions',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Submission'),
      ],
      schema: {
        tags: ['admin', 'submissions'],
        params: formParamsSchema,
        querystring: listQuerySchema,
      },
    },
    async (request, reply) => {
      // Accept id or slug for the form. Resolve to a real form_id first so we
      // can index by formId on the join.
      const arg = request.params.formId
      const form = isUuid(arg)
        ? await app.prisma.formDefinition.findUnique({ where: { id: arg } })
        : await app.prisma.formDefinition.findUnique({ where: { slug: arg } })

      if (!form) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Form not found' } })
      }

      const where: {
        formId: string
        status?: 'submitted' | 'processing' | 'delivered' | 'failed'
        deletedAt?: null
      } = { formId: form.id }
      if (request.query.status) where.status = request.query.status
      if (!request.query.include_deleted) where.deletedAt = null

      const [total, rows] = await Promise.all([
        app.prisma.formSubmission.count({ where }),
        app.prisma.formSubmission.findMany({
          where,
          orderBy: { submittedAt: 'desc' },
          take: request.query.limit,
          skip: request.query.offset,
          select: {
            id: true,
            formId: true,
            version: true,
            accountId: true,
            anonymousToken: true,
            payloadJsonb: true,
            submittedAt: true,
            source: true,
            status: true,
            deletedAt: true,
          },
        }),
      ])

      return {
        total,
        limit: request.query.limit,
        offset: request.query.offset,
        form: {
          id: form.id,
          slug: form.slug,
          title: form.title,
          current_version: form.currentVersion,
        },
        items: rows.map((r) => ({
          id: r.id,
          form_id: r.formId,
          version: r.version,
          account_id: r.accountId,
          anonymous_token: r.anonymousToken,
          payload: r.payloadJsonb,
          submitted_at: r.submittedAt.toISOString(),
          source: r.source,
          status: r.status,
          deleted_at: r.deletedAt?.toISOString() ?? null,
        })),
      }
    },
  )

  // ── GET /admin/submissions/:id ──────────────────────────────────────────
  app.get(
    '/admin/submissions/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Submission'),
      ],
      schema: {
        tags: ['admin', 'submissions'],
        params: idParamsSchema,
        querystring: detailQuerySchema,
      },
    },
    async (request, reply) => {
      const sub = await app.prisma.formSubmission.findUnique({
        where: { id: request.params.id },
        include: {
          form: {
            select: { id: true, slug: true, title: true, currentVersion: true },
          },
        },
      })
      if (!sub) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Submission not found' } })
      }
      if (sub.deletedAt && !request.query.include_deleted) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Submission has been deleted' } })
      }
      return {
        id: sub.id,
        form_id: sub.formId,
        form: {
          id: sub.form.id,
          slug: sub.form.slug,
          title: sub.form.title,
          current_version: sub.form.currentVersion,
        },
        version: sub.version,
        account_id: sub.accountId,
        anonymous_token: sub.anonymousToken,
        payload: sub.payloadJsonb,
        submitted_at: sub.submittedAt.toISOString(),
        source: sub.source,
        status: sub.status,
        ip_hash: sub.ipHash,
        user_agent: sub.userAgent,
        deleted_at: sub.deletedAt?.toISOString() ?? null,
      }
    },
  )

  // ── DELETE /admin/submissions/:id ───────────────────────────────────────
  app.delete(
    '/admin/submissions/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('delete', 'Submission'),
      ],
      schema: {
        tags: ['admin', 'submissions'],
        params: idParamsSchema,
      },
    },
    async (request, reply) => {
      // Soft delete: stamp deletedAt instead of removing the row so the audit
      // trail (and any cascaded FormEventFill / FormFile references) keep
      // working. Use updateMany so a no-op (row missing or already-deleted)
      // collapses to count=0 → 404.
      const result = await app.prisma.formSubmission.updateMany({
        where: { id: request.params.id, deletedAt: null },
        data: { deletedAt: new Date() },
      })
      if (result.count === 0) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Submission not found or already deleted' } })
      }
      void new AuditService(app.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'submission.delete',
        subjectType: 'Submission',
        subjectId: request.params.id,
      })
      return reply.status(204).send()
    },
  )

  // ── GET /admin/forms/:formId/submissions/stats ─────────────────────────
  app.get(
    '/admin/forms/:formId/submissions/stats',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Submission'),
      ],
      schema: {
        tags: ['admin', 'submissions'],
        params: formParamsSchema,
        querystring: z.object({
          days: z.coerce.number().int().min(1).max(365).default(30),
        }),
      },
    },
    async (request, reply) => {
      const arg = request.params.formId
      const form = isUuid(arg)
        ? await app.prisma.formDefinition.findUnique({ where: { id: arg } })
        : await app.prisma.formDefinition.findUnique({ where: { slug: arg } })

      if (!form) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Form not found' } })
      }

      const { days } = request.query
      const now = new Date()
      const windowStart = new Date(now.getTime() - days * 24 * 60 * 60 * 1000)

      const [inRangeRows, totalAllTime] = await Promise.all([
        app.prisma.formSubmission.findMany({
          where: {
            formId: form.id,
            deletedAt: null,
            submittedAt: { gte: windowStart, lte: now },
          },
          select: { submittedAt: true },
        }),
        app.prisma.formSubmission.count({
          where: { formId: form.id, deletedAt: null },
        }),
      ])

      // Bucket by YYYY-MM-DD UTC
      const buckets = new Map<string, number>()
      for (let i = 0; i < days; i++) {
        const d = new Date(windowStart.getTime() + i * 24 * 60 * 60 * 1000)
        buckets.set(d.toISOString().slice(0, 10), 0)
      }
      for (const row of inRangeRows) {
        const key = row.submittedAt.toISOString().slice(0, 10)
        buckets.set(key, (buckets.get(key) ?? 0) + 1)
      }

      const points = Array.from(buckets.entries())
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([day, count]) => ({ day, count }))

      return {
        days,
        total_in_range: inRangeRows.length,
        total_all_time: totalAllTime,
        points,
      }
    },
  )

  // ── POST /admin/submissions/:id/restore ────────────────────────────────
  app.post(
    '/admin/submissions/:id/restore',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('delete', 'Submission'),
      ],
      schema: { tags: ['admin', 'submissions'], params: idParamsSchema },
    },
    async (request, reply) => {
      // Restore the inverse of soft-delete: deletedAt → null. Operates only
      // on rows that are currently soft-deleted; returns 404 otherwise.
      const result = await app.prisma.formSubmission.updateMany({
        where: { id: request.params.id, deletedAt: { not: null } },
        data: { deletedAt: null },
      })
      if (result.count === 0) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Submission not found or not deleted' } })
      }
      void new AuditService(app.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'submission.restore',
        subjectType: 'Submission',
        subjectId: request.params.id,
      })
      return reply.status(204).send()
    },
  )
}

export default submissionsAdminRoutes
