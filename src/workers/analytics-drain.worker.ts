/**
 * Analytics drain worker — separate process entrypoint.
 *
 * Run with:  pnpm worker:analytics
 *
 * The worker is NOT started inside the Fastify HTTP process (same pattern as
 * webhook.worker.ts).  Only starts if ENABLE_ANALYTICS_DRAIN=true.
 *
 * High-level flow:
 *   1. A repeatable BullMQ job fires at 03:00 UTC daily (scheduler).
 *   2. The scheduler job finds all ClickHouse-plan workspaces and enqueues
 *      one per-workspace drain job each.
 *   3. Each per-workspace job:
 *        a. Reads form_funnel_events from Postgres in batches of 10k,
 *           cursor-paginated on (occurred_at, id).
 *        b. Inserts each batch into ClickHouse via JSONEachRow.
 *        c. Optionally deletes the drained rows (DRAIN_DELETE_SOURCE=true).
 *        d. Upserts workspace_drain_states with progress + timestamp.
 *   Idempotency: event_id is included in each ClickHouse row.  MergeTree
 *   deduplication on (workspace_id, form_id, occurred_at) + the event_id
 *   column means re-inserting the same rows just overwrites in-place via
 *   the ReplacingMergeTree-equivalent semantics of re-insertion with the
 *   same sort key.  The drain cursor is reset to the lastDrainedAt so a
 *   re-run re-processes only the window that was in progress.
 */
import { Worker, type Job } from 'bullmq'
import { PrismaClient } from '@prisma/client'
import { PrismaPg } from '@prisma/adapter-pg'
import { getRedisConnection } from '../queues/connection.js'
import {
  ANALYTICS_DRAIN_QUEUE_NAME,
  type AnalyticsDrainJob,
  getAnalyticsDrainQueue,
  registerDrainScheduler,
} from '../queues/analytics-drain.queue.js'
import { getClickHouse } from '../lib/clickhouse.js'
import { ensureSchema } from '../core/analytics/clickhouse.schema.js'
import { env } from '../config/env.js'

const BATCH_SIZE = 10_000

const prisma = new PrismaClient({ adapter: new PrismaPg(env.DATABASE_URL) })

// ── Scheduler job ─────────────────────────────────────────────────────────────
// The scheduler job payload has workspaceId = '__scheduler__'.
// It queries Postgres for all clickhouse-plan workspaces and enqueues one
// per-workspace drain job for the window [lastDrainedAt → now].

async function runScheduler(): Promise<void> {
  const now = new Date()
  const defaultFrom = new Date(now.getTime() - 24 * 60 * 60 * 1000) // yesterday

  const workspaces = await prisma.workspace.findMany({
    where: {
      archivedAt: null,
      plan: { analyticsBackend: 'clickhouse' },
    },
    select: {
      id: true,
      drainState: { select: { lastDrainedAt: true } },
    },
  })

  const queue = getAnalyticsDrainQueue()

  for (const ws of workspaces) {
    const from = ws.drainState?.lastDrainedAt ?? defaultFrom
    const jobId = `drain-${ws.id}-${now.toISOString().slice(0, 10)}`
    await queue.add(
      'drain-workspace',
      {
        workspaceId: ws.id,
        fromTimestamp: from.toISOString(),
        toTimestamp: now.toISOString(),
      },
      {
        jobId, // idempotent per workspace per day
      },
    )
  }

  console.info(
    `[analytics-drain] scheduler enqueued ${workspaces.length} workspace drain jobs`,
  )
}

// ── Per-workspace drain job ───────────────────────────────────────────────────

async function runWorkspaceDrain(job: Job<AnalyticsDrainJob>): Promise<void> {
  const { workspaceId, fromTimestamp, toTimestamp } = job.data
  const from = new Date(fromTimestamp)
  const to = new Date(toTimestamp)

  const ch = getClickHouse()
  if (!ch) {
    // Should not happen if scheduler checks plan, but guard defensively.
    console.warn(
      `[analytics-drain] CLICKHOUSE_URL unset; skipping drain for ${workspaceId}`,
    )
    return
  }

  let cursorOccurredAt: Date = from
  let cursorId = '00000000-0000-0000-0000-000000000000'
  let totalInserted = 0
  let lastError: string | null = null

  try {
    while (true) {
      // Batch read with cursor pagination on (occurred_at, id)
      const rows = await prisma.formFunnelEvent.findMany({
        where: {
          form: { workspaceId },
          occurredAt: {
            gte: cursorOccurredAt,
            lte: to,
          },
          // Cursor: skip rows we already processed in this batch window
          OR: [
            { occurredAt: { gt: cursorOccurredAt } },
            { occurredAt: cursorOccurredAt, id: { gt: cursorId } },
          ],
        },
        orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
        take: BATCH_SIZE,
        select: {
          id: true,
          formId: true,
          version: true,
          submissionId: true,
          anonymousToken: true,
          eventName: true,
          pageId: true,
          fieldId: true,
          occurredAt: true,
          ipHash: true,
          userAgentHash: true,
          form: { select: { workspaceId: true } },
        },
      })

      if (rows.length === 0) break

      // Map to ClickHouse row shape
      const chRows = rows.map((r) => ({
        event_id: r.id,
        form_id: r.formId,
        version: r.version,
        submission_id: r.submissionId ?? null,
        anonymous_token: r.anonymousToken,
        event_name: r.eventName,
        page_id: r.pageId ?? null,
        field_id: r.fieldId ?? null,
        occurred_at: r.occurredAt.toISOString().replace('T', ' ').replace('Z', ''),
        ip_hash: r.ipHash ?? null,
        user_agent_hash: r.userAgentHash ?? null,
        workspace_id: r.form.workspaceId,
      }))

      await ch.insert({
        table: 'forms.funnel_events',
        values: chRows,
        format: 'JSONEachRow',
      })

      totalInserted += rows.length

      // Optionally delete source rows (destructive, opt-in)
      if (env.DRAIN_DELETE_SOURCE) {
        const ids = rows.map((r) => r.id)
        await prisma.formFunnelEvent.deleteMany({
          where: { id: { in: ids } },
        })
      }

      // Advance cursor
      const last = rows[rows.length - 1]!
      cursorOccurredAt = last.occurredAt
      cursorId = last.id

      // If we got a full batch, there may be more
      if (rows.length < BATCH_SIZE) break
    }
  } catch (err) {
    lastError = err instanceof Error ? err.message : String(err)
    // Re-throw so BullMQ can retry; state is written in finally
    throw err
  } finally {
    // Upsert drain state regardless of success/failure
    await prisma.workspaceDrainState.upsert({
      where: { workspaceId },
      create: {
        workspaceId,
        lastDrainedAt: lastError ? null : new Date(),
        totalRowsDrained: totalInserted,
        lastError,
      },
      update: {
        lastDrainedAt: lastError ? undefined : new Date(),
        totalRowsDrained: { increment: totalInserted },
        lastError,
      },
    })
  }

  console.info(
    `[analytics-drain] workspace ${workspaceId}: drained ${totalInserted} rows`,
  )
}

// ── Job dispatcher ────────────────────────────────────────────────────────────

async function processJob(job: Job<AnalyticsDrainJob>): Promise<void> {
  if (job.data.workspaceId === '__scheduler__') {
    await runScheduler()
  } else {
    await runWorkspaceDrain(job)
  }
}

// ── Worker bootstrap ──────────────────────────────────────────────────────────

if (!env.ENABLE_ANALYTICS_DRAIN) {
  console.info(
    '[analytics-drain] ENABLE_ANALYTICS_DRAIN is not set; worker will exit without starting.',
  )
  process.exit(0)
}

const ch = getClickHouse()
if (!ch) {
  console.error(
    '[analytics-drain] ENABLE_ANALYTICS_DRAIN=true but CLICKHOUSE_URL is unset. Exiting.',
  )
  process.exit(1)
}

// Ensure CH schema exists before accepting any jobs
await ensureSchema(ch)

// Register the daily cron scheduler job
await registerDrainScheduler()

const worker = new Worker<AnalyticsDrainJob>(
  ANALYTICS_DRAIN_QUEUE_NAME,
  processJob,
  {
    connection: getRedisConnection(),
    concurrency: 2, // scheduler + one workspace drain at a time
  },
)

worker.on('completed', (job) => {
  console.info(`[analytics-drain] job ${job.name} (${job.id}) completed`)
})

worker.on('failed', (job, err) => {
  console.error(
    `[analytics-drain] job ${job?.name} (${job?.id}) failed (attempt ${job?.attemptsMade}): ${err.message}`,
  )
})

worker.on('error', (err) => {
  console.error('[analytics-drain] worker error:', err)
})

const shutdown = async () => {
  console.info('[analytics-drain] shutting down...')
  await worker.close()
  await prisma.$disconnect()
  process.exit(0)
}

process.on('SIGTERM', () => void shutdown())
process.on('SIGINT', () => void shutdown())

console.info('[analytics-drain] started, waiting for jobs...')
