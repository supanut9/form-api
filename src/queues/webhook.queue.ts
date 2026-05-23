/**
 * BullMQ queue for webhook deliveries.
 *
 * Job data is intentionally minimal — the worker re-reads the full delivery
 * row, webhook config, and submission from Postgres so the queue stays small
 * and the worker always works from the authoritative DB state.
 */
import { Queue } from 'bullmq'
import { getRedisConnection } from './connection.js'

export const WEBHOOK_QUEUE_NAME = 'webhook-deliveries'

export interface WebhookDeliveryJob {
  deliveryId: string
  webhookId: string
  submissionId: string
  attempt: number
}

let _queue: Queue<WebhookDeliveryJob> | undefined

export function getWebhookQueue(): Queue<WebhookDeliveryJob> {
  if (!_queue) {
    _queue = new Queue<WebhookDeliveryJob>(WEBHOOK_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 8,
        backoff: {
          type: 'exponential',
          delay: 30_000,
        },
        removeOnComplete: { count: 1000 },
        removeOnFail: { count: 5000 },
      },
    })
  }
  return _queue
}

export async function enqueueWebhookDelivery(
  jobData: WebhookDeliveryJob,
): Promise<void> {
  const queue = getWebhookQueue()
  await queue.add(`delivery:${jobData.deliveryId}`, jobData, {
    jobId: jobData.deliveryId, // idempotent — duplicate enqueues are silently ignored
  })
}
