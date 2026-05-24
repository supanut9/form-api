/**
 * Unit tests for FunnelReaderClickHouse.
 *
 * @clickhouse/client is mocked — no real ClickHouse connection required.
 * Asserts query shape, param binding, and result mapping.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock @clickhouse/client
// ---------------------------------------------------------------------------

const mockQuery = vi.hoisted(() => vi.fn())

vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn(() => ({
    query: mockQuery,
    insert: vi.fn(),
    command: vi.fn(),
  })),
}))

// ---------------------------------------------------------------------------
// Import after mock registration
// ---------------------------------------------------------------------------

import { FunnelReaderClickHouse } from '../../../src/core/analytics/funnel.clickhouse.js'
import type { ClickHouseClient } from '@clickhouse/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(queryResults: Record<string, unknown[]>): ClickHouseClient {
  mockQuery.mockImplementation(({ query }: { query: string }) => {
    // Match on a keyword in the query to return the right fixture
    for (const [key, rows] of Object.entries(queryResults)) {
      if (query.includes(key)) {
        return Promise.resolve({ json: () => Promise.resolve(rows) })
      }
    }
    return Promise.resolve({ json: () => Promise.resolve([]) })
  })
  return { query: mockQuery } as unknown as ClickHouseClient
}

const FORM_ID = 'aaaaaaaa-0000-0000-0000-000000000001'
const FROM = new Date('2026-01-01T00:00:00Z')
const TO = new Date('2026-01-07T00:00:00Z')

// ---------------------------------------------------------------------------
// getFormFunnel
// ---------------------------------------------------------------------------

describe('FunnelReaderClickHouse.getFormFunnel', () => {
  let reader: FunnelReaderClickHouse

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty result for invalid window (from >= to)', async () => {
    const client = makeClient({})
    reader = new FunnelReaderClickHouse(client)
    const result = await reader.getFormFunnel(FORM_ID, {
      from: TO,
      to: FROM,
    })
    expect(result).toEqual({
      visitors: 0,
      pages: [],
      submitAttempts: 0,
      submitOk: 0,
      submitError: 0,
      conversionRate: 0,
    })
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('maps visitor, page, and submit rows to FormFunnelResult', async () => {
    const client = makeClient({
      // Match visitor query by keyword 'view'
      "'view'": [{ cnt: '120' }],
      // Match page query by keyword 'page_enter'
      'page_enter': [
        { page_id: 'p1', event_name: 'page_enter', cnt: '100' },
        { page_id: 'p1', event_name: 'page_exit', cnt: '80' },
        { page_id: 'p2', event_name: 'page_enter', cnt: '60' },
      ],
      // Match submit query by keyword 'submit_attempt'
      'submit_attempt': [
        { event_name: 'submit_attempt', cnt: '50' },
        { event_name: 'submit_ok', cnt: '40' },
        { event_name: 'submit_error', cnt: '10' },
      ],
    })
    reader = new FunnelReaderClickHouse(client)

    const result = await reader.getFormFunnel(FORM_ID, { from: FROM, to: TO })

    expect(result.visitors).toBe(120)
    expect(result.submitAttempts).toBe(50)
    expect(result.submitOk).toBe(40)
    expect(result.submitError).toBe(10)
    expect(result.conversionRate).toBeCloseTo(40 / 120)
    expect(result.pages).toContainEqual({ pageId: 'p1', enter: 100, exit: 80 })
    expect(result.pages).toContainEqual({ pageId: 'p2', enter: 60, exit: 0 })
  })

  it('sends form_id UUID param in every query call', async () => {
    const client = makeClient({ "'view'": [{ cnt: '0' }] })
    reader = new FunnelReaderClickHouse(client)
    await reader.getFormFunnel(FORM_ID, { from: FROM, to: TO })

    const calls = mockQuery.mock.calls as Array<[{ query_params: Record<string, unknown> }]>
    for (const [args] of calls) {
      expect(args.query_params.formId).toBe(FORM_ID)
    }
  })

  it('returns zero conversionRate when visitors = 0', async () => {
    const client = makeClient({ "'view'": [{ cnt: '0' }] })
    reader = new FunnelReaderClickHouse(client)
    const result = await reader.getFormFunnel(FORM_ID, { from: FROM, to: TO })
    expect(result.conversionRate).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getDailyCounts
// ---------------------------------------------------------------------------

describe('FunnelReaderClickHouse.getDailyCounts', () => {
  let reader: FunnelReaderClickHouse

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('returns empty array for invalid window', async () => {
    const client = makeClient({})
    reader = new FunnelReaderClickHouse(client)
    const result = await reader.getDailyCounts(FORM_ID, { from: TO, to: FROM })
    expect(result).toEqual([])
    expect(mockQuery).not.toHaveBeenCalled()
  })

  it('maps daily rows to DailyCount[]', async () => {
    mockQuery.mockResolvedValue({
      json: () =>
        Promise.resolve([
          { day: '2026-01-01', cnt: '50' },
          { day: '2026-01-02', cnt: '75' },
        ]),
    })
    const client = { query: mockQuery } as unknown as ClickHouseClient
    reader = new FunnelReaderClickHouse(client)
    const result = await reader.getDailyCounts(FORM_ID, { from: FROM, to: TO })

    expect(result).toEqual([
      { day: '2026-01-01', count: 50 },
      { day: '2026-01-02', count: 75 },
    ])
  })

  it('includes eventName param in query when provided', async () => {
    mockQuery.mockResolvedValue({ json: () => Promise.resolve([]) })
    const client = { query: mockQuery } as unknown as ClickHouseClient
    reader = new FunnelReaderClickHouse(client)

    await reader.getDailyCounts(FORM_ID, {
      from: FROM,
      to: TO,
      eventName: 'view',
    })

    const [args] = mockQuery.mock.calls[0] as [{ query: string; query_params: Record<string, unknown> }][]
    expect(args.query_params.eventName).toBe('view')
    expect(args.query).toContain('eventName')
  })

  it('omits eventName param from query when not provided', async () => {
    mockQuery.mockResolvedValue({ json: () => Promise.resolve([]) })
    const client = { query: mockQuery } as unknown as ClickHouseClient
    reader = new FunnelReaderClickHouse(client)

    await reader.getDailyCounts(FORM_ID, { from: FROM, to: TO })

    const [args] = mockQuery.mock.calls[0] as [{ query: string; query_params: Record<string, unknown> }][]
    expect(args.query_params).not.toHaveProperty('eventName')
  })
})
