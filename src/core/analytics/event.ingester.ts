/**
 * FunnelIngester — batch write for client-side funnel events.
 *
 * Receives a normalised batch from the public /funnel route, applies
 * time-window guards, and writes surviving rows via a single createMany.
 */
import type { PrismaClient, FunnelEventName } from '@prisma/client'

// Maximum events per batch call.
export const MAX_BATCH_SIZE = 50

// Out-of-window thresholds (milliseconds).
const FUTURE_THRESHOLD_MS = 24 * 60 * 60 * 1000       // 24 h ahead
const PAST_THRESHOLD_MS   = 30 * 24 * 60 * 60 * 1000  // 30 d behind

export interface RawFunnelEvent {
  name: FunnelEventName
  page_id?: string | null
  field_id?: string | null
  occurred_at: string // ISO-8601
  submission_id?: string | null
}

export interface IngestBatchInput {
  formId: string
  version: number
  anonymousToken: string
  ipHash?: string | null
  userAgentHash?: string | null
  events: RawFunnelEvent[]
}

export interface IngestBatchResult {
  accepted: number
  dropped: number
}

export class FunnelIngester {
  constructor(private readonly prisma: PrismaClient) {}

  async ingestBatch(input: IngestBatchInput): Promise<IngestBatchResult> {
    const { formId, version, anonymousToken, ipHash, userAgentHash, events } = input

    // Cap total batch size — drop the tail silently.
    const bounded = events.slice(0, MAX_BATCH_SIZE)
    const overflow = events.length - bounded.length

    const now = Date.now()
    const accepted: Array<{
      formId: string
      version: number
      submissionId: string | null
      anonymousToken: string
      eventName: FunnelEventName
      pageId: string | null
      fieldId: string | null
      occurredAt: Date
      ipHash: string | null
      userAgentHash: string | null
    }> = []

    let dropped = overflow

    for (const ev of bounded) {
      const ts = new Date(ev.occurred_at).getTime()

      // Silently drop events too far in the future or past.
      if (
        Number.isNaN(ts) ||
        ts > now + FUTURE_THRESHOLD_MS ||
        ts < now - PAST_THRESHOLD_MS
      ) {
        dropped++
        continue
      }

      accepted.push({
        formId,
        version,
        submissionId: ev.submission_id ?? null,
        anonymousToken,
        eventName: ev.name,
        pageId: ev.page_id ?? null,
        fieldId: ev.field_id ?? null,
        occurredAt: new Date(ts),
        ipHash: ipHash ?? null,
        userAgentHash: userAgentHash ?? null,
      })
    }

    if (accepted.length > 0) {
      await this.prisma.formFunnelEvent.createMany({
        data: accepted,
        skipDuplicates: true,
      })
    }

    return { accepted: accepted.length, dropped }
  }
}
