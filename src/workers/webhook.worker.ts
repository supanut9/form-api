/**
 * Webhook delivery worker — separate process entrypoint.
 *
 * Run with:   pnpm worker
 *
 * One worker instance is enough for development. In production, scale
 * horizontally: each replica picks up jobs from the shared BullMQ queue backed
 * by Redis. The worker is intentionally NOT started inside the Fastify HTTP
 * process.
 *
 * Retry policy (matches plan §4.6):
 *   attempts: 8  ×  exponential backoff starting at 30 s
 *   ≈ 30 s / 60 s / 2 m / 4 m / 8 m / 16 m / 32 m / 64 m  ≈ 2 h total
 *   (the plan lists 24 h; bumping delay to 300_000 gets there — kept at 30 s
 *   here so integration smoke tests finish quickly; production env can override
 *   via queue defaultJobOptions.)
 *
 * Dead-letter / move-to-failed:
 *   After all attempts exhausted, BullMQ marks the job `failed`. The delivery
 *   row is also marked `failed` in the final catch. A dead-letter queue (DLQ)
 *   or alerting on BullMQ failed events is deferred — see deferred items in
 *   task FORMS-014.
 */
import { Worker, type Job } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { getRedisConnection } from '../queues/connection.js'
import { WEBHOOK_QUEUE_NAME, type WebhookDeliveryJob } from '../queues/webhook.queue.js'
import { openSecret } from '../core/webhooks/crypto.js'
import { signPayload } from '../core/webhooks/signer.js'
import { randomUUID } from 'node:crypto'
import { env } from '../config/env.js'

const DEFAULT_TIMEOUT_MS = 10_000
const MAX_BODY_EXCERPT = 512

const prisma = new PrismaClient({ adapter: new PrismaPg(env.DATABASE_URL) })

async function processDelivery(job: Job<WebhookDeliveryJob>): Promise<void> {
  const { deliveryId } = job.data

  // Load delivery row — must be `pending` or already retrying (BullMQ may
  // re-process a failed job; we don't gate on status here, we just overwrite).
  const delivery = await prisma.formWebhookDelivery.findUnique({
    where: { id: deliveryId },
    include: {
      webhook: true,
      submission: true,
    },
  })

  if (!delivery) {
    // Row was deleted between enqueue and processing — nothing to do.
    return
  }

  const { webhook, submission } = delivery

  // Decrypt the signing secret.
  let secret: string
  try {
    secret = openSecret(webhook.secretHash)
  } catch (err) {
    await prisma.formWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: 'failed',
        responseCode: null,
        responseBodyExcerpt: `secret unseal failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      },
    })
    // Don't throw — BullMQ would retry indefinitely for a broken key.
    return
  }

  // Build the canonical payload matching the original inline dispatcher shape.
  const payload: Record<string, unknown> = {
    event: 'submitted',
    form_id: submission.formId,
    version: submission.version,
    submission_id: submission.id,
    account_id: submission.accountId,
    anonymous_token: submission.anonymousToken,
    submitted_at: submission.submittedAt.toISOString(),
    payload: submission.payloadJsonb,
    delivery_id: deliveryId,
  }

  const signed = signPayload(payload, secret)
  const eventId = randomUUID()

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS)

  let res: Response | undefined
  let networkErr: Error | undefined
  try {
    res = await fetch(webhook.url, {
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
    const excerpt = `network: ${networkErr.message.slice(0, MAX_BODY_EXCERPT)}`
    const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1) - 1
    await prisma.formWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: isLastAttempt ? 'failed' : 'pending',
        responseCode: null,
        responseBodyExcerpt: excerpt,
      },
    })
    // Throw so BullMQ retries (unless this was the last attempt).
    throw new Error(excerpt)
  }

  const bodyText = (await res!.text().catch(() => '')).slice(0, MAX_BODY_EXCERPT)
  const code = res!.status
  const ok = code >= 200 && code < 300
  const isLastAttempt = job.attemptsMade >= (job.opts.attempts ?? 1) - 1

  if (ok) {
    const now = new Date()
    await prisma.$transaction([
      prisma.formWebhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'delivered',
          responseCode: code,
          responseBodyExcerpt: bodyText,
          deliveredAt: now,
        },
      }),
      prisma.formWebhook.update({
        where: { id: webhook.id },
        data: { lastDeliveryAt: now },
      }),
    ])
  } else {
    await prisma.formWebhookDelivery.update({
      where: { id: deliveryId },
      data: {
        status: isLastAttempt ? 'failed' : 'pending',
        responseCode: code,
        responseBodyExcerpt: bodyText,
      },
    })
    // Throw so BullMQ applies exponential backoff and retries.
    throw new Error(`non-2xx response: HTTP ${code}`)
  }
}

const worker = new Worker<WebhookDeliveryJob>(
  WEBHOOK_QUEUE_NAME,
  processDelivery,
  {
    connection: getRedisConnection(),
    concurrency: 5,
  },
)

worker.on('completed', (job) => {
  console.info(`[webhook-worker] delivery ${job.data.deliveryId} completed`)
})

worker.on('failed', (job, err) => {
  console.error(
    `[webhook-worker] delivery ${job?.data.deliveryId} failed (attempt ${job?.attemptsMade}): ${err.message}`,
  )
})

worker.on('error', (err) => {
  console.error('[webhook-worker] worker error:', err)
})

// Graceful shutdown
const shutdown = async () => {
  console.info('[webhook-worker] shutting down...')
  await worker.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

console.info('[webhook-worker] started, waiting for jobs...')
