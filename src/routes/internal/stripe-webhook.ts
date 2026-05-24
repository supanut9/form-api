/**
 * POST /v1/internal/stripe/webhook
 *
 * Receives and processes signed Stripe webhook events.
 *
 * Authentication: NONE — Stripe signs the payload; the signature IS the auth.
 * Body parsing: raw Buffer required for `Stripe.webhooks.constructEvent`.
 *   A scoped `addContentTypeParser` overrides the global JSON parser for this
 *   plugin only — the global parser is NOT changed.
 *
 * Dispatch:
 *   - payment_intent.* and charge.* → PaymentService.reconcileWebhookEvent (3B.1)
 *   - customer.subscription.* and invoice.* → BillingService.applySubscriptionEvent (3C L19)
 *
 * The existing PaymentService flow is preserved exactly — no lines were changed.
 */
import type { FastifyPluginAsync } from 'fastify'
import { PaymentService } from '../../core/payments/payment.service.js'
import { BillingService } from '../../core/workspaces/billing.service.js'
import { getStripe } from '../../core/payments/stripe.client.js'
import { env } from '../../config/env.js'

// ---------------------------------------------------------------------------
// Event type prefix routing
// ---------------------------------------------------------------------------

const SUBSCRIPTION_EVENT_PREFIXES = [
  'customer.subscription.',
  'invoice.',
]

function isSubscriptionEvent(eventType: string): boolean {
  return SUBSCRIPTION_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))
}

const PAYMENT_EVENT_PREFIXES = [
  'payment_intent.',
  'charge.',
]

function isPaymentEvent(eventType: string): boolean {
  return PAYMENT_EVENT_PREFIXES.some((prefix) => eventType.startsWith(prefix))
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

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

    // ── Determine event type without fully parsing (verify first) ─────────────
    // We need to verify the signature before we can trust the event type.
    // Parse the event using PaymentService's existing path for payment events,
    // or construct it directly for subscription events.

    if (!env.STRIPE_WEBHOOK_SECRET) {
      return reply.status(400).send({
        error: { code: 'payments_not_configured', message: 'STRIPE_WEBHOOK_SECRET is not configured' },
      })
    }

    let event: import('stripe').default.Event
    try {
      const stripe = getStripe()
      event = stripe.webhooks.constructEvent(
        rawBody,
        signatureHeader,
        env.STRIPE_WEBHOOK_SECRET,
      ) as import('stripe').default.Event
    } catch (err: unknown) {
      const e = err as Error & { type?: string }
      if (e.type === 'StripeSignatureVerificationError' || e.message?.includes('signature')) {
        return reply.status(400).send({
          error: { code: 'invalid_signature', message: e.message },
        })
      }
      throw err
    }

    // ── Route to appropriate service ──────────────────────────────────────────

    let result: { idempotent?: boolean; ignored?: boolean }

    if (isPaymentEvent(event.type)) {
      // Payment events — delegate to PaymentService (3B.1, unchanged)
      // PaymentService re-verifies the signature internally; that is fine since
      // constructEvent is idempotent for the same rawBody + sig combo.
      const paymentService = new PaymentService(fastify.prisma)
      try {
        result = await paymentService.reconcileWebhookEvent(rawBody, signatureHeader)
      } catch (err: unknown) {
        const e = err as Error & { code?: string; type?: string }
        if (
          e.type === 'StripeSignatureVerificationError' ||
          e.message?.includes('signature') ||
          e.code === 'payments_not_configured'
        ) {
          return reply.status(400).send({
            error: { code: e.code ?? 'invalid_signature', message: e.message },
          })
        }
        throw err
      }
    } else if (isSubscriptionEvent(event.type)) {
      // Subscription + invoice events — delegate to BillingService (3C L19)
      const billingService = new BillingService(fastify.prisma)
      result = await billingService.applySubscriptionEvent(event)
    } else {
      // Unhandled event type — acknowledge to Stripe (prevents re-delivery)
      result = { ignored: true }
    }

    return reply.status(200).send(result)
  })
}

export default stripeWebhookInternalRoutes
