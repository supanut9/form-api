/**
 * Webhook CRUD + delivery service.
 *
 * Phase 1 delivery model:
 *  - Deliveries are dispatched in-process via setImmediate after the submit
 *    request returns (no BullMQ worker required — simpler local dev).
 *  - Each enqueued attempt creates a FormWebhookDelivery row. The dispatcher
 *    writes attempt outcome + response code/body excerpt.
 *  - On non-2xx or network error, status moves to `failed` and the operator
 *    can manually replay from the admin UI / API.
 *  - Future: swap in BullMQ with exponential backoff (the schema already
 *    supports it).
 */
import type { PrismaClient } from '@prisma/client'
import { randomBytes, randomUUID } from 'node:crypto'
import { canonicalJson, signPayload } from './signer.js'
import { openSecret, sealSecret } from './crypto.js'

export type WebhookEventName = 'submitted' | 'failed'

export interface CreateWebhookInput {
  formId: string
  url: string
  events?: WebhookEventName[]
  active?: boolean
}

export interface CreateWebhookResult {
  id: string
  formId: string
  url: string
  events: string[]
  active: boolean
  /** Raw secret — returned ONCE on creation, never persisted in plaintext. */
  secret: string
}

const DEFAULT_TIMEOUT_MS = 10_000

export class WebhookService {
  constructor(private readonly prisma: PrismaClient) {}

  async createWebhook(input: CreateWebhookInput): Promise<CreateWebhookResult> {
    // Validate URL early — refuse anything that's not http(s).
    try {
      const u = new URL(input.url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('webhook URL must be http(s)')
      }
    } catch {
      const err = new Error('invalid webhook URL') as Error & { code?: string }
      err.code = 'invalid_url'
      throw err
    }

    const secret = `whs_${randomBytes(24).toString('base64url')}`
    const envelope = sealSecret(secret)
    const row = await this.prisma.formWebhook.create({
      data: {
        formId: input.formId,
        url: input.url,
        secretHash: envelope,
        events: input.events ?? ['submitted'],
        active: input.active ?? true,
      },
    })
    return {
      id: row.id,
      formId: row.formId,
      url: row.url,
      events: row.events,
      active: row.active,
      secret,
    }
  }

  async listWebhooks(formId?: string) {
    return this.prisma.formWebhook.findMany({
      where: formId ? { formId } : {},
      orderBy: { createdAt: 'desc' },
    })
  }

  async getWebhook(id: string) {
    return this.prisma.formWebhook.findUnique({ where: { id } })
  }

  async updateWebhook(
    id: string,
    patch: { url?: string; events?: string[]; active?: boolean },
  ) {
    if (patch.url) {
      const u = new URL(patch.url)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        throw new Error('webhook URL must be http(s)')
      }
    }
    return this.prisma.formWebhook.update({ where: { id }, data: patch })
  }

  async deleteWebhook(id: string) {
    return this.prisma.formWebhook.delete({ where: { id } })
  }

  /** Returns the raw secret (decrypts the stored envelope). */
  async revealSecret(id: string): Promise<string | null> {
    const row = await this.prisma.formWebhook.findUnique({
      where: { id },
      select: { secretHash: true },
    })
    if (!row) return null
    return openSecret(row.secretHash)
  }

  async rotateSecret(id: string): Promise<{ secret: string }> {
    const newSecret = `whs_${randomBytes(24).toString('base64url')}`
    await this.prisma.formWebhook.update({
      where: { id },
      data: { secretHash: sealSecret(newSecret) },
    })
    return { secret: newSecret }
  }

  /**
   * Enqueue (in-process) a delivery for each active webhook bound to this form
   * that subscribes to "submitted". Returns the list of created delivery row
   * ids so callers can correlate logs.
   */
  async enqueueOnSubmit(input: {
    formId: string
    submissionId: string
    payload: Record<string, unknown>
  }): Promise<string[]> {
    const hooks = await this.prisma.formWebhook.findMany({
      where: { formId: input.formId, active: true },
    })
    const eligible = hooks.filter((h) => h.events.includes('submitted'))
    if (eligible.length === 0) return []

    const ids: string[] = []
    for (const hook of eligible) {
      const delivery = await this.prisma.formWebhookDelivery.create({
        data: {
          webhookId: hook.id,
          submissionId: input.submissionId,
          attempt: 1,
          status: 'pending',
          scheduledAt: new Date(),
        },
        select: { id: true },
      })
      ids.push(delivery.id)
      // Dispatch off the event loop tick so we don't block the submit response.
      setImmediate(() => {
        void this.dispatch(delivery.id, hook.url, hook.secretHash, {
          ...input.payload,
          delivery_id: delivery.id,
        }).catch(() => {
          // Errors are logged inside dispatch; this catch is defensive.
        })
      })
    }
    return ids
  }

  /**
   * Send a delivery synchronously. Used by enqueueOnSubmit and replayDelivery.
   * The payload should already include any envelope fields the caller wants
   * (submission_id, event, etc.). `delivery_id` is appended for replay tracing.
   */
  async dispatch(
    deliveryId: string,
    url: string,
    secretEnvelope: string,
    payload: Record<string, unknown>,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  ): Promise<void> {
    let secret: string
    try {
      secret = openSecret(secretEnvelope)
    } catch (err) {
      await this.recordOutcome(deliveryId, {
        status: 'failed',
        responseCode: null,
        responseBodyExcerpt: `secret unseal failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      })
      return
    }

    const signed = signPayload(payload, secret)
    const eventId = (payload['event_id'] as string | undefined) ?? randomUUID()

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    let res: Response | undefined
    let networkErr: Error | undefined
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-form-signature': signed.header,
          'x-form-event-id': eventId,
          'x-form-delivery-id': deliveryId,
          'user-agent': 'form-api/0.0.1',
        },
        body: signed.body,
        signal: controller.signal,
      })
    } catch (err) {
      networkErr = err as Error
    } finally {
      clearTimeout(timer)
    }

    if (networkErr) {
      await this.recordOutcome(deliveryId, {
        status: 'failed',
        responseCode: null,
        responseBodyExcerpt: `network: ${networkErr.message.slice(0, 512)}`,
      })
      return
    }

    const body = (await res!.text().catch(() => '')).slice(0, 512)
    const code = res!.status
    const ok = code >= 200 && code < 300

    await this.recordOutcome(deliveryId, {
      status: ok ? 'delivered' : 'failed',
      responseCode: code,
      responseBodyExcerpt: body,
    })

    if (ok) {
      // Touch lastDeliveryAt on the webhook for the admin UI.
      const delivery = await this.prisma.formWebhookDelivery.findUnique({
        where: { id: deliveryId },
        select: { webhookId: true },
      })
      if (delivery) {
        await this.prisma.formWebhook.update({
          where: { id: delivery.webhookId },
          data: { lastDeliveryAt: new Date() },
        })
      }
    }
  }

  private async recordOutcome(
    deliveryId: string,
    outcome: {
      status: 'delivered' | 'failed'
      responseCode: number | null
      responseBodyExcerpt: string | null
    },
  ): Promise<void> {
    await this.prisma.formWebhookDelivery.update({
      where: { id: deliveryId },
      data: outcome,
    })
  }

  /**
   * Re-dispatch a previously-attempted delivery. Creates a *new*
   * FormWebhookDelivery row (incrementing attempt counter) rather than
   * mutating the old one.
   */
  async replayDelivery(deliveryId: string): Promise<{ newDeliveryId: string }> {
    const original = await this.prisma.formWebhookDelivery.findUnique({
      where: { id: deliveryId },
      include: { webhook: true, submission: true },
    })
    if (!original) {
      throw new Error('Delivery not found')
    }
    const nextAttempt = original.attempt + 1
    const next = await this.prisma.formWebhookDelivery.create({
      data: {
        webhookId: original.webhookId,
        submissionId: original.submissionId,
        attempt: nextAttempt,
        status: 'pending',
        scheduledAt: new Date(),
      },
      select: { id: true },
    })

    setImmediate(() => {
      void this.dispatch(next.id, original.webhook.url, original.webhook.secretHash, {
        event: 'submitted',
        replay_of: deliveryId,
        attempt: nextAttempt,
        form_id: original.submission.formId,
        version: original.submission.version,
        submission_id: original.submission.id,
        account_id: original.submission.accountId,
        anonymous_token: original.submission.anonymousToken,
        submitted_at: original.submission.submittedAt.toISOString(),
        payload: original.submission.payloadJsonb,
      }).catch(() => {})
    })

    return { newDeliveryId: next.id }
  }

  async listDeliveries(input: {
    webhookId?: string
    submissionId?: string
    limit?: number
    offset?: number
  }) {
    const where: { webhookId?: string; submissionId?: string } = {}
    if (input.webhookId) where.webhookId = input.webhookId
    if (input.submissionId) where.submissionId = input.submissionId
    const [total, rows] = await Promise.all([
      this.prisma.formWebhookDelivery.count({ where }),
      this.prisma.formWebhookDelivery.findMany({
        where,
        orderBy: { scheduledAt: 'desc' },
        take: input.limit ?? 50,
        skip: input.offset ?? 0,
      }),
    ])
    return { total, rows }
  }

  // Pure-helper exposed for parity tests against integration receivers.
  static canonicalize(value: unknown): string {
    return canonicalJson(value)
  }
}
