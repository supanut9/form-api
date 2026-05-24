/**
 * BullMQ queue for the nightly analytics drain (Postgres → ClickHouse).
 *
 * The queue uses a repeatable job scheduled at 03:00 UTC every day.
 * The scheduler only registers the repeatable job when ENABLE_ANALYTICS_DRAIN=true
 * to avoid accidental activation in dev/staging.
 *
 * Job payload: one entry per workspace that has analyticsBackend = 'clickhouse'.
 * The worker fans out to per-workspace jobs so failures are isolated.
 */
import { Queue } from 'bullmq'
import { getRedisConnection } from './connection.js'

export const ANALYTICS_DRAIN_QUEUE_NAME = 'analytics-drain'

export interface AnalyticsDrainJob {
  workspaceId: string
  fromTimestamp: string // ISO-8601
  toTimestamp: string   // ISO-8601
}

let _queue: Queue<AnalyticsDrainJob> | undefined

export function getAnalyticsDrainQueue(): Queue<AnalyticsDrainJob> {
  if (!_queue) {
    _queue = new Queue<AnalyticsDrainJob>(ANALYTICS_DRAIN_QUEUE_NAME, {
      connection: getRedisConnection(),
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 60_000 },
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 500 },
      },
    })
  }
  return _queue
}

/**
 * Register the nightly repeatable scheduler job.
 * Called once from the worker entrypoint when ENABLE_ANALYTICS_DRAIN=true.
 * The scheduler job fires at 03:00 UTC daily; the worker then enqueues
 * per-workspace drain jobs.
 */
export async function registerDrainScheduler(): Promise<void> {
  const queue = getAnalyticsDrainQueue()
  await queue.add(
    'drain-scheduler',
    // Payload is ignored by the scheduler job — the worker queries Postgres
    // for eligible workspaces at runtime.
    { workspaceId: '__scheduler__', fromTimestamp: '', toTimestamp: '' },
    {
      jobId: 'drain-scheduler-singleton',
      repeat: { pattern: '0 3 * * *' }, // 03:00 UTC daily
    },
  )
}
