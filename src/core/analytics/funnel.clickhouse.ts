/**
 * FunnelReaderClickHouse — ClickHouse-backed funnel aggregation reader.
 *
 * Contract matches FunnelService (funnel.service.ts) exactly so the factory
 * can swap backends at runtime without touching route handlers.
 */
import type { ClickHouseClient } from '@clickhouse/client'
import type {
  FormFunnelResult,
  DailyCount,
  FunnelQueryOptions,
} from './funnel.service.js'

const MAX_WINDOW_DAYS = 90
const MS_PER_DAY = 24 * 60 * 60 * 1000

interface ChVisitorRow {
  cnt: string // ClickHouse returns numbers as strings in JSONEachRow
}

interface ChPageRow {
  page_id: string
  event_name: string
  cnt: string
}

interface ChSubmitRow {
  event_name: string
  cnt: string
}

interface ChDailyRow {
  day: string // 'YYYY-MM-DD'
  cnt: string
}

export class FunnelReaderClickHouse {
  constructor(private readonly client: ClickHouseClient) {}

  // ---------------------------------------------------------------------------
  // getFormFunnel
  // ---------------------------------------------------------------------------

  async getFormFunnel(
    formId: string,
    opts: FunnelQueryOptions,
  ): Promise<FormFunnelResult> {
    const empty: FormFunnelResult = {
      visitors: 0,
      pages: [],
      submitAttempts: 0,
      submitOk: 0,
      submitError: 0,
      conversionRate: 0,
    }

    if (!this.isValidWindow(opts.from, opts.to)) return empty

    const fromTs = opts.from.toISOString().replace('T', ' ').replace('Z', '')
    const toTs = opts.to.toISOString().replace('T', ' ').replace('Z', '')
    const versionClause =
      opts.version != null ? `AND version = ${opts.version}` : ''

    // ── Visitors ──────────────────────────────────────────────────────────────
    const visitorsResult = await this.client.query({
      query: `
        SELECT uniqExact(anonymous_token) AS cnt
        FROM forms.funnel_events
        WHERE form_id = {formId:UUID}
          AND event_name = 'view'
          AND occurred_at >= {from:DateTime64(3,'UTC')}
          AND occurred_at <= {to:DateTime64(3,'UTC')}
          ${versionClause}
      `,
      query_params: { formId, from: fromTs, to: toTs },
      format: 'JSONEachRow',
    })
    const visitorsRows = await visitorsResult.json<ChVisitorRow>()
    const visitors = Number(visitorsRows[0]?.cnt ?? 0)

    // ── Per-page enter/exit ───────────────────────────────────────────────────
    const pageResult = await this.client.query({
      query: `
        SELECT page_id,
               event_name,
               uniqExact(anonymous_token) AS cnt
        FROM forms.funnel_events
        WHERE form_id = {formId:UUID}
          AND event_name IN ('page_enter', 'page_exit')
          AND occurred_at >= {from:DateTime64(3,'UTC')}
          AND occurred_at <= {to:DateTime64(3,'UTC')}
          AND page_id IS NOT NULL
          AND page_id != ''
          ${versionClause}
        GROUP BY page_id, event_name
      `,
      query_params: { formId, from: fromTs, to: toTs },
      format: 'JSONEachRow',
    })
    const pageRows = await pageResult.json<ChPageRow>()

    const pageMap = new Map<string, { enter: number; exit: number }>()
    for (const row of pageRows) {
      if (!row.page_id) continue
      const entry = pageMap.get(row.page_id) ?? { enter: 0, exit: 0 }
      if (row.event_name === 'page_enter') entry.enter = Number(row.cnt)
      if (row.event_name === 'page_exit') entry.exit = Number(row.cnt)
      pageMap.set(row.page_id, entry)
    }
    const pages = Array.from(pageMap.entries()).map(([pageId, v]) => ({
      pageId,
      ...v,
    }))

    // ── Submit aggregates ─────────────────────────────────────────────────────
    const submitResult = await this.client.query({
      query: `
        SELECT event_name,
               uniqExact(anonymous_token) AS cnt
        FROM forms.funnel_events
        WHERE form_id = {formId:UUID}
          AND event_name IN ('submit_attempt', 'submit_ok', 'submit_error')
          AND occurred_at >= {from:DateTime64(3,'UTC')}
          AND occurred_at <= {to:DateTime64(3,'UTC')}
          ${versionClause}
        GROUP BY event_name
      `,
      query_params: { formId, from: fromTs, to: toTs },
      format: 'JSONEachRow',
    })
    const submitRows = await submitResult.json<ChSubmitRow>()

    let submitAttempts = 0
    let submitOk = 0
    let submitError = 0
    for (const row of submitRows) {
      const n = Number(row.cnt)
      if (row.event_name === 'submit_attempt') submitAttempts = n
      if (row.event_name === 'submit_ok') submitOk = n
      if (row.event_name === 'submit_error') submitError = n
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
    if (!this.isValidWindow(opts.from, opts.to)) return []

    const fromTs = opts.from.toISOString().replace('T', ' ').replace('Z', '')
    const toTs = opts.to.toISOString().replace('T', ' ').replace('Z', '')
    const eventClause =
      opts.eventName != null
        ? `AND event_name = {eventName:String}`
        : ''

    const result = await this.client.query({
      query: `
        SELECT toDate(occurred_at) AS day,
               count() AS cnt
        FROM forms.funnel_events
        WHERE form_id = {formId:UUID}
          AND occurred_at >= {from:DateTime64(3,'UTC')}
          AND occurred_at <= {to:DateTime64(3,'UTC')}
          ${eventClause}
        GROUP BY day
        ORDER BY day ASC
      `,
      query_params: {
        formId,
        from: fromTs,
        to: toTs,
        ...(opts.eventName != null ? { eventName: opts.eventName } : {}),
      },
      format: 'JSONEachRow',
    })

    const rows = await result.json<ChDailyRow>()
    return rows.map((r) => ({
      day: String(r.day).slice(0, 10),
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
