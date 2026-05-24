/**
 * Unit tests for PaymentService.
 *
 * The Stripe SDK is mocked via vi.hoisted + vi.mock so that no real HTTP calls
 * are made. The Prisma client is mocked with a plain object.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoist mock factories so they're available before module evaluation
// ---------------------------------------------------------------------------

const mockConstructEvent = vi.hoisted(() => vi.fn())
const mockPaymentIntentsCreate = vi.hoisted(() => vi.fn())
const mockPaymentIntentsRetrieve = vi.hoisted(() => vi.fn())

vi.mock('stripe', () => {
  // Stripe is imported as a constructor class — the mock must look like one.
  function MockStripe(this: any) {
    this.paymentIntents = {
      create: mockPaymentIntentsCreate,
      retrieve: mockPaymentIntentsRetrieve,
    }
    this.webhooks = {
      constructEvent: mockConstructEvent,
    }
  }
  // Default export is the constructor; vitest ESM interop requires both forms.
  return { default: MockStripe }
})

// ---------------------------------------------------------------------------
// Mock env so STRIPE_SECRET_KEY is always set
// ---------------------------------------------------------------------------

vi.mock('../../../src/config/env.js', () => ({
  env: {
    STRIPE_SECRET_KEY: 'sk_test_mock',
    STRIPE_WEBHOOK_SECRET: 'whsec_mock',
    STRIPE_PUBLISHABLE_KEY: 'pk_test_mock',
    NODE_ENV: 'test',
  },
}))

// ---------------------------------------------------------------------------
// Imports (after mocks are set up)
// ---------------------------------------------------------------------------

import { PaymentService } from '../../../src/core/payments/payment.service.js'
import { _resetStripeForTests } from '../../../src/core/payments/stripe.client.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildMockPrisma() {
  const formPayment = {
    upsert: vi.fn(),
    findUnique: vi.fn(),
    updateMany: vi.fn(),
    update: vi.fn(),
  }

  return {
    formPayment,
    $transaction: vi.fn(async (fn: (tx: any) => Promise<any>) =>
      fn({ formPayment }),
    ),
  } as unknown as import('@prisma/client').PrismaClient
}

function makeFixedPaymentSpec(overrides: Record<string, unknown> = {}) {
  return {
    payment: {
      mode: 'fixed',
      currency: 'usd',
      amount_minor: 1500,
      capture_intent: 'on_submit',
      stripe_account_id: 'acct_123',
      required_for_submit: true,
      ...overrides,
    },
  }
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('PaymentService', () => {
  let prisma: ReturnType<typeof buildMockPrisma>
  let service: PaymentService

  beforeEach(() => {
    vi.clearAllMocks()
    // Reset the Stripe singleton so a fresh MockStripe instance is created.
    _resetStripeForTests()
    prisma = buildMockPrisma()
    service = new PaymentService(prisma)
  })

  // -------------------------------------------------------------------------
  // createIntentForForm
  // -------------------------------------------------------------------------

  describe('createIntentForForm', () => {
    it('computes amount from spec for fixed mode', async () => {
      mockPaymentIntentsCreate.mockResolvedValue({
        id: 'pi_test_001',
        client_secret: 'pi_test_001_secret_xxx',
        amount: 1500,
        currency: 'usd',
      })

      const result = await service.createIntentForForm({
        formId: 'form_1',
        version: 1,
        spec: makeFixedPaymentSpec(),
        accountSub: 'user_sub_123',
        anonymousToken: null,
      })

      expect(mockPaymentIntentsCreate).toHaveBeenCalledOnce()
      const [createParams, requestOptions] = mockPaymentIntentsCreate.mock.calls[0]
      expect(createParams.amount).toBe(1500)
      expect(createParams.currency).toBe('usd')
      expect(createParams.automatic_payment_methods).toEqual({ enabled: true })
      expect(createParams.metadata).toMatchObject({
        formId: 'form_1',
        version: '1',
        accountSub: 'user_sub_123',
      })
      expect(requestOptions).toEqual({ stripeAccount: 'acct_123' })

      expect(result.paymentIntentId).toBe('pi_test_001')
      expect(result.clientSecret).toBe('pi_test_001_secret_xxx')
      expect(result.amountMinor).toBe(1500)
      expect(result.currency).toBe('usd')
      expect(result.publishableKey).toBe('pk_test_mock')
    })

    it('rejects calculated mode', async () => {
      await expect(
        service.createIntentForForm({
          formId: 'form_1',
          version: 1,
          spec: makeFixedPaymentSpec({ mode: 'calculated' }),
        }),
      ).rejects.toMatchObject({ code: 'unsupported_payment_mode' })

      expect(mockPaymentIntentsCreate).not.toHaveBeenCalled()
    })

    it('rejects tier mode', async () => {
      await expect(
        service.createIntentForForm({
          formId: 'form_1',
          version: 1,
          spec: makeFixedPaymentSpec({ mode: 'tier' }),
        }),
      ).rejects.toMatchObject({ code: 'unsupported_payment_mode' })
    })

    it('throws payment_not_configured when spec has no payment key', async () => {
      await expect(
        service.createIntentForForm({
          formId: 'form_1',
          version: 1,
          spec: {},
        }),
      ).rejects.toMatchObject({ code: 'payment_not_configured' })
    })

    it('passes empty request options when no stripe_account_id', async () => {
      mockPaymentIntentsCreate.mockResolvedValue({
        id: 'pi_test_002',
        client_secret: 'pi_test_002_secret_xxx',
        amount: 500,
        currency: 'eur',
      })

      await service.createIntentForForm({
        formId: 'form_2',
        version: 2,
        spec: makeFixedPaymentSpec({ stripe_account_id: undefined, currency: 'eur', amount_minor: 500 }),
      })

      const [, requestOptions] = mockPaymentIntentsCreate.mock.calls[0]
      expect(requestOptions).toEqual({})
    })
  })

  // -------------------------------------------------------------------------
  // recordPaymentForSubmission
  // -------------------------------------------------------------------------

  describe('recordPaymentForSubmission', () => {
    it('retrieves the intent and writes a FormPayment row on succeeded status', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: 'pi_test_001',
        status: 'succeeded',
        amount: 1500,
        currency: 'usd',
      })
      const prismaAny = prisma as unknown as Record<string, any>
      prismaAny['formPayment'].upsert.mockResolvedValue({ id: 'fpm_1' })

      await service.recordPaymentForSubmission({
        submissionId: 'sub_1',
        paymentIntentId: 'pi_test_001',
        stripeAccountId: 'acct_123',
      })

      expect(mockPaymentIntentsRetrieve).toHaveBeenCalledWith(
        'pi_test_001',
        {},
        { stripeAccount: 'acct_123' },
      )
      expect(prismaAny['formPayment'].upsert).toHaveBeenCalledOnce()
      const upsertCall = prismaAny['formPayment'].upsert.mock.calls[0][0]
      expect(upsertCall.create.status).toBe('succeeded')
      expect(upsertCall.create.submissionId).toBe('sub_1')
      expect(upsertCall.create.capturedAt).toBeInstanceOf(Date)
    })

    it('accepts requires_capture status (maps to pending)', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: 'pi_test_003',
        status: 'requires_capture',
        amount: 2000,
        currency: 'usd',
      })
      const prismaAny = prisma as unknown as Record<string, any>
      prismaAny['formPayment'].upsert.mockResolvedValue({ id: 'fpm_2' })

      await service.recordPaymentForSubmission({
        submissionId: 'sub_2',
        paymentIntentId: 'pi_test_003',
      })

      const upsertCall = prismaAny['formPayment'].upsert.mock.calls[0][0]
      expect(upsertCall.create.status).toBe('pending')
      expect(upsertCall.create.capturedAt).toBeNull()
    })

    it('throws intent_not_succeeded when intent status is requires_payment_method', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: 'pi_test_004',
        status: 'requires_payment_method',
        amount: 1500,
        currency: 'usd',
      })

      await expect(
        service.recordPaymentForSubmission({
          submissionId: 'sub_3',
          paymentIntentId: 'pi_test_004',
        }),
      ).rejects.toMatchObject({ code: 'intent_not_succeeded' })
    })

    it('throws intent_not_succeeded for canceled intent', async () => {
      mockPaymentIntentsRetrieve.mockResolvedValue({
        id: 'pi_test_005',
        status: 'canceled',
        amount: 1500,
        currency: 'usd',
      })

      await expect(
        service.recordPaymentForSubmission({
          submissionId: 'sub_4',
          paymentIntentId: 'pi_test_005',
        }),
      ).rejects.toMatchObject({ code: 'intent_not_succeeded' })
    })
  })

  // -------------------------------------------------------------------------
  // reconcileWebhookEvent
  // -------------------------------------------------------------------------

  describe('reconcileWebhookEvent', () => {
    function makeEvent(type: string, id: string, data: object) {
      return { id, type, data: { object: data } }
    }

    it('is idempotent: second call with same event id returns { idempotent: true }', async () => {
      const event = makeEvent('payment_intent.succeeded', 'evt_001', {
        id: 'pi_001',
        created: Math.floor(Date.now() / 1000),
      })
      mockConstructEvent.mockReturnValue(event)

      const prismaAny = prisma as unknown as Record<string, any>

      // First call: no existing row
      prismaAny['formPayment'].findUnique.mockResolvedValueOnce(null)
      prismaAny['formPayment'].updateMany.mockResolvedValueOnce({ count: 1 })

      const first = await service.reconcileWebhookEvent(Buffer.from('{}'), 'sig_xxx')
      expect(first).not.toHaveProperty('idempotent')

      // Second call: row found (event already processed)
      prismaAny['formPayment'].findUnique.mockResolvedValueOnce({ id: 'fpm_1' })

      const second = await service.reconcileWebhookEvent(Buffer.from('{}'), 'sig_xxx')
      expect(second).toEqual({ idempotent: true })

      // updateMany should only have been called once (on the first call)
      expect(prismaAny['formPayment'].updateMany).toHaveBeenCalledOnce()
    })

    it('transitions to succeeded on payment_intent.succeeded', async () => {
      const now = Math.floor(Date.now() / 1000)
      const event = makeEvent('payment_intent.succeeded', 'evt_002', {
        id: 'pi_002',
        created: now,
      })
      mockConstructEvent.mockReturnValue(event)
      const prismaAny = prisma as unknown as Record<string, any>
      prismaAny['formPayment'].findUnique.mockResolvedValue(null)
      prismaAny['formPayment'].updateMany.mockResolvedValue({ count: 1 })

      const result = await service.reconcileWebhookEvent(Buffer.from('{}'), 'sig_yyy')

      expect(result).not.toHaveProperty('ignored')
      expect(prismaAny['formPayment'].updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripePaymentIntentId: 'pi_002', stripeEventId: null },
          data: expect.objectContaining({ status: 'succeeded', stripeEventId: 'evt_002' }),
        }),
      )
    })

    it('transitions to failed on payment_intent.payment_failed', async () => {
      const event = makeEvent('payment_intent.payment_failed', 'evt_003', { id: 'pi_003' })
      mockConstructEvent.mockReturnValue(event)
      const prismaAny = prisma as unknown as Record<string, any>
      prismaAny['formPayment'].findUnique.mockResolvedValue(null)
      prismaAny['formPayment'].updateMany.mockResolvedValue({ count: 1 })

      await service.reconcileWebhookEvent(Buffer.from('{}'), 'sig_zzz')

      expect(prismaAny['formPayment'].updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'failed', stripeEventId: 'evt_003' }),
        }),
      )
    })

    it('transitions to refunded on charge.refunded', async () => {
      const event = makeEvent('charge.refunded', 'evt_004', {
        id: 'ch_001',
        payment_intent: 'pi_004',
      })
      mockConstructEvent.mockReturnValue(event)
      const prismaAny = prisma as unknown as Record<string, any>
      prismaAny['formPayment'].findUnique.mockResolvedValue(null)
      prismaAny['formPayment'].updateMany.mockResolvedValue({ count: 1 })

      await service.reconcileWebhookEvent(Buffer.from('{}'), 'sig_aaa')

      expect(prismaAny['formPayment'].updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { stripePaymentIntentId: 'pi_004', stripeEventId: null },
          data: expect.objectContaining({ status: 'refunded', stripeEventId: 'evt_004' }),
        }),
      )
    })

    it('returns { ignored: true } for unhandled event types', async () => {
      const event = makeEvent('customer.created', 'evt_005', { id: 'cus_001' })
      mockConstructEvent.mockReturnValue(event)
      const prismaAny = prisma as unknown as Record<string, any>
      prismaAny['formPayment'].findUnique.mockResolvedValue(null)

      const result = await service.reconcileWebhookEvent(Buffer.from('{}'), 'sig_bbb')

      expect(result).toEqual({ ignored: true })
      expect(prismaAny['formPayment'].updateMany).not.toHaveBeenCalled()
    })
  })
})
