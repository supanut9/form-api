/**
 * GET /public/forms/:slug
 *
 * Returns the current published form-spec for public rendering on form-web.
 * No auth required — the form's own `access.mode` governs whether submission
 * is allowed (enforced by the submit route).
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { FormService } from '../../core/forms/form.service.js'

const paramsSchema = z.object({ slug: z.string().min(1) })

export const renderSpecPublicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get(
    '/public/forms/:slug',
    {
      schema: {
        tags: ['public'],
        description: 'Fetch the current published spec for a form (by slug or id)',
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const service = new FormService(app.prisma)
      const form = await service.getFormWithCurrentVersion(request.params.slug)

      if (!form || !form.currentVersionRow) {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Form not found or not yet published' },
        })
      }

      const version = form.currentVersionRow

      return {
        id: form.id,
        slug: form.slug,
        title: form.title,
        type: form.type,
        current_version: form.currentVersion,
        spec_json: version.specJson,
        schema_hash: version.schemaHash,
      }
    },
  )
}

export default renderSpecPublicRoutes
