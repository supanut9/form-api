/**
 * POST /v1/internal/stripe/webhook
 *
 * Receives and processes signed Stripe webhook events.
 *
 * Authentication: NONE — Stripe signs the payload; the signature IS the auth.
 * Body parsing: raw Buffer required for `Stripe.webhooks.constructEvent`.
 *   A scoped `addContentTypeParser` overrides the global JSON parser for this
 *   plugin only — the global parser is NOT changed.
 */
import type { FastifyPluginAsync } from 'fastify'
import { PaymentService } from '../../core/payments/payment.service.js'

export const stripeWebhookInternalRoutes: FastifyPluginAsync = async (fastify) => {
  // Override content-type parsing for application/json ONLY within this plugin
  // scope. Stripe needs the raw body bytes for HMAC signature verification.
  fastify.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => {
      done(null, body)
    },
  )

  fastify.post('/v1/internal/stripe/webhook', async (request, reply) => {
    const rawBody = request.body as Buffer
    const signatureHeader = request.headers['stripe-signature']

    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return reply.status(400).send({
        error: { code: 'missing_signature', message: 'stripe-signature header is required' },
      })
    }

    const paymentService = new PaymentService(fastify.prisma)

    let result: { idempotent?: boolean; ignored?: boolean }
    try {
      result = await paymentService.reconcileWebhookEvent(rawBody, signatureHeader)
    } catch (err: unknown) {
      const e = err as Error & { code?: string; type?: string }

      // Stripe signature verification failure
      if (
        e.type === 'StripeSignatureVerificationError' ||
        e.message?.includes('signature') ||
        e.code === 'payments_not_configured'
      ) {
        return reply.status(400).send({
          error: {
            code: e.code ?? 'invalid_signature',
            message: e.message,
          },
        })
      }

      throw err
    }

    return reply.status(200).send(result)
  })
}

export default stripeWebhookInternalRoutes
