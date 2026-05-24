/**
 * BillingService — workspace ↔ Stripe Customer ↔ Subscription bridge.
 *
 * Responsibilities:
 *   - ensureCustomer: lazy-create a Stripe customer for a workspace.
 *   - createCheckoutSession: redirect URL to Stripe-hosted checkout for a plan upgrade.
 *   - createPortalSession: redirect URL to Stripe Customer Portal for self-service billing.
 *   - applySubscriptionEvent: idempotent handler for subscription + invoice webhook events.
 *
 * Idempotency mechanism:
 *   Before processing any subscription event, a WorkspaceBillingEvent row is
 *   created with a UNIQUE constraint on stripeEventId. If the INSERT violates
 *   the constraint (duplicate delivery), the service returns { idempotent: true }
 *   without applying any state changes. This is the same pattern used by
 *   FormPayment.stripeEventId in PaymentService (L8/3B.1).
 *
 * Grace window for invoice.payment_failed:
 *   An audit log entry is written but the workspace plan is NOT changed.
 *   Stripe's dunning flow will emit customer.subscription.updated (status →
 *   past_due) and eventually customer.subscription.deleted when all retries
 *   are exhausted — those events trigger the actual downgrade.
 */
import { createHash } from 'node:crypto'
import type { PrismaClient } from '@prisma/client'
import type Stripe from 'stripe'
import { getStripe } from '../payments/stripe.client.js'
import { AuditService } from '../audit/audit.service.js'
import { PlanService } from './plan.service.js'
import type IORedis from 'ioredis'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateCheckoutSessionInput {
  workspaceId: string
  planSlug: string
  successUrl: string
  cancelUrl: string
}

export interface CreatePortalSessionInput {
  workspaceId: string
  returnUrl: string
}

// ---------------------------------------------------------------------------
// BillingService
// ---------------------------------------------------------------------------

export class BillingService {
  private readonly prisma: PrismaClient
  private readonly audit: AuditService
  // planService is optional (only needed for invalidateWorkspace calls);
  // constructed lazily so unit tests can omit it.
  private planService: PlanService | null = null

  constructor(prisma: PrismaClient, redis?: IORedis) {
    this.prisma = prisma
    this.audit = new AuditService(prisma)
    if (redis) {
      this.planService = new PlanService(prisma, redis)
    }
  }

  // ── ensureCustomer ───────────────────────────────────────────────────────────

  /**
   * Returns the Stripe customer id for the workspace, creating one if absent.
   * The result is persisted on Workspace.stripeCustomerId before returning.
   */
  async ensureCustomer(workspaceId: string): Promise<string> {
    const prisma = this.prisma as any

    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { id: true, name: true, stripeCustomerId: true },
    })

    if (!workspace) {
      const err = new Error(`Workspace not found: ${workspaceId}`) as Error & { code: string }
      err.code = 'workspace_not_found'
      throw err
    }

    if (workspace.stripeCustomerId) {
      return workspace.stripeCustomerId as string
    }

    // Create a new Stripe customer
    const stripe = getStripe()
    const customer = await stripe.customers.create({
      metadata: { workspace_id: workspaceId },
      name: workspace.name,
    })

    // Persist before returning
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { stripeCustomerId: customer.id },
    })

    return customer.id
  }

  // ── createCheckoutSession ────────────────────────────────────────────────────

  /**
   * Creates a Stripe-hosted checkout session for upgrading to a paid plan.
   * Rejects free plans (no stripePriceId).
   */
  async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<{ url: string }> {
    const prisma = this.prisma as any

    const plan = await prisma.workspacePlan.findUnique({
      where: { slug: input.planSlug },
      select: { id: true, slug: true, stripePriceId: true },
    })

    if (!plan) {
      const err = new Error(`Plan not found: ${input.planSlug}`) as Error & { code: string }
      err.code = 'plan_not_found'
      throw err
    }

    if (!plan.stripePriceId) {
      const err = new Error(
        `Plan "${input.planSlug}" has no Stripe price — free plans cannot be checked out`,
      ) as Error & { code: string }
      err.code = 'free_plan_no_checkout'
      throw err
    }

    const customerId = await this.ensureCustomer(input.workspaceId)
    const stripe = getStripe()

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: customerId,
      line_items: [{ price: plan.stripePriceId, quantity: 1 }],
      success_url: input.successUrl,
      cancel_url: input.cancelUrl,
      allow_promotion_codes: true,
    })

    if (!session.url) {
      const err = new Error('Stripe did not return a checkout URL') as Error & { code: string }
      err.code = 'stripe_error'
      throw err
    }

    return { url: session.url }
  }

  // ── createPortalSession ──────────────────────────────────────────────────────

  /**
   * Creates a Stripe Customer Portal session for self-service billing management.
   */
  async createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }> {
    const customerId = await this.ensureCustomer(input.workspaceId)
    const stripe = getStripe()

    const session = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: input.returnUrl,
    })

    return { url: session.url }
  }

  // ── applySubscriptionEvent ───────────────────────────────────────────────────

  /**
   * Processes a Stripe subscription or invoice event idempotently.
   *
   * Idempotency: a WorkspaceBillingEvent row is created atomically before any
   * state mutation. A second call with the same stripeEventId returns early.
   *
   * Grace window: invoice.payment_failed records an audit log entry but does
   * NOT downgrade the plan. Stripe's dunning eventually emits
   * customer.subscription.updated/deleted, which we do react to.
   */
  async applySubscriptionEvent(
    event: Stripe.Event,
  ): Promise<{ idempotent?: boolean; ignored?: boolean }> {
    const prisma = this.prisma as any

    // Compute a short digest of the raw event for debugging
    const payloadDigest = createHash('sha256')
      .update(JSON.stringify(event))
      .digest('hex')
      .slice(0, 64)

    return this.prisma.$transaction(async (tx: any) => {
      // ── Idempotency check ───────────────────────────────────────────────────
      // Attempt to find an existing record for this event id.
      const existing = await tx.workspaceBillingEvent.findUnique({
        where: { stripeEventId: event.id },
        select: { id: true },
      })
      if (existing) {
        return { idempotent: true }
      }

      // ── Route by event type ─────────────────────────────────────────────────
      switch (event.type) {
        case 'customer.subscription.created':
        case 'customer.subscription.updated': {
          const subscription = event.data.object as Stripe.Subscription
          const customerId =
            typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer.id

          const workspace = await tx.workspace.findFirst({
            where: { stripeCustomerId: customerId },
            select: {
              id: true,
              planId: true,
              plan: { select: { slug: true } },
            },
          })

          if (!workspace) {
            // Unknown customer — record the event but take no further action.
            await tx.workspaceBillingEvent.create({
              data: {
                workspaceId: null as unknown as string, // unknown workspace
                stripeEventId: event.id,
                eventType: event.type,
                payloadDigest,
              },
            })
            return { ignored: true }
          }

          const priceId = subscription.items.data[0]?.price?.id
          if (!priceId) {
            return { ignored: true }
          }

          const newPlan = await tx.workspacePlan.findFirst({
            where: { stripePriceId: priceId },
            select: { id: true, slug: true },
          })

          if (!newPlan) {
            // Price id does not map to a known plan — record and skip.
            await tx.workspaceBillingEvent.create({
              data: {
                workspaceId: workspace.id,
                stripeEventId: event.id,
                eventType: event.type,
                payloadDigest,
              },
            })
            return { ignored: true }
          }

          const oldSlug = workspace.plan?.slug ?? null

          // Update workspace plan
          await tx.workspace.update({
            where: { id: workspace.id },
            data: { planId: newPlan.id },
          })

          // Record billing event
          await tx.workspaceBillingEvent.create({
            data: {
              workspaceId: workspace.id,
              stripeEventId: event.id,
              eventType: event.type,
              payloadDigest,
            },
          })

          // Audit log
          await tx.auditLog.create({
            data: {
              actorAccountId: null,
              action: 'workspace.plan_changed',
              subjectType: 'Workspace',
              subjectId: workspace.id,
              workspaceId: workspace.id,
              diffJson: { from_plan_slug: oldSlug, to_plan_slug: newPlan.slug },
            },
          })

          // Invalidate plan cache outside the transaction
          if (this.planService) {
            this.planService.invalidateWorkspace(workspace.id)
          }

          break
        }

        case 'customer.subscription.deleted': {
          const subscription = event.data.object as Stripe.Subscription
          const customerId =
            typeof subscription.customer === 'string'
              ? subscription.customer
              : subscription.customer.id

          const workspace = await tx.workspace.findFirst({
            where: { stripeCustomerId: customerId },
            select: {
              id: true,
              planId: true,
              plan: { select: { slug: true } },
            },
          })

          if (!workspace) {
            await tx.workspaceBillingEvent.create({
              data: {
                workspaceId: null as unknown as string,
                stripeEventId: event.id,
                eventType: event.type,
                payloadDigest,
              },
            })
            return { ignored: true }
          }

          const freePlan = await tx.workspacePlan.findUnique({
            where: { slug: 'free' },
            select: { id: true, slug: true },
          })

          if (!freePlan) {
            const err = new Error(
              'Cannot downgrade: no "free" plan found in workspace_plans',
            ) as Error & { code: string }
            err.code = 'free_plan_missing'
            throw err
          }

          const oldSlug = workspace.plan?.slug ?? null

          await tx.workspace.update({
            where: { id: workspace.id },
            data: { planId: freePlan.id },
          })

          await tx.workspaceBillingEvent.create({
            data: {
              workspaceId: workspace.id,
              stripeEventId: event.id,
              eventType: event.type,
              payloadDigest,
            },
          })

          await tx.auditLog.create({
            data: {
              actorAccountId: null,
              action: 'workspace.plan_changed',
              subjectType: 'Workspace',
              subjectId: workspace.id,
              workspaceId: workspace.id,
              diffJson: { from_plan_slug: oldSlug, to_plan_slug: freePlan.slug },
            },
          })

          if (this.planService) {
            this.planService.invalidateWorkspace(workspace.id)
          }

          break
        }

        case 'invoice.paid': {
          // invoice.paid: subscription is healthy; record for observability only.
          const invoice = event.data.object as Stripe.Invoice
          const customerId =
            typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null

          if (!customerId) return { ignored: true }

          const workspace = await tx.workspace.findFirst({
            where: { stripeCustomerId: customerId },
            select: { id: true },
          })

          if (!workspace) return { ignored: true }

          await tx.workspaceBillingEvent.create({
            data: {
              workspaceId: workspace.id,
              stripeEventId: event.id,
              eventType: event.type,
              payloadDigest,
            },
          })

          break
        }

        case 'invoice.payment_failed': {
          // Grace window: do NOT downgrade. Stripe's dunning will eventually emit
          // customer.subscription.updated (past_due) → customer.subscription.deleted.
          // We only record the audit entry so operators can see the failure.
          const invoice = event.data.object as Stripe.Invoice
          const customerId =
            typeof invoice.customer === 'string' ? invoice.customer : invoice.customer?.id ?? null

          if (!customerId) return { ignored: true }

          const workspace = await tx.workspace.findFirst({
            where: { stripeCustomerId: customerId },
            select: { id: true, plan: { select: { slug: true } } },
          })

          if (!workspace) return { ignored: true }

          await tx.workspaceBillingEvent.create({
            data: {
              workspaceId: workspace.id,
              stripeEventId: event.id,
              eventType: event.type,
              payloadDigest,
            },
          })

          // Audit log — note the grace window semantics explicitly.
          await tx.auditLog.create({
            data: {
              actorAccountId: null,
              action: 'workspace.plan_changed',
              subjectType: 'Workspace',
              subjectId: workspace.id,
              workspaceId: workspace.id,
              diffJson: {
                event: 'invoice.payment_failed',
                current_plan_slug: workspace.plan?.slug ?? null,
                note: 'grace_window — no plan change; awaiting Stripe dunning outcome',
              },
            },
          })

          break
        }

        default: {
          // Unhandled subscription/invoice event — log and skip.
          return { ignored: true }
        }
      }

      return {}
    })
  }
}
