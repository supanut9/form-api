/**
 * Admin file endpoints.
 *
 *   GET /admin/files/:id/download → presigned 5-min S3 GET URL
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { FileService } from '../../core/files/file.service.js'

const paramsSchema = z.object({ id: z.string().uuid() })

export const filesAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.get(
    '/admin/files/:id/download',
    {
      preHandler: [
        fastify.authenticate,
        requirePermission('read', 'Submission'),
      ],
      schema: {
        tags: ['admin', 'files'],
        params: paramsSchema,
      },
    },
    async (request, reply) => {
      const service = new FileService(app.prisma)
      const out = await service.generateDownloadUrl(request.params.id)
      if (!out) {
        return reply
          .status(404)
          .send({ error: { code: 'not_found', message: 'File not found' } })
      }
      return out
    },
  )
}

export default filesAdminRoutes
