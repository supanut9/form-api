/**
 * Admin A/B experiment endpoints.
 *
 *   GET    /v1/admin/forms/:formIdOrSlug/experiments        — list for a form
 *   POST   /v1/admin/forms/:formIdOrSlug/experiments        — create (draft)
 *   GET    /v1/admin/experiments/:id                        — detail + exposure counts
 *   POST   /v1/admin/experiments/:id/start                  — start (draft → running)
 *   POST   /v1/admin/experiments/:id/stop                   — cancel (no winner)
 *   POST   /v1/admin/experiments/:id/stop-with-winner       — stop + promote winning version
 *   PATCH  /v1/admin/experiments/:id                        — update name/hypothesis/weights
 *
 * RBAC: requirePermission('manage', 'Form') on all routes.
 *
 * Weight PATCH while running (§10 risk #4):
 *   Weights can be changed while an experiment is running. Existing exposures are
 *   NOT retroactively reassigned — stickiness is enforced by the unique index on
 *   (experiment_id, anonymous_token). Only new visitors after the patch see the
 *   updated distribution. Document this in the UI with a warning.
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { requirePermission } from '../../core/auth/rbac.js'
import { ExperimentService } from '../../core/experiments/experiment.service.js'
import { FormService } from '../../core/forms/form.service.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

const isUuid = (s: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)

async function resolveFormId(
  formIdOrSlug: string,
  formService: FormService,
): Promise<string> {
  const form = await formService.getFormWithCurrentVersion(formIdOrSlug)
  if (!form) {
    const err = new Error('Form not found') as Error & { statusCode?: number; code?: string }
    err.statusCode = 404
    err.code = 'not_found'
    throw err
  }
  return form.id
}

function mapDomainError(err: unknown): { statusCode: number; code: string; message: string } {
  const e = err as Error & { code?: string }
  const code = e.code ?? 'internal'
  switch (code) {
    case 'not_found':
      return { statusCode: 404, code, message: e.message }
    case 'another_experiment_running':
      return { statusCode: 409, code, message: e.message }
    case 'validation_error':
      return { statusCode: 422, code, message: e.message }
    default:
      return { statusCode: 500, code: 'internal', message: 'Internal server error' }
  }
}

// ── Schemas ───────────────────────────────────────────────────────────────────

const formIdOrSlugParams = z.object({ formIdOrSlug: z.string().min(1) })
const experimentIdParams = z.object({ id: z.string().uuid() })

const variantInputSchema = z.object({
  label: z.string().min(1),
  version_id: z.string().uuid(),
  weight_bps: z.number().int().positive(),
})

const createBodySchema = z.object({
  name: z.string().min(1),
  hypothesis: z.string().optional(),
  primary_metric: z.enum(['submit_rate', 'completion_rate', 'payment_conversion']),
  variants: z.array(variantInputSchema).min(2),
})

const patchBodySchema = z.object({
  name: z.string().min(1).optional(),
  hypothesis: z.string().optional(),
  variant_weights: z
    .array(
      z.object({
        id: z.string().uuid(),
        weight_bps: z.number().int().positive(),
      }),
    )
    .optional(),
})

const stopWithWinnerBodySchema = z.object({
  variant_id: z.string().uuid(),
})

// ── Plugin ────────────────────────────────────────────────────────────────────

export const experimentsAdminRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()
  const preHandler = [fastify.authenticate, requirePermission('manage', 'Form')]

  // ── GET /v1/admin/forms/:formIdOrSlug/experiments ──────────────────────────

  app.get(
    '/v1/admin/forms/:formIdOrSlug/experiments',
    { preHandler, schema: { tags: ['experiments'], params: formIdOrSlugParams } },
    async (request, reply) => {
      try {
        const formService = new FormService(app.prisma)
        const formId = await resolveFormId(request.params.formIdOrSlug, formService)
        const service = new ExperimentService(app.prisma)
        const experiments = await service.listForForm(formId)
        return experiments
      } catch (err) {
        const mapped = mapDomainError(err)
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        })
      }
    },
  )

  // ── POST /v1/admin/forms/:formIdOrSlug/experiments ─────────────────────────

  app.post(
    '/v1/admin/forms/:formIdOrSlug/experiments',
    {
      preHandler,
      schema: { tags: ['experiments'], params: formIdOrSlugParams, body: createBodySchema },
    },
    async (request, reply) => {
      try {
        const formService = new FormService(app.prisma)
        const formId = await resolveFormId(request.params.formIdOrSlug, formService)
        const service = new ExperimentService(app.prisma)
        const experiment = await service.createExperiment({
          formId,
          name: request.body.name,
          hypothesis: request.body.hypothesis,
          primaryMetric: request.body.primary_metric,
          variants: request.body.variants.map((v) => ({
            label: v.label,
            versionId: v.version_id,
            weightBps: v.weight_bps,
          })),
        })
        return reply.status(201).send(experiment)
      } catch (err) {
        const mapped = mapDomainError(err)
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        })
      }
    },
  )

  // ── GET /v1/admin/experiments/:id ─────────────────────────────────────────

  app.get(
    '/v1/admin/experiments/:id',
    { preHandler, schema: { tags: ['experiments'], params: experimentIdParams } },
    async (request, reply) => {
      try {
        const service = new ExperimentService(app.prisma)
        const experiment = await service.getExperiment(request.params.id)
        if (!experiment) {
          return reply.status(404).send({ error: { code: 'not_found', message: 'Experiment not found' } })
        }

        // Per-variant submit counts (from form_submissions joined via form_versions)
        // We count submissions whose version matches a variant's form version number.
        const variantSubmitCounts: Record<string, number> = {}
        for (const v of experiment.variants) {
          const version = await app.prisma.formVersion.findUnique({
            where: { id: v.versionId },
            select: { version: true, formId: true },
          })
          if (version) {
            const count = await app.prisma.formSubmission.count({
              where: {
                formId: version.formId,
                version: version.version,
                deletedAt: null,
              },
            })
            variantSubmitCounts[v.id] = count
          }
        }

        return {
          ...experiment,
          variants: experiment.variants.map((v) => ({
            ...v,
            submitCount: variantSubmitCounts[v.id] ?? 0,
          })),
        }
      } catch (err) {
        const mapped = mapDomainError(err)
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        })
      }
    },
  )

  // ── POST /v1/admin/experiments/:id/start ──────────────────────────────────

  app.post(
    '/v1/admin/experiments/:id/start',
    { preHandler, schema: { tags: ['experiments'], params: experimentIdParams } },
    async (request, reply) => {
      try {
        const service = new ExperimentService(app.prisma)
        const experiment = await service.startExperiment(request.params.id)
        return experiment
      } catch (err) {
        const mapped = mapDomainError(err)
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        })
      }
    },
  )

  // ── POST /v1/admin/experiments/:id/stop ───────────────────────────────────

  app.post(
    '/v1/admin/experiments/:id/stop',
    { preHandler, schema: { tags: ['experiments'], params: experimentIdParams } },
    async (request, reply) => {
      try {
        const service = new ExperimentService(app.prisma)
        const experiment = await service.cancelExperiment(request.params.id)
        return experiment
      } catch (err) {
        const mapped = mapDomainError(err)
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        })
      }
    },
  )

  // ── POST /v1/admin/experiments/:id/stop-with-winner ───────────────────────

  app.post(
    '/v1/admin/experiments/:id/stop-with-winner',
    {
      preHandler,
      schema: {
        tags: ['experiments'],
        params: experimentIdParams,
        body: stopWithWinnerBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const service = new ExperimentService(app.prisma)
        const experiment = await service.stopExperimentWithWinner(
          request.params.id,
          request.body.variant_id,
        )
        return experiment
      } catch (err) {
        const mapped = mapDomainError(err)
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        })
      }
    },
  )

  // ── PATCH /v1/admin/experiments/:id ───────────────────────────────────────

  app.patch(
    '/v1/admin/experiments/:id',
    {
      preHandler,
      schema: {
        tags: ['experiments'],
        params: experimentIdParams,
        body: patchBodySchema,
      },
    },
    async (request, reply) => {
      try {
        const service = new ExperimentService(app.prisma)
        const experiment = await service.patchExperiment(request.params.id, {
          name: request.body.name,
          hypothesis: request.body.hypothesis,
          variantWeights: request.body.variant_weights?.map((vw) => ({
            id: vw.id,
            weightBps: vw.weight_bps,
          })),
        })
        return experiment
      } catch (err) {
        const mapped = mapDomainError(err)
        return reply.status(mapped.statusCode).send({
          error: { code: mapped.code, message: mapped.message },
        })
      }
    },
  )
}

export default experimentsAdminRoutes
