import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { VersionService } from '../../core/forms/version.service.js'
import { requirePermission } from '../../core/auth/rbac.js'
import { AuditService } from '../../core/audit/audit.service.js'
import { formSpecSchema } from '../../core/forms/types.js'
import { validatePublishableSpec } from '../../core/forms/publish-guard.js'

// ── Request schemas ───────────────────────────────────────────────────────────

const formVersionParamsSchema = z.object({
  formId: z.string(),
  version: z.coerce.number().int().positive(),
})

const formIdParamsSchema = z.object({ formId: z.string() })

const publishVersionBodySchema = z.object({
  spec_json: z.unknown(),
})

// ── Plugin ────────────────────────────────────────────────────────────────────

export const versionsAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── GET /admin/forms/:formId/versions ─────────────────────────────────────
  app.get(
    '/admin/forms/:formId/versions',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        params: formIdParamsSchema,
      },
    },
    async (request, reply) => {
      const service = new VersionService(fastify.prisma)
      const versions = await service.listVersions(request.params.formId)
      return reply.send(versions)
    },
  )

  // ── GET /admin/forms/:formId/versions/:version ────────────────────────────
  app.get(
    '/admin/forms/:formId/versions/:version',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        params: formVersionParamsSchema,
      },
    },
    async (request, reply) => {
      const service = new VersionService(fastify.prisma)
      const version = await service.getVersion(request.params.formId, request.params.version)
      if (!version) return reply.status(404).send({ error: { code: 'not_found', message: 'Version not found' } })
      return reply.send(version)
    },
  )

  // ── POST /admin/forms/:formId/versions ────────────────────────────────────
  // Publish a new version. Validates spec, computes hash, inserts row.
  app.post(
    '/admin/forms/:formId/versions',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('publish', 'FormVersion'),
      ],
      schema: {
        tags: ['forms'],
        params: formIdParamsSchema,
        body: publishVersionBodySchema,
      },
    },
    async (request, reply) => {
      const { formId } = request.params

      // 1. Resolve the form — check it exists and grab archivedAt.
      const form = await fastify.prisma.formDefinition.findUnique({
        where: { id: formId },
        select: { archivedAt: true },
      })
      if (!form) {
        return reply.status(404).send({ error: { code: 'form_not_found', message: 'Form not found' } })
      }

      // 2. Parse spec_json through the schema.
      const parsed = formSpecSchema.safeParse(request.body.spec_json)
      if (!parsed.success) {
        return reply.status(400).send({
          error: {
            code: 'invalid_spec',
            message: 'Spec failed schema validation',
            details: parsed.error.issues,
          },
        })
      }

      // 3. Run semantic publish guard.
      const guardErrors = validatePublishableSpec(parsed.data, form)
      if (guardErrors.length > 0) {
        return reply.status(422).send({
          error: {
            code: 'publish_guard_failed',
            message: 'Spec rejected',
            details: guardErrors,
          },
        })
      }

      // 4. All checks passed — write the version row.
      const service = new VersionService(fastify.prisma)
      const version = await service.publishVersion({
        formId,
        spec: request.body.spec_json,
        publishedBy: request.session!.sub,
      })
      void new AuditService(fastify.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'form.version.publish',
        subjectType: 'FormVersion',
        subjectId: version.id,
        diff: { form_id: formId, version: version.version },
      })
      return reply.status(201).send(version)
    },
  )

  // ── POST /admin/forms/:formId/versions/:version/set-current ──────────────
  // Switch active version (for rollback without data loss).
  app.post(
    '/admin/forms/:formId/versions/:version/set-current',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('publish', 'FormVersion'),
      ],
      schema: {
        tags: ['forms'],
        params: formVersionParamsSchema,
      },
    },
    async (request, reply) => {
      const service = new VersionService(fastify.prisma)
      try {
        const version = await service.setCurrentVersion(
          request.params.formId,
          request.params.version,
          request.session!.sub,
        )
        return reply.send(version)
      } catch (err) {
        const e = err as Error & { statusCode?: number }
        if (e.message === 'version_not_found' || e.statusCode === 404) {
          return reply.status(404).send({ error: { code: 'not_found', message: 'Version not found' } })
        }
        throw err
      }
    },
  )
}

export default versionsAdminRoutes
