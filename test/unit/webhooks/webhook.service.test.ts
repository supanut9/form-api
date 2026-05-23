/**
 * Unit tests for WebhookService.enqueueOnSubmit — verifies that a BullMQ job
 * is enqueued for each active "submitted" webhook, and that inactive or
 * non-matching webhooks are skipped.
 *
 * No real Redis or Postgres required — BullMQ queue is mocked via vi.mock.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ── Mock the queue module before importing WebhookService ────────────────────
// vi.mock is hoisted to the top of the file, so the factory must not reference
// variables declared in module scope. Use vi.hoisted() to create the mock fn
// at hoist-time so it is available both in the factory and in the test body.

const { mockEnqueue } = vi.hoisted(() => ({
  mockEnqueue: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('../../../src/queues/webhook.queue.js', () => ({
  enqueueWebhookDelivery: mockEnqueue,
}))

// ── Import after mock registration ───────────────────────────────────────────

import { WebhookService } from '../../../src/core/webhooks/webhook.service.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeWebhook(overrides: Partial<{
  id: string
  formId: string
  active: boolean
  events: string[]
}> = {}) {
  return {
    id: overrides.id ?? 'hook-1',
    formId: overrides.formId ?? 'form-1',
    url: 'https://example.com/hook',
    secretHash: 'v1:aaa:bbb:ccc',
    active: overrides.active ?? true,
    events: overrides.events ?? ['submitted'],
    lastDeliveryAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  }
}

function buildMockPrisma(hooks: ReturnType<typeof makeWebhook>[]) {
  let deliverySeq = 0

  return {
    formWebhook: {
      findMany: vi.fn().mockResolvedValue(hooks),
    },
    formWebhookDelivery: {
      create: vi.fn().mockImplementation(async () => ({
        id: `delivery-${++deliverySeq}`,
      })),
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
    },
    formWebhook_update: vi.fn(),
  } as unknown as import('@prisma/client').PrismaClient
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('WebhookService.enqueueOnSubmit', () => {
  beforeEach(() => {
    mockEnqueue.mockClear()
  })

  it('enqueues one job per active "submitted" webhook', async () => {
    const hooks = [makeWebhook({ id: 'hook-1' }), makeWebhook({ id: 'hook-2' })]
    const prisma = buildMockPrisma(hooks)
    const service = new WebhookService(prisma)

    const ids = await service.enqueueOnSubmit({
      formId: 'form-1',
      submissionId: 'sub-1',
      payload: { event: 'submitted' },
    })

    expect(ids).toHaveLength(2)
    expect(mockEnqueue).toHaveBeenCalledTimes(2)

    // Each call must carry the deliveryId, webhookId, submissionId, attempt
    const calls = mockEnqueue.mock.calls.map((c) => c[0] as {
      deliveryId: string
      webhookId: string
      submissionId: string
      attempt: number
    })

    expect(calls[0]).toMatchObject({
      webhookId: 'hook-1',
      submissionId: 'sub-1',
      attempt: 1,
    })
    expect(calls[1]).toMatchObject({
      webhookId: 'hook-2',
      submissionId: 'sub-1',
      attempt: 1,
    })
  })

  it('skips inactive webhooks', async () => {
    const hooks = [
      makeWebhook({ id: 'hook-active', active: true }),
      makeWebhook({ id: 'hook-inactive', active: false }),
    ]
    // The service queries with active:true — simulate that by returning only
    // the active hook (as the real Prisma query would).
    const prisma = buildMockPrisma([hooks[0]!])
    const service = new WebhookService(prisma)

    const ids = await service.enqueueOnSubmit({
      formId: 'form-1',
      submissionId: 'sub-2',
      payload: { event: 'submitted' },
    })

    expect(ids).toHaveLength(1)
    expect(mockEnqueue).toHaveBeenCalledTimes(1)
  })

  it('skips webhooks not subscribed to "submitted"', async () => {
    const hooks = [makeWebhook({ id: 'hook-failed-only', events: ['failed'] })]
    const prisma = buildMockPrisma(hooks)
    const service = new WebhookService(prisma)

    const ids = await service.enqueueOnSubmit({
      formId: 'form-1',
      submissionId: 'sub-3',
      payload: { event: 'submitted' },
    })

    expect(ids).toHaveLength(0)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })

  it('returns empty array when no webhooks exist for form', async () => {
    const prisma = buildMockPrisma([])
    const service = new WebhookService(prisma)

    const ids = await service.enqueueOnSubmit({
      formId: 'form-no-hooks',
      submissionId: 'sub-4',
      payload: { event: 'submitted' },
    })

    expect(ids).toHaveLength(0)
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})

describe('WebhookService.replayDelivery', () => {
  beforeEach(() => {
    mockEnqueue.mockClear()
  })

  it('creates a new delivery row with incremented attempt and enqueues a job', async () => {
    const originalDelivery = {
      id: 'del-1',
      webhookId: 'hook-1',
      submissionId: 'sub-1',
      attempt: 2,
      status: 'failed',
      scheduledAt: new Date(),
      webhook: makeWebhook({ id: 'hook-1' }),
      submission: {
        id: 'sub-1',
        formId: 'form-1',
        version: 3,
        accountId: null,
        anonymousToken: 'anon-token',
        submittedAt: new Date(),
        payloadJsonb: { name: 'Alice' },
      },
    }

    let deliverySeq = 0
    const prisma = {
      formWebhookDelivery: {
        findUnique: vi.fn().mockResolvedValue(originalDelivery),
        create: vi.fn().mockImplementation(async () => ({
          id: `delivery-replay-${++deliverySeq}`,
        })),
      },
    } as unknown as import('@prisma/client').PrismaClient

    const service = new WebhookService(prisma)
    const result = await service.replayDelivery('del-1')

    expect(result.newDeliveryId).toBe('delivery-replay-1')
    expect(mockEnqueue).toHaveBeenCalledOnce()

    const jobData = mockEnqueue.mock.calls[0]![0] as {
      deliveryId: string
      webhookId: string
      submissionId: string
      attempt: number
    }

    expect(jobData).toMatchObject({
      webhookId: 'hook-1',
      submissionId: 'sub-1',
      attempt: 3, // original.attempt (2) + 1
    })
  })

  it('throws when delivery not found', async () => {
    const prisma = {
      formWebhookDelivery: {
        findUnique: vi.fn().mockResolvedValue(null),
      },
    } as unknown as import('@prisma/client').PrismaClient

    const service = new WebhookService(prisma)

    await expect(service.replayDelivery('del-missing')).rejects.toThrow('Delivery not found')
    expect(mockEnqueue).not.toHaveBeenCalled()
  })
})
