import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { FormService } from '../../core/forms/form.service.js'
import { AuditService } from '../../core/audit/audit.service.js'
import { VersionService } from '../../core/forms/version.service.js'
import { requirePermission } from '../../core/auth/rbac.js'
import { FormSpecValidationError } from '../../core/forms/spec.validator.js'
import { PlanService } from '../../core/workspaces/plan.service.js'
import { getRedisConnection } from '../../queues/connection.js'

// ── Request / response schemas ────────────────────────────────────────────────

const createFormBodySchema = z.object({
  title: z.string().min(1),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase alphanumeric with dashes')
    .optional(),
  type: z.enum(['main', 'dynamic']),
  spec_json: z.unknown().optional(),
})

const updateFormBodySchema = z.object({
  title: z.string().min(1).optional(),
  slug: z
    .string()
    .min(1)
    .regex(/^[a-z0-9-]+$/)
    .optional(),
  type: z.enum(['main', 'dynamic']).optional(),
  archived: z.boolean().optional(),
})

const listFormsQuerySchema = z.object({
  q: z.string().optional(),
  status: z.enum(['active', 'archived']).optional(),
  limit: z.coerce.number().int().positive().max(200).default(50),
  offset: z.coerce.number().int().nonnegative().default(0),
})

const formIdOrSlugParamsSchema = z.object({ idOrSlug: z.string() })
const formIdParamsSchema = z.object({ id: z.string() })

// ── Plugin ────────────────────────────────────────────────────────────────────

export const formsAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── POST /admin/forms ─────────────────────────────────────────────────────
  // Creates a form definition. If spec_json is provided, also publishes version 1.
  app.post(
    '/admin/forms',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('update', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        body: createFormBodySchema,
      },
    },
    async (request, reply) => {
      const actorSub = request.session!.sub

      // ── Plan gate: max_forms ──────────────────────────────────────────────
      // Only enforced when the request carries a workspace context (L17).
      // Legacy / uncontexted requests skip the gate silently.
      const workspaceId = (request as any).workspaceId as string | undefined
      if (workspaceId) {
        const planService = new PlanService(fastify.prisma, getRedisConnection())
        try {
          await planService.assertCanCreateForm(workspaceId)
        } catch (err) {
          const e = err as Error & { code?: string; details?: Record<string, unknown> }
          if (e.code === 'plan_cap_exceeded') {
            return reply.status(403).send({ error: { code: e.code, message: e.message, details: e.details } })
          }
          throw err
        }
      }

      const formService = new FormService(fastify.prisma)
      const versionService = new VersionService(fastify.prisma)

      // Derive a slug from title if not provided
      const derivedSlug =
        request.body.title
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 60) || `form-${Date.now()}`
      const slug = request.body.slug ?? derivedSlug

      const form = await formService.createForm({
        ownerAccountId: actorSub,
        title: request.body.title,
        slug,
        type: request.body.type,
      })

      void new AuditService(fastify.prisma).record({
        actorAccountId: actorSub,
        action: 'form.create',
        subjectType: 'Form',
        subjectId: form.id,
        diff: { title: request.body.title, slug, type: request.body.type },
      })

      // If a spec was provided, publish version 1 immediately.
      if (request.body.spec_json !== undefined) {
        try {
          await versionService.publishVersion({
            formId: form.id,
            spec: request.body.spec_json,
            publishedBy: actorSub,
          })
        } catch (err) {
          // If spec publish fails, return the created form with a 201 but include
          // the validation error so the client knows the spec wasn't saved.
          if (err instanceof FormSpecValidationError) {
            return reply.status(201).send({
              ...form,
              _spec_warning: err.issues,
            })
          }
          throw err
        }

        // Re-fetch with updated currentVersion
        const updated = await formService.getFormWithCurrentVersion(form.id)
        return reply.status(201).send(updated)
      }

      return reply.status(201).send(form)
    },
  )

  // ── GET /admin/forms ──────────────────────────────────────────────────────
  app.get(
    '/admin/forms',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        querystring: listFormsQuerySchema,
      },
    },
    async (request, reply) => {
      const formService = new FormService(fastify.prisma)
      const forms = await formService.listForms({
        q: request.query.q,
        status: request.query.status,
        limit: request.query.limit,
        offset: request.query.offset,
      })
      return reply.send(forms)
    },
  )

  // ── GET /admin/forms/:idOrSlug ────────────────────────────────────────────
  app.get(
    '/admin/forms/:idOrSlug',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        params: formIdOrSlugParamsSchema,
      },
    },
    async (request, reply) => {
      const formService = new FormService(fastify.prisma)
      const form = await formService.getFormWithCurrentVersion(request.params.idOrSlug)
      if (!form) return reply.status(404).send({ error: { code: 'not_found', message: 'Form not found' } })
      return reply.send(form)
    },
  )

  // ── PUT /admin/forms/:id ──────────────────────────────────────────────────
  // Replace metadata (title, slug, type, archived). Does NOT change spec.
  app.put(
    '/admin/forms/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('update', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        params: formIdParamsSchema,
        body: updateFormBodySchema,
      },
    },
    async (request, reply) => {
      const data: Record<string, unknown> = {}
      if (request.body.title !== undefined) data['title'] = request.body.title
      if (request.body.slug !== undefined) data['slug'] = request.body.slug
      if (request.body.type !== undefined) data['type'] = request.body.type
      if (request.body.archived === true) data['archivedAt'] = new Date()
      if (request.body.archived === false) data['archivedAt'] = null

      const form = await fastify.prisma.formDefinition.update({
        where: { id: request.params.id },
        data,
      })
      void new AuditService(fastify.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'form.update',
        subjectType: 'Form',
        subjectId: form.id,
        diff: data,
      })
      return reply.send(form)
    },
  )

  // ── POST /admin/forms/:id/archive ─────────────────────────────────────────
  app.post(
    '/admin/forms/:id/archive',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('update', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        params: formIdParamsSchema,
      },
    },
    async (request, reply) => {
      const formService = new FormService(fastify.prisma)
      const form = await formService.archiveForm(request.params.id, request.session!.sub)
      void new AuditService(fastify.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'form.archive',
        subjectType: 'Form',
        subjectId: form.id,
      })
      return reply.send(form)
    },
  )

  // ── POST /admin/forms/:id/unarchive ───────────────────────────────────────
  app.post(
    '/admin/forms/:id/unarchive',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('update', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        params: formIdParamsSchema,
      },
    },
    async (request, reply) => {
      const formService = new FormService(fastify.prisma)
      const form = await formService.unarchiveForm(request.params.id, request.session!.sub)
      void new AuditService(fastify.prisma).record({
        actorAccountId: request.session?.sub ?? null,
        action: 'form.unarchive',
        subjectType: 'Form',
        subjectId: form.id,
      })
      return reply.send(form)
    },
  )

  // ── POST /admin/forms/:id/duplicate ───────────────────────────────────────
  // Clone metadata + current published spec into a new form.
  app.post(
    '/admin/forms/:id/duplicate',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('update', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        params: formIdParamsSchema,
        body: z
          .object({
            slug: z
              .string()
              .min(1)
              .max(80)
              .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/)
              .optional(),
            title: z.string().min(1).max(160).optional(),
          })
          .optional(),
      },
    },
    async (request, reply) => {
      const formService = new FormService(fastify.prisma)
      try {
        const out = await formService.duplicateForm({
          sourceFormIdOrSlug: request.params.id,
          actorSub: request.session!.sub,
          newSlug: request.body?.slug,
          newTitle: request.body?.title,
        })
        void new AuditService(fastify.prisma).record({
          actorAccountId: request.session?.sub ?? null,
          action: 'form.create',
          subjectType: 'Form',
          subjectId: out.id,
          diff: {
            cloned_from: request.params.id,
            cloned_from_version: out.sourceVersion,
            slug: out.slug,
          },
        })
        return reply.status(201).send(out)
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'source_not_found') {
          return reply
            .status(404)
            .send({ error: { code: 'not_found', message: e.message } })
        }
        if (e.code === 'invalid_slug') {
          return reply
            .status(400)
            .send({ error: { code: 'invalid_slug', message: e.message } })
        }
        if (e.code === 'slug_taken') {
          return reply
            .status(409)
            .send({ error: { code: 'slug_taken', message: e.message } })
        }
        throw err
      }
    },
  )

  // ── DELETE /admin/forms/:id ───────────────────────────────────────────────
  // Hard delete (cascades via FK). Super-admin only via `forms.write` + role check.
  app.delete(
    '/admin/forms/:id',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('update', 'Form'),
      ],
      schema: {
        tags: ['forms'],
        params: formIdParamsSchema,
      },
    },
    async (request, reply) => {
      // Only super-admin (all permissions) may hard-delete.
      const account = request.session!
      const isSuperAdmin = account.roles.includes('super-admin')
      if (!isSuperAdmin) {
        return reply.status(403).send({ error: { code: 'forbidden', message: 'Hard delete requires super-admin role' } })
      }

      await fastify.prisma.formDefinition.delete({ where: { id: request.params.id } })
      return reply.status(204).send()
    },
  )
}

export default formsAdminRoutes
