/**
 * POST /v1/public/forms/:slug/payment-intent
 *
 * Creates a Stripe PaymentIntent for a payment-gated form.
 * The client receives the client_secret and uses Stripe Elements to confirm.
 * Amount is ALWAYS server-derived from the spec (never trusted from client).
 *
 * Scope: fixed-mode payment only. calculated + tier are deferred (see PaymentService).
 */
import { z } from 'zod'
import type { FastifyPluginAsync } from 'fastify'
import type { ZodTypeProvider } from 'fastify-type-provider-zod'
import { FormService } from '../../core/forms/form.service.js'
import { PaymentService } from '../../core/payments/payment.service.js'
import { formSpecSchema } from '../../core/forms/types.js'
import { PlanService } from '../../core/workspaces/plan.service.js'
import { getRedisConnection } from '../../queues/connection.js'

const paramsSchema = z.object({ slug: z.string().min(1) })
const bodySchema = z.object({}).passthrough()

export const paymentIntentPublicRoutes: FastifyPluginAsync = async (fastify) => {
  const app = fastify.withTypeProvider<ZodTypeProvider>()

  app.post(
    '/v1/public/forms/:slug/payment-intent',
    {
      preHandler: [fastify.maybeAuthenticate],
      schema: {
        tags: ['public', 'payments'],
        description:
          'Create a Stripe PaymentIntent for a payment-gated form. Amount is server-derived from the spec.',
        params: paramsSchema,
        body: bodySchema,
      },
      config: {
        rateLimit: { max: 30, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const formService = new FormService(app.prisma)
      const form = await formService.getFormWithCurrentVersion(request.params.slug)

      if (!form || !form.currentVersionRow) {
        return reply.status(404).send({
          error: { code: 'not_found', message: 'Form not found or not published' },
        })
      }

      const specParsed = formSpecSchema.safeParse(form.currentVersionRow.specJson)
      if (!specParsed.success) {
        return reply.status(500).send({
          error: { code: 'spec_invalid', message: 'Published spec is invalid' },
        })
      }
      const spec = specParsed.data as typeof specParsed.data & {
        payment?: {
          mode?: string
          currency?: string
          amount_minor?: number
          capture_intent?: string
          stripe_account_id?: string
          required_for_submit?: boolean
        }
      }

      if (!spec.payment) {
        return reply.status(400).send({
          error: {
            code: 'payment_not_configured',
            message: 'This form does not have a payment configuration',
          },
        })
      }

      // ── Phase 3C: plan gate — payments_enabled ───────────────────────────
      const formWorkspaceId: string | null = (form as any).workspaceId ?? null
      if (formWorkspaceId) {
        const planService = new PlanService(app.prisma, getRedisConnection())
        try {
          await planService.assertPaymentsEnabled(formWorkspaceId)
        } catch (err) {
          const e = err as Error & { code?: string; details?: Record<string, unknown> }
          if (e.code === 'feature_not_in_plan') {
            return reply.status(403).send({ error: { code: e.code, message: e.message, details: e.details } })
          }
          throw err
        }
      }

      if (spec.payment.mode !== 'fixed') {
        return reply.status(400).send({
          error: {
            code: 'unsupported_payment_mode',
            message: `Payment mode "${spec.payment.mode ?? 'undefined'}" is not supported. Only "fixed" mode is available in this release.`,
          },
        })
      }

      const accountSub = request.session?.sub ?? null
      const anonymousToken = request.cookies?.['form_anon'] ?? null

      const paymentService = new PaymentService(app.prisma)
      let result
      try {
        result = await paymentService.createIntentForForm({
          formId: form.id,
          version: form.currentVersion,
          spec: { payment: spec.payment },
          accountSub,
          anonymousToken,
        })
      } catch (err: unknown) {
        const e = err as Error & { code?: string }
        if (e.code === 'payments_not_configured') {
          return reply.status(503).send({
            error: { code: 'payments_not_configured', message: e.message },
          })
        }
        throw err
      }

      return reply.status(200).send({
        client_secret: result.clientSecret,
        payment_intent_id: result.paymentIntentId,
        amount_minor: result.amountMinor,
        currency: result.currency,
        publishable_key: result.publishableKey,
      })
    },
  )
}

export default paymentIntentPublicRoutes
