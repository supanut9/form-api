/**
 * GET /public/forms/:slug
 *
 * Returns the current published form-spec for public rendering on form-web.
 * No auth required — the form's own `access.mode` governs whether submission
 * is allowed (enforced by the submit route).
 *
 * Phase 3B L14 addition: if a running A/B experiment exists for the form, we
 * deterministically assign the visitor to a variant (sticky via the anon cookie)
 * and return that variant's specJson instead of the default currentVersion spec.
 * Any experiment error falls back to the default spec — rendering is never blocked.
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { FormService } from '../../core/forms/form.service.js'
import { ExperimentService } from '../../core/experiments/experiment.service.js'
import { ANON_COOKIE, ANON_COOKIE_MAX_AGE } from '../../core/analytics/anonymous-token.js'
import { PlanService } from '../../core/workspaces/plan.service.js'
import { getRedisConnection } from '../../queues/connection.js'

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

      let version = form.currentVersionRow

      // ── A/B experiment resolution ────────────────────────────────────────────
      // On any error we fall back to the default spec; rendering must never block.
      try {
        const experimentService = new ExperimentService(app.prisma)
        const runningExp = await experimentService.getRunningExperimentForForm(form.id)

        if (runningExp) {
          // Get or issue the form_anon cookie
          let anonymousToken = request.cookies?.[ANON_COOKIE] ?? null
          if (!anonymousToken) {
            anonymousToken = randomUUID()
            reply.setCookie(ANON_COOKIE, anonymousToken, {
              httpOnly: true,
              sameSite: 'lax',
              path: '/',
              maxAge: ANON_COOKIE_MAX_AGE,
            })
          }

          // Record the exposure (idempotent upsert — returns existing variantId on re-entry)
          const { variantId } = await experimentService.recordExposure({
            experimentId: runningExp.id,
            anonymousToken,
            accountId: undefined,
          })

          // Load the variant's FormVersion to get its specJson
          const variantRow = runningExp.variants.find((v) => v.id === variantId)
          if (variantRow) {
            const variantVersion = await app.prisma.formVersion.findUnique({
              where: { id: variantRow.versionId },
              select: {
                id: true,
                formId: true,
                version: true,
                specJson: true,
                schemaHash: true,
                publishedAt: true,
                publishedBy: true,
                isCurrent: true,
              },
            })
            if (variantVersion && variantVersion.publishedAt) {
              version = {
                ...variantVersion,
                publishedAt: variantVersion.publishedAt,
                publishedBy: variantVersion.publishedBy ?? '',
              }
            }
          }
        }
      } catch (err) {
        request.log.warn({ err }, '[render-spec] experiment resolution failed; using default spec')
      }

      // ── Phase 3C: feature gates ─────────────────────────────────────────────
      // If the form has a workspaceId (added by L17), load the plan's feature
      // gates and include them in the response so the renderer can conditionally
      // show payment / experiment blocks. Falls back to permissive defaults so
      // existing unscoped forms render unaffected.
      let features: {
        payments_enabled: boolean
        experiments_enabled: boolean
        max_file_size_mb: number
      } = {
        payments_enabled: true,
        experiments_enabled: true,
        max_file_size_mb: 50,
      }

      const formWorkspaceId: string | null = (form as any).workspaceId ?? null
      if (formWorkspaceId) {
        try {
          const planService = new PlanService(app.prisma, getRedisConnection())
          const gates = await planService.getFeatureGates(formWorkspaceId)
          features = {
            payments_enabled: gates.payments_enabled,
            experiments_enabled: gates.experiments_enabled,
            max_file_size_mb: gates.max_file_size_mb,
          }
        } catch (err) {
          request.log.warn({ err }, '[render-spec] feature-gate load failed; using permissive defaults')
        }
      }

      // Backward-compatible: existing callers that destructure { spec } or the
      // flat top-level fields continue to work. `features` is purely additive.
      return {
        id: form.id,
        slug: form.slug,
        title: form.title,
        type: form.type,
        current_version: form.currentVersion,
        spec_json: version.specJson,
        schema_hash: version.schemaHash,
        features,
      }
    },
  )
}

export default renderSpecPublicRoutes
