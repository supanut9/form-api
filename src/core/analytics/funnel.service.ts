/**
 * FunnelService — Postgres-backed funnel aggregation queries.
 *
 * All queries target the (form_id, event_name, occurred_at) composite index.
 * Window capped at 90 days. ClickHouse drain is Phase 3C.
 */
import type { PrismaClient } from '@prisma/client'

const MAX_WINDOW_DAYS = 90
const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface FormFunnelResult {
  visitors: number
  pages: Array<{ pageId: string; enter: number; exit: number }>
  submitAttempts: number
  submitOk: number
  submitError: number
  conversionRate: number
}

export interface DailyCount {
  day: string   // YYYY-MM-DD
  count: number
}

export interface FunnelQueryOptions {
  from: Date
  to: Date
  version?: number | null
}

export class FunnelService {
  constructor(private readonly prisma: PrismaClient) {}

  // ---------------------------------------------------------------------------
  // getFormFunnel
  // ---------------------------------------------------------------------------

  async getFormFunnel(
    formId: string,
    opts: FunnelQueryOptions,
  ): Promise<FormFunnelResult> {
    const { from, to, version } = opts

    const empty: FormFunnelResult = {
      visitors: 0,
      pages: [],
      submitAttempts: 0,
      submitOk: 0,
      submitError: 0,
      conversionRate: 0,
    }

    if (!this.isValidWindow(from, to)) return empty

    const versionFilter = version != null ? { version } : {}
    const baseWhere = {
      formId,
      occurredAt: { gte: from, lte: to },
      ...versionFilter,
    }

    // ── Visitors: COUNT DISTINCT anonymous_token WHERE event_name = 'view' ─────
    // Prisma doesn't support SELECT COUNT(DISTINCT col) natively; use $queryRaw.
    const [visitorsRow] = await this.prisma.$queryRaw<[{ cnt: bigint }]>`
      SELECT COUNT(DISTINCT anonymous_token)::bigint AS cnt
      FROM form_funnel_events
      WHERE form_id = ${formId}::uuid
        AND event_name = 'view'::"funnel_event_name"
        AND occurred_at >= ${from}
        AND occurred_at <= ${to}
        ${version != null ? this.prisma.$queryRaw`AND version = ${version}` : this.prisma.$queryRaw``}
    `
    const visitors = Number(visitorsRow?.cnt ?? 0)

    // ── Per-page enter / exit ─────────────────────────────────────────────────
    const pageRows = await this.prisma.$queryRaw<
      Array<{ page_id: string; event_name: string; cnt: bigint }>
    >`
      SELECT page_id,
             event_name::text,
             COUNT(DISTINCT anonymous_token)::bigint AS cnt
      FROM form_funnel_events
      WHERE form_id = ${formId}::uuid
        AND event_name IN (
          'page_enter'::"funnel_event_name",
          'page_exit'::"funnel_event_name"
        )
        AND occurred_at >= ${from}
        AND occurred_at <= ${to}
        AND page_id IS NOT NULL
        ${version != null ? this.prisma.$queryRaw`AND version = ${version}` : this.prisma.$queryRaw``}
      GROUP BY page_id, event_name
    `

    const pageMap = new Map<string, { enter: number; exit: number }>()
    for (const row of pageRows) {
      if (!row.page_id) continue
      const entry = pageMap.get(row.page_id) ?? { enter: 0, exit: 0 }
      if (row.event_name === 'page_enter') entry.enter = Number(row.cnt)
      if (row.event_name === 'page_exit')  entry.exit  = Number(row.cnt)
      pageMap.set(row.page_id, entry)
    }
    const pages = Array.from(pageMap.entries()).map(([pageId, v]) => ({
      pageId,
      ...v,
    }))

    // ── Submit aggregates ─────────────────────────────────────────────────────
    const submitRows = await this.prisma.$queryRaw<
      Array<{ event_name: string; cnt: bigint }>
    >`
      SELECT event_name::text,
             COUNT(DISTINCT anonymous_token)::bigint AS cnt
      FROM form_funnel_events
      WHERE form_id = ${formId}::uuid
        AND event_name IN (
          'submit_attempt'::"funnel_event_name",
          'submit_ok'::"funnel_event_name",
          'submit_error'::"funnel_event_name"
        )
        AND occurred_at >= ${from}
        AND occurred_at <= ${to}
        ${version != null ? this.prisma.$queryRaw`AND version = ${version}` : this.prisma.$queryRaw``}
      GROUP BY event_name
    `

    let submitAttempts = 0
    let submitOk = 0
    let submitError = 0
    for (const row of submitRows) {
      const n = Number(row.cnt)
      if (row.event_name === 'submit_attempt') submitAttempts = n
      if (row.event_name === 'submit_ok')      submitOk      = n
      if (row.event_name === 'submit_error')   submitError   = n
    }

    const conversionRate = visitors > 0 ? submitOk / visitors : 0

    return { visitors, pages, submitAttempts, submitOk, submitError, conversionRate }
  }

  // ---------------------------------------------------------------------------
  // getDailyCounts
  // ---------------------------------------------------------------------------

  async getDailyCounts(
    formId: string,
    opts: { from: Date; to: Date; eventName?: string | null },
  ): Promise<DailyCount[]> {
    const { from, to, eventName } = opts

    if (!this.isValidWindow(from, to)) return []

    // Build a type-safe raw query.  We can't compose dynamic SQL fragments
    // cleanly with $queryRaw tagged-template while keeping type safety, so we
    // use a single query with an optional filter via IS NULL / value match.
    const rows = await this.prisma.$queryRaw<Array<{ day: Date; cnt: bigint }>>`
      SELECT DATE_TRUNC('day', occurred_at AT TIME ZONE 'UTC')::date AS day,
             COUNT(*)::bigint AS cnt
      FROM form_funnel_events
      WHERE form_id = ${formId}::uuid
        AND occurred_at >= ${from}
        AND occurred_at <= ${to}
        AND (
          ${eventName != null ? this.prisma.$queryRaw`event_name = ${eventName}::"funnel_event_name"` : this.prisma.$queryRaw`TRUE`}
        )
      GROUP BY DATE_TRUNC('day', occurred_at AT TIME ZONE 'UTC')
      ORDER BY day ASC
    `

    return rows.map((r) => ({
      day: r.day instanceof Date
        ? r.day.toISOString().slice(0, 10)
        : String(r.day).slice(0, 10),
      count: Number(r.cnt),
    }))
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private isValidWindow(from: Date, to: Date): boolean {
    if (!(from instanceof Date) || !(to instanceof Date)) return false
    if (isNaN(from.getTime()) || isNaN(to.getTime())) return false
    if (from >= to) return false
    const windowMs = to.getTime() - from.getTime()
    return windowMs <= MAX_WINDOW_DAYS * MS_PER_DAY
  }
}
