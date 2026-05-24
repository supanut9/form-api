/**
 * Public file-upload endpoints.
 *
 *   POST /public/files/presign  → mint a one-shot upload URL (5 min)
 *   POST /public/files/confirm  → HEAD-verify the object and finalize the row
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { FileService } from '../../core/files/file.service.js'
import { FormService } from '../../core/forms/form.service.js'
import { formSpecSchema } from '../../core/forms/types.js'
import { PlanService } from '../../core/workspaces/plan.service.js'
import { getRedisConnection } from '../../queues/connection.js'

const presignBodySchema = z.object({
  filename: z.string().min(1).max(255),
  content_type: z.string().min(1).max(120),
  size: z.number().int().positive().max(50 * 1024 * 1024),
  form_slug: z.string().min(1).optional(),
  field_id: z.string().min(1).optional(),
})

const confirmBodySchema = z.object({
  file_id: z.string().uuid(),
  sha256: z.string().regex(/^[0-9a-f]{64}$/i, 'sha256 must be 64 hex chars'),
})

const ANON_COOKIE = 'form_anon'

export const filesPublicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/public/files/presign',
    {
      schema: {
        tags: ['public', 'files'],
        body: presignBodySchema,
      },
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      // Resolve form (optional — files can be orphaned until submission).
      let formId: string | null = null
      let maxSize: number | undefined
      let allowedMimes: string[] | undefined
      if (request.body.form_slug) {
        const formService = new FormService(app.prisma)
        const form = await formService.getFormWithCurrentVersion(request.body.form_slug)
        if (!form) {
          return reply
            .status(404)
            .send({ error: { code: 'not_found', message: 'Form not found' } })
        }
        formId = form.id
        if (request.body.field_id && form.currentVersionRow?.specJson) {
          const parsed = formSpecSchema.safeParse(form.currentVersionRow.specJson)
          if (parsed.success) {
            for (const page of parsed.data.pages) {
              const f = page.fields.find((x) => x.id === request.body.field_id)
              if (f && f.type === 'file') {
                const v = (f as { validation?: { max_size_bytes?: number; allowed_mime_types?: string[] } }).validation
                if (v?.max_size_bytes) maxSize = v.max_size_bytes
                if (v?.allowed_mime_types?.length) allowedMimes = v.allowed_mime_types
              }
            }
          }
        }

        // ── Phase 3C: cap max_size by the workspace plan's maxFileSizeMb ────
        // If the form is workspace-scoped, clamp to min(spec limit, plan limit).
        const formWorkspaceId: string | null = (form as any).workspaceId ?? null
        if (formWorkspaceId) {
          try {
            const planService = new PlanService(app.prisma, getRedisConnection())
            const gates = await planService.getFeatureGates(formWorkspaceId)
            const planMaxBytes = gates.max_file_size_mb * 1024 * 1024
            maxSize = maxSize !== undefined ? Math.min(maxSize, planMaxBytes) : planMaxBytes
          } catch {
            // Non-fatal — fall through to spec limit or default
          }
        }
      }

      const accountId = request.session?.sub ?? null
      const anon = request.cookies?.[ANON_COOKIE] ?? null

      const service = new FileService(app.prisma)
      try {
        const out = await service.presignUpload({
          filename: request.body.filename,
          contentType: request.body.content_type,
          size: request.body.size,
          formId,
          accountId,
          anonymousToken: anon,
          maxSizeBytes: maxSize,
          allowedMimeTypes: allowedMimes,
        })
        return out
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'file_too_large' || e.code === 'mime_not_allowed') {
          return reply
            .status(400)
            .send({ error: { code: e.code, message: e.message } })
        }
        throw err
      }
    },
  )

  app.post(
    '/public/files/confirm',
    {
      schema: {
        tags: ['public', 'files'],
        body: confirmBodySchema,
      },
      config: {
        rateLimit: { max: 60, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const service = new FileService(app.prisma)
      try {
        return await service.confirmUpload({
          fileId: request.body.file_id,
          sha256: request.body.sha256,
        })
      } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'not_found') {
          return reply
            .status(404)
            .send({ error: { code: 'not_found', message: e.message } })
        }
        if (e.code === 'object_missing' || e.code === 'size_mismatch') {
          return reply
            .status(400)
            .send({ error: { code: e.code, message: e.message } })
        }
        throw err
      }
    },
  )
}

export default filesPublicRoutes
