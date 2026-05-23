/**
 * Admin routes for form templates — Phase 3A.
 * Mirrors the shape of routes/admin/forms.ts.
 */

import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import { ZodTypeProvider } from 'fastify-type-provider-zod'
import { TemplateService } from '../../core/templates/template.service.js'
import { AuditService } from '../../core/audit/audit.service.js'
import { requirePermission } from '../../core/auth/rbac.js'
import { FormSpecValidationError } from '../../core/forms/spec.validator.js'

// ── Zod schemas ───────────────────────────────────────────────────────────────

const slugSchema = z
  .string()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/, 'slug must be lowercase alphanumeric with dashes')

const createTemplateBodySchema = z.object({
  slug: slugSchema,
  title: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  category: z.string().min(1).max(80),
  spec_json: z.unknown(),
  featured_order: z.number().int().nonnegative().optional(),
  created_by: z.string().uuid().optional(),
  workspace_id: z.string().uuid().optional(),
})

const updateTemplateBodySchema = z.object({
  slug: slugSchema.optional(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(1000).optional(),
  category: z.string().min(1).max(80).optional(),
  spec_json: z.unknown().optional(),
  featured_order: z.number().int().nonnegative().nullable().optional(),
  workspace_id: z.string().uuid().nullable().optional(),
})

const listTemplatesQuerySchema = z.object({
  category: z.string().optional(),
  includePublic: z
    .string()
    .optional()
    .transform((v) => v !== 'false'),
})

const templateIdOrSlugParamsSchema = z.object({ idOrSlug: z.string() })
const templateIdParamsSchema = z.object({ id: z.string().uuid() })

const cloneTemplateBodySchema = z
  .object({
    newSlug: slugSchema.optional(),
    newTitle: z.string().min(1).max(200).optional(),
  })
  .optional()

// ── Plugin ────────────────────────────────────────────────────────────────────

export const templatesAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  // ── GET /admin/templates ────────────────────────────────────────────────────
  app.get(
    '/admin/templates',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'FormTemplate')],
      schema: {
        tags: ['templates'],
        querystring: listTemplatesQuerySchema,
      },
    },
    async (request, reply) => {
      const svc = new TemplateService(fastify.prisma)
      const templates = await svc.listTemplates({
        category: request.query.category,
        includePublic: request.query.includePublic,
      })
      return reply.send(templates)
    },
  )

  // ── GET /admin/templates/:idOrSlug ──────────────────────────────────────────
  app.get(
    '/admin/templates/:idOrSlug',
    {
      preHandler: [fastify.authenticate, requirePermission('read', 'FormTemplate')],
      schema: {
        tags: ['templates'],
        params: templateIdOrSlugParamsSchema,
      },
    },
    async (request, reply) => {
      const svc = new TemplateService(fastify.prisma)
      const template = await svc.getTemplate(request.params.idOrSlug)
      if (!template) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'Template not found' } })
      }
      return reply.send(template)
    },
  )

  // ── POST /admin/templates ───────────────────────────────────────────────────
  app.post(
    '/admin/templates',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'FormTemplate')],
      schema: {
        tags: ['templates'],
        body: createTemplateBodySchema,
      },
    },
    async (request, reply) => {
      const actorSub = request.session!.sub
      const svc = new TemplateService(fastify.prisma)

      try {
        const template = await svc.createTemplate({
          slug: request.body.slug,
          title: request.body.title,
          description: request.body.description,
          category: request.body.category,
          specJson: request.body.spec_json,
          featuredOrder: request.body.featured_order,
          createdBy: request.body.created_by,
          workspaceId: request.body.workspace_id,
        })

        void new AuditService(fastify.prisma).record({
          actorAccountId: actorSub,
          action: 'template.create',
          subjectType: 'FormTemplate',
          subjectId: template.id,
          diff: { slug: template.slug, title: template.title, category: template.category },
        })

        return reply.status(201).send(template)
      } catch (err) {
        if (err instanceof FormSpecValidationError) {
          return reply
            .status(400)
            .send({ error: { code: 'invalid_spec', message: err.message, issues: err.issues } })
        }
        throw err
      }
    },
  )

  // ── PATCH /admin/templates/:id ──────────────────────────────────────────────
  app.patch(
    '/admin/templates/:id',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'FormTemplate')],
      schema: {
        tags: ['templates'],
        params: templateIdParamsSchema,
        body: updateTemplateBodySchema,
      },
    },
    async (request, reply) => {
      const actorSub = request.session!.sub
      const svc = new TemplateService(fastify.prisma)

      try {
        const template = await svc.updateTemplate(request.params.id, {
          slug: request.body.slug,
          title: request.body.title,
          description: request.body.description,
          category: request.body.category,
          specJson: request.body.spec_json,
          featuredOrder: request.body.featured_order ?? undefined,
          workspaceId: request.body.workspace_id ?? undefined,
        })

        void new AuditService(fastify.prisma).record({
          actorAccountId: actorSub,
          action: 'template.update',
          subjectType: 'FormTemplate',
          subjectId: template.id,
          diff: request.body as Record<string, unknown>,
        })

        return reply.send(template)
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'spec_immutable_after_use') {
          return reply.status(409).send({ error: { code: e.code, message: e.message } })
        }
        if (err instanceof FormSpecValidationError) {
          return reply
            .status(400)
            .send({ error: { code: 'invalid_spec', message: err.message, issues: err.issues } })
        }
        throw err
      }
    },
  )

  // ── DELETE /admin/templates/:id ─────────────────────────────────────────────
  app.delete(
    '/admin/templates/:id',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'FormTemplate')],
      schema: {
        tags: ['templates'],
        params: templateIdParamsSchema,
      },
    },
    async (request, reply) => {
      const actorSub = request.session!.sub
      const svc = new TemplateService(fastify.prisma)

      try {
        await svc.deleteTemplate(request.params.id)

        void new AuditService(fastify.prisma).record({
          actorAccountId: actorSub,
          action: 'template.delete',
          subjectType: 'FormTemplate',
          subjectId: request.params.id,
        })

        return reply.status(204).send()
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'template_has_uses') {
          return reply.status(409).send({ error: { code: e.code, message: e.message } })
        }
        throw err
      }
    },
  )

  // ── POST /admin/templates/:id/clone ─────────────────────────────────────────
  app.post(
    '/admin/templates/:id/clone',
    {
      preHandler: [fastify.authenticate, requirePermission('manage', 'FormTemplate')],
      schema: {
        tags: ['templates'],
        params: templateIdParamsSchema,
        body: cloneTemplateBodySchema,
      },
    },
    async (request, reply) => {
      const actorSub = request.session!.sub
      const svc = new TemplateService(fastify.prisma)

      try {
        const result = await svc.cloneTemplateIntoForm(request.params.id, {
          newSlug: request.body?.newSlug,
          newTitle: request.body?.newTitle,
          ownerAccountId: actorSub,
        })

        void new AuditService(fastify.prisma).record({
          actorAccountId: actorSub,
          action: 'form.create',
          subjectType: 'Form',
          subjectId: result.id,
          diff: { cloned_from_template: request.params.id, slug: result.slug },
        })

        return reply.status(201).send(result)
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'template_not_found') {
          return reply.status(404).send({ error: { code: 'not_found', message: e.message } })
        }
        if (e.code === 'slug_taken') {
          return reply.status(409).send({ error: { code: e.code, message: e.message } })
        }
        throw err
      }
    },
  )
}

export default templatesAdminRoutes
