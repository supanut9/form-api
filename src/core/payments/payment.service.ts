/**
 * PaymentService — Stripe payment intent lifecycle for forms.
 *
 * NOTE: This service references the `FormPayment` Prisma model which is added
 * by Lane L10's migration `20260615_phase3b_payments_experiments_analytics`.
 * Run `npx prisma generate` after that migration lands to resolve typecheck
 * errors on the prisma.formPayment calls below.
 *
 * Model shape (agreed with L10):
 *   FormPayment { id, submissionId, stripePaymentIntentId (unique),
 *     amountMinor, currency, status (enum: pending|succeeded|failed|refunded),
 *     capturedAt?, stripeEventId? (unique, idempotency key), stripeAccountId? }
 */
import type { PrismaClient } from '@prisma/client'
import Stripe from 'stripe'
import { getStripe, withConnect } from './stripe.client.js'
import { env } from '../../config/env.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateIntentInput {
  formId: string
  version: number
  spec: {
    payment?: {
      mode?: string
      currency?: string
      amount_minor?: number
      amount_formula?: string
      capture_intent?: string
      stripe_account_id?: string
      required_for_submit?: boolean
    }
  }
  accountSub?: string | null
  anonymousToken?: string | null
}

export interface CreateIntentResult {
  clientSecret: string
  paymentIntentId: string
  amountMinor: number
  currency: string
  publishableKey: string | null
}

export interface RecordPaymentInput {
  submissionId: string
  paymentIntentId: string
  stripeAccountId?: string | null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function intentStatusToFormStatus(
  status: Stripe.PaymentIntent.Status,
): 'pending' | 'succeeded' | 'failed' {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'requires_capture':
      return 'pending'
    case 'canceled':
      return 'failed'
    default:
      // processing | requires_action | requires_confirmation | requires_payment_method
      return 'pending'
  }
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class PaymentService {
  constructor(private readonly prisma: PrismaClient) {}

  /**
   * Creates a Stripe PaymentIntent for a form.
   *
   * Supports `mode: 'fixed'` only. `calculated` and `tier` are deferred:
   * - `calculated`: requires submitted field values + HyperFormula gate; will land in a future lane.
   * - `tier`: requires tier lookup table in spec; out of scope for 3B Wave 1.
   */
  async createIntentForForm(input: CreateIntentInput): Promise<CreateIntentResult> {
    const payment = input.spec.payment
    if (!payment) {
      const err = new Error('Form has no payment config') as Error & { code?: string }
      err.code = 'payment_not_configured'
      throw err
    }

    if (!payment.mode || payment.mode !== 'fixed') {
      const err = new Error(
        `Payment mode "${payment.mode ?? 'undefined'}" is not supported in this lane. Only "fixed" mode is implemented. "calculated" and "tier" are deferred.`,
      ) as Error & { code?: string }
      err.code = 'unsupported_payment_mode'
      throw err
    }

    if (!payment.amount_minor || payment.amount_minor <= 0) {
      const err = new Error('amount_minor must be a positive integer for fixed mode') as Error & {
        code?: string
      }
      err.code = 'invalid_amount'
      throw err
    }

    const currency = (payment.currency ?? 'usd').toLowerCase()
    const amountMinor = payment.amount_minor
    const stripeAccountId = payment.stripe_account_id ?? null

    const stripe = getStripe()

    const intent = await stripe.paymentIntents.create(
      {
        amount: amountMinor,
        currency,
        automatic_payment_methods: { enabled: true },
        metadata: {
          formId: input.formId,
          version: String(input.version),
          accountSub: input.accountSub ?? '',
          anonymousToken: input.anonymousToken ?? '',
        },
      },
      withConnect(stripeAccountId),
    )

    if (!intent.client_secret) {
      const err = new Error('Stripe did not return a client_secret') as Error & { code?: string }
      err.code = 'stripe_error'
      throw err
    }

    return {
      clientSecret: intent.client_secret,
      paymentIntentId: intent.id,
      amountMinor,
      currency,
      publishableKey: env.STRIPE_PUBLISHABLE_KEY ?? null,
    }
  }

  /**
   * Server-side re-verification of a PaymentIntent and upsert of the
   * FormPayment row. Must be called AFTER the submission row is created so
   * the submissionId FK is satisfied.
   *
   * Throws `intent_not_succeeded` if the intent is not in an acceptable state.
   */
  async recordPaymentForSubmission(input: RecordPaymentInput): Promise<void> {
    const stripe = getStripe()
    const intent = await stripe.paymentIntents.retrieve(
      input.paymentIntentId,
      {},
      withConnect(input.stripeAccountId ?? null),
    )

    const acceptableStatuses: Stripe.PaymentIntent.Status[] = ['succeeded', 'requires_capture']
    if (!acceptableStatuses.includes(intent.status)) {
      const err = new Error(
        `PaymentIntent ${intent.id} has status "${intent.status}", expected succeeded or requires_capture`,
      ) as Error & { code?: string }
      err.code = 'intent_not_succeeded'
      throw err
    }

    const formStatus = intentStatusToFormStatus(intent.status)
    const capturedAt = intent.status === 'succeeded' ? new Date() : null

    // Upsert: if a row exists for this intent (e.g. webhook arrived first),
    // update it. Otherwise create a new one.
    // NOTE: prisma.formPayment will not exist until L10's migration + generate.
    const prismaAny = this.prisma as unknown as Record<string, any>
    await prismaAny['formPayment'].upsert({
      where: { stripePaymentIntentId: input.paymentIntentId },
      create: {
        submissionId: input.submissionId,
        stripePaymentIntentId: input.paymentIntentId,
        amountMinor: intent.amount,
        currency: intent.currency,
        status: formStatus,
        capturedAt,
        stripeAccountId: input.stripeAccountId ?? null,
      },
      update: {
        status: formStatus,
        capturedAt: capturedAt ?? undefined,
      },
    })
  }

  /**
   * Processes an inbound Stripe webhook event with idempotency.
   *
   * Idempotency: inside a single Prisma transaction, an update with
   * `where: { stripeEventId: event.id }` is attempted first. If it succeeds
   * (the row is found), the event was already processed and we return early.
   * Otherwise the state transition AND the stripeEventId write happen atomically
   * in the same update, preventing double-processing on retries.
   */
  async reconcileWebhookEvent(
    rawBody: Buffer | string,
    signatureHeader: string,
  ): Promise<{ idempotent?: boolean; ignored?: boolean }> {
    if (!env.STRIPE_WEBHOOK_SECRET) {
      const err = new Error('STRIPE_WEBHOOK_SECRET is not configured') as Error & { code?: string }
      err.code = 'payments_not_configured'
      throw err
    }

    const stripe = getStripe()
    const event = stripe.webhooks.constructEvent(
      rawBody,
      signatureHeader,
      env.STRIPE_WEBHOOK_SECRET,
    ) as Stripe.Event

    const prismaAny = this.prisma as unknown as Record<string, any>

    return this.prisma.$transaction(async () => {
      // --- Idempotency check ---
      // Try to find a row already stamped with this event id.
      const existing = await prismaAny['formPayment'].findUnique({
        where: { stripeEventId: event.id },
        select: { id: true },
      })
      if (existing) {
        return { idempotent: true }
      }

      // --- Event dispatch ---
      switch (event.type) {
        case 'payment_intent.succeeded': {
          const intent = event.data.object as Stripe.PaymentIntent
          await prismaAny['formPayment'].updateMany({
            where: { stripePaymentIntentId: intent.id, stripeEventId: null },
            data: {
              status: 'succeeded',
              capturedAt: new Date(intent.created * 1000),
              stripeEventId: event.id,
            },
          })
          break
        }

        case 'payment_intent.payment_failed': {
          const intent = event.data.object as Stripe.PaymentIntent
          await prismaAny['formPayment'].updateMany({
            where: { stripePaymentIntentId: intent.id, stripeEventId: null },
            data: {
              status: 'failed',
              stripeEventId: event.id,
            },
          })
          break
        }

        case 'charge.refunded': {
          const charge = event.data.object as Stripe.Charge
          const intentId = typeof charge.payment_intent === 'string'
            ? charge.payment_intent
            : charge.payment_intent?.id ?? null

          if (intentId) {
            await prismaAny['formPayment'].updateMany({
              where: { stripePaymentIntentId: intentId, stripeEventId: null },
              data: {
                status: 'refunded',
                stripeEventId: event.id,
              },
            })
          }
          break
        }

        default: {
          // Log and ignore unhandled event types per spec.
          console.log(`[payment.service] Unhandled Stripe event type: ${event.type} (id: ${event.id})`)
          return { ignored: true }
        }
      }

      return {}
    })
  }
}
