/**
 * Unit tests for BillingService.
 *
 * Stripe SDK is mocked via vi.hoisted + vi.mock — same pattern as
 * test/unit/payments/payment.service.test.ts. No real HTTP calls are made.
 * The Prisma client is mocked with a plain object.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock factories
// ---------------------------------------------------------------------------

const mockCustomersCreate = vi.hoisted(() => vi.fn())
const mockCheckoutSessionsCreate = vi.hoisted(() => vi.fn())
const mockBillingPortalSessionsCreate = vi.hoisted(() => vi.fn())

vi.mock('stripe', () => {
  function MockStripe(this: any) {
    this.customers = {
      create: mockCustomersCreate,
    }
    this.checkout = {
      sessions: {
        create: mockCheckoutSessionsCreate,
      },
    }
    this.billingPortal = {
      sessions: {
        create: mockBillingPortalSessionsCreate,
      },
    }
    this.webhooks = {
      constructEvent: vi.fn(),
    }
  }
  return { default: MockStripe }
})

vi.mock('../../../src/config/env.js', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_mock',
    STRIPE_WEBHOOK_SECRET: 'whsec_mock',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
    NODE_ENV: 'test',
  },
}))

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import { BillingService } from '../../../src/core/workspaces/billing.service.js'
import { _resetStripeForTests } from '../../../src/core/payments/stripe.client.js'
import type { PrismaClient } from '@prisma/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockPrisma() {
  const workspace = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
  }
  const workspacePlan = {
    findUnique: vi.fn(),
    findFirst: vi.fn(),
  }
  const workspaceBillingEvent = {
    findUnique: vi.fn(),
    create: vi.fn(),
  }
  const auditLog = {
    create: vi.fn(),
  }

  const prisma = {
    workspace,
    workspacePlan,
    workspaceBillingEvent,
    auditLog,
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
      fn({
        workspace,
        workspacePlan,
        workspaceBillingEvent,
        auditLog,
      }),
    ),
  } as unknown as PrismaClient

  return { prisma, workspace, workspacePlan, workspaceBillingEvent, auditLog }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('BillingService', () => {
  let mocks: ReturnType<typeof buildMockPrisma>
  let service: BillingService

  beforeEach(() => {
    vi.clearAllMocks()
    _resetStripeForTests()
    mocks = buildMockPrisma()
    service = new BillingService(mocks.prisma)
  })

  // ── ensureCustomer ──────────────────────────────────────────────────────────

  describe('ensureCustomer', () => {
    it('creates a new Stripe customer when workspace has none, persists and returns id', async () => {
      mocks.workspace.findUnique.mockResolvedValue({
        id: 'ws_1',
        name: 'Acme Corp',
        stripeCustomerId: null,
      })
      mockCustomersCreate.mockResolvedValue({ id: 'cus_new_001' })
      mocks.workspace.update.mockResolvedValue({})

      const result = await service.ensureCustomer('ws_1')

      expect(mockCustomersCreate).toHaveBeenCalledWith({
        metadata: { workspace_id: 'ws_1' },
        name: 'Acme Corp',
      })
      expect(mocks.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ws_1' },
          data: { stripeCustomerId: 'cus_new_001' },
        }),
      )
      expect(result).toBe('cus_new_001')
    })

    it('returns existing stripeCustomerId without calling Stripe', async () => {
      mocks.workspace.findUnique.mockResolvedValue({
        id: 'ws_2',
        name: 'Existing Corp',
        stripeCustomerId: 'cus_existing_999',
      })

      const result = await service.ensureCustomer('ws_2')

      expect(mockCustomersCreate).not.toHaveBeenCalled()
      expect(mocks.workspace.update).not.toHaveBeenCalled()
      expect(result).toBe('cus_existing_999')
    })

    it('throws workspace_not_found when workspace does not exist', async () => {
      mocks.workspace.findUnique.mockResolvedValue(null)

      await expect(service.ensureCustomer('ws_missing')).rejects.toMatchObject({
        code: 'workspace_not_found',
      })
    })
  })

  // ── createCheckoutSession ───────────────────────────────────────────────────

  describe('createCheckoutSession', () => {
    beforeEach(() => {
      // ensureCustomer succeeds with existing customer
      mocks.workspace.findUnique.mockResolvedValue({
        id: 'ws_3',
        name: 'Pro Corp',
        stripeCustomerId: 'cus_pro_001',
      })
    })

    it('rejects free plan (stripePriceId is null) with free_plan_no_checkout', async () => {
      mocks.workspacePlan.findUnique.mockResolvedValue({
        id: 'plan_free',
        slug: 'free',
        stripePriceId: null,
      })

      await expect(
        service.createCheckoutSession({
          workspaceId: 'ws_3',
          planSlug: 'free',
          successUrl: 'https://app.example.com/success',
          cancelUrl: 'https://app.example.com/cancel',
        }),
      ).rejects.toMatchObject({ code: 'free_plan_no_checkout' })

      expect(mockCheckoutSessionsCreate).not.toHaveBeenCalled()
    })

    it('returns checkout URL for a paid plan', async () => {
      mocks.workspacePlan.findUnique.mockResolvedValue({
        id: 'plan_pro',
        slug: 'pro',
        stripePriceId: 'price_pro_monthly',
      })
      mockCheckoutSessionsCreate.mockResolvedValue({
        id: 'cs_001',
        url: 'https://checkout.stripe.com/pay/cs_001',
      })

      const result = await service.createCheckoutSession({
        workspaceId: 'ws_3',
        planSlug: 'pro',
        successUrl: 'https://app.example.com/success',
        cancelUrl: 'https://app.example.com/cancel',
      })

      expect(mockCheckoutSessionsCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          mode: 'subscription',
          customer: 'cus_pro_001',
          line_items: [{ price: 'price_pro_monthly', quantity: 1 }],
          allow_promotion_codes: true,
          success_url: 'https://app.example.com/success',
          cancel_url: 'https://app.example.com/cancel',
        }),
      )
      expect(result).toEqual({ url: 'https://checkout.stripe.com/pay/cs_001' })
    })

    it('throws plan_not_found when plan slug does not exist', async () => {
      mocks.workspacePlan.findUnique.mockResolvedValue(null)

      await expect(
        service.createCheckoutSession({
          workspaceId: 'ws_3',
          planSlug: 'nonexistent',
          successUrl: 'https://app.example.com/success',
          cancelUrl: 'https://app.example.com/cancel',
        }),
      ).rejects.toMatchObject({ code: 'plan_not_found' })
    })
  })

  // ── createPortalSession ─────────────────────────────────────────────────────

  describe('createPortalSession', () => {
    it('returns portal URL for an existing customer', async () => {
      mocks.workspace.findUnique.mockResolvedValue({
        id: 'ws_4',
        name: 'Portal Corp',
        stripeCustomerId: 'cus_portal_001',
      })
      mockBillingPortalSessionsCreate.mockResolvedValue({
        url: 'https://billing.stripe.com/session/bps_001',
      })

      const result = await service.createPortalSession({
        workspaceId: 'ws_4',
        returnUrl: 'https://app.example.com/settings/billing',
      })

      expect(mockBillingPortalSessionsCreate).toHaveBeenCalledWith({
        customer: 'cus_portal_001',
        return_url: 'https://app.example.com/settings/billing',
      })
      expect(result).toEqual({ url: 'https://billing.stripe.com/session/bps_001' })
    })
  })

  // ── applySubscriptionEvent ─────────────────────────────────────────────────

  describe('applySubscriptionEvent', () => {
    // Common subscription event structure
    function makeSubEvent(type: string, id: string, data: object) {
      return { id, type, data: { object: data } } as any
    }

    const baseWorkspace = {
      id: 'ws_5',
      planId: 'plan_free_id',
      plan: { slug: 'free' },
    }

    // ── subscription.updated → flips planId ──────────────────────────────────

    it('flips planId on customer.subscription.updated', async () => {
      const event = makeSubEvent('customer.subscription.updated', 'evt_sub_001', {
        id: 'sub_001',
        customer: 'cus_001',
        items: {
          data: [{ price: { id: 'price_pro_monthly' } }],
        },
      })

      mocks.workspaceBillingEvent.findUnique.mockResolvedValue(null) // not idempotent
      mocks.workspace.findFirst.mockResolvedValue({
        ...baseWorkspace,
        stripeCustomerId: 'cus_001',
      })
      mocks.workspacePlan.findFirst.mockResolvedValue({ id: 'plan_pro_id', slug: 'pro' })
      mocks.workspace.update.mockResolvedValue({})
      mocks.workspaceBillingEvent.create.mockResolvedValue({})
      mocks.auditLog.create.mockResolvedValue({})

      const result = await service.applySubscriptionEvent(event)

      expect(mocks.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'ws_5' },
          data: { planId: 'plan_pro_id' },
        }),
      )
      expect(mocks.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'workspace.plan_changed',
            diffJson: expect.objectContaining({ from_plan_slug: 'free', to_plan_slug: 'pro' }),
          }),
        }),
      )
      expect(result).not.toHaveProperty('idempotent')
      expect(result).not.toHaveProperty('ignored')
    })

    // ── subscription.deleted → downgrades to free ────────────────────────────

    it('downgrades to free plan on customer.subscription.deleted', async () => {
      const event = makeSubEvent('customer.subscription.deleted', 'evt_sub_del_001', {
        id: 'sub_001',
        customer: 'cus_001',
        items: { data: [] },
      })

      mocks.workspaceBillingEvent.findUnique.mockResolvedValue(null)
      mocks.workspace.findFirst.mockResolvedValue({
        id: 'ws_5',
        planId: 'plan_pro_id',
        plan: { slug: 'pro' },
        stripeCustomerId: 'cus_001',
      })
      mocks.workspacePlan.findUnique.mockResolvedValue({ id: 'plan_free_id', slug: 'free' })
      mocks.workspace.update.mockResolvedValue({})
      mocks.workspaceBillingEvent.create.mockResolvedValue({})
      mocks.auditLog.create.mockResolvedValue({})

      const result = await service.applySubscriptionEvent(event)

      expect(mocks.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { planId: 'plan_free_id' },
        }),
      )
      expect(mocks.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            diffJson: expect.objectContaining({ from_plan_slug: 'pro', to_plan_slug: 'free' }),
          }),
        }),
      )
      expect(result).not.toHaveProperty('idempotent')
    })

    // ── invoice.payment_failed → NO auto-downgrade ───────────────────────────

    it('does NOT auto-downgrade on invoice.payment_failed', async () => {
      const event = makeSubEvent('invoice.payment_failed', 'evt_inv_fail_001', {
        id: 'in_001',
        customer: 'cus_001',
      })

      mocks.workspaceBillingEvent.findUnique.mockResolvedValue(null)
      mocks.workspace.findFirst.mockResolvedValue({
        id: 'ws_5',
        stripeCustomerId: 'cus_001',
        plan: { slug: 'pro' },
      })
      mocks.workspaceBillingEvent.create.mockResolvedValue({})
      mocks.auditLog.create.mockResolvedValue({})

      await service.applySubscriptionEvent(event)

      // workspace.update must NOT have been called (no plan change)
      expect(mocks.workspace.update).not.toHaveBeenCalled()

      // Audit entry IS written with grace_window note
      expect(mocks.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            diffJson: expect.objectContaining({
              event: 'invoice.payment_failed',
              note: expect.stringContaining('grace_window'),
            }),
          }),
        }),
      )
    })

    // ── Idempotency ───────────────────────────────────────────────────────────

    it('returns { idempotent: true } when replaying the same event id', async () => {
      const event = makeSubEvent('customer.subscription.updated', 'evt_already_001', {
        id: 'sub_dup',
        customer: 'cus_dup',
        items: { data: [{ price: { id: 'price_pro_monthly' } }] },
      })

      // Simulate existing row — event was already processed
      mocks.workspaceBillingEvent.findUnique.mockResolvedValue({ id: 'be_existing' })

      const result = await service.applySubscriptionEvent(event)

      expect(result).toEqual({ idempotent: true })
      expect(mocks.workspace.update).not.toHaveBeenCalled()
      expect(mocks.auditLog.create).not.toHaveBeenCalled()
    })

    // ── subscription.created ──────────────────────────────────────────────────

    it('sets planId on customer.subscription.created', async () => {
      const event = makeSubEvent('customer.subscription.created', 'evt_sub_created_001', {
        id: 'sub_new',
        customer: 'cus_new',
        items: { data: [{ price: { id: 'price_starter_monthly' } }] },
      })

      mocks.workspaceBillingEvent.findUnique.mockResolvedValue(null)
      mocks.workspace.findFirst.mockResolvedValue({
        id: 'ws_6',
        planId: 'plan_free_id',
        plan: { slug: 'free' },
        stripeCustomerId: 'cus_new',
      })
      mocks.workspacePlan.findFirst.mockResolvedValue({ id: 'plan_starter_id', slug: 'starter' })
      mocks.workspace.update.mockResolvedValue({})
      mocks.workspaceBillingEvent.create.mockResolvedValue({})
      mocks.auditLog.create.mockResolvedValue({})

      const result = await service.applySubscriptionEvent(event)

      expect(mocks.workspace.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { planId: 'plan_starter_id' },
        }),
      )
      expect(result).not.toHaveProperty('idempotent')
    })
  })
})
