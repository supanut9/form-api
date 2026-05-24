/**
 * Unit tests for createFunnelReader factory.
 *
 * Verifies backend selection algorithm:
 *  - null workspaceId → Postgres
 *  - plan = postgres → Postgres
 *  - plan = clickhouse + CH client available → ClickHouse
 *  - plan = clickhouse + CH client null (env unset) → Postgres (fallback)
 *  - DB error during plan lookup → Postgres (fallback)
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock @clickhouse/client so FunnelReaderClickHouse can be imported without a real client
vi.mock('@clickhouse/client', () => ({
  createClient: vi.fn(() => ({})),
}))

import { createFunnelReader } from '../../../src/core/analytics/funnel.factory.js'
import { FunnelService } from '../../../src/core/analytics/funnel.service.js'
import { FunnelReaderClickHouse } from '../../../src/core/analytics/funnel.clickhouse.js'
import type { PrismaClient } from '@prisma/client'
import type { ClickHouseClient } from '@clickhouse/client'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildPrisma(planBackend?: 'postgres' | 'clickhouse', throws = false) {
  return {
    workspace: {
      findUnique: throws
        ? vi.fn().mockRejectedValue(new Error('db down'))
        : vi.fn().mockResolvedValue(
            planBackend
              ? { plan: { analyticsBackend: planBackend } }
              : null,
          ),
    },
  } as unknown as PrismaClient
}

const mockCHClient = {} as ClickHouseClient
const nullGetter = (): ClickHouseClient | null => null
const clientGetter = (): ClickHouseClient | null => mockCHClient

const WORKSPACE_ID = 'bbbbbbbb-0000-0000-0000-000000000002'

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createFunnelReader', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('returns FunnelService when workspaceId is null', async () => {
    const prisma = buildPrisma()
    const reader = await createFunnelReader(prisma, nullGetter, null)
    expect(reader).toBeInstanceOf(FunnelService)
    expect(prisma.workspace.findUnique).not.toHaveBeenCalled()
  })

  it('returns FunnelService when workspaceId is undefined', async () => {
    const prisma = buildPrisma()
    const reader = await createFunnelReader(prisma, nullGetter, undefined)
    expect(reader).toBeInstanceOf(FunnelService)
  })

  it('returns FunnelService when plan.analyticsBackend = postgres', async () => {
    const prisma = buildPrisma('postgres')
    const reader = await createFunnelReader(prisma, nullGetter, WORKSPACE_ID)
    expect(reader).toBeInstanceOf(FunnelService)
  })

  it('returns FunnelReaderClickHouse when plan = clickhouse and client available', async () => {
    const prisma = buildPrisma('clickhouse')
    const reader = await createFunnelReader(prisma, clientGetter, WORKSPACE_ID)
    expect(reader).toBeInstanceOf(FunnelReaderClickHouse)
  })

  it('falls back to FunnelService when plan = clickhouse but client is null', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prisma = buildPrisma('clickhouse')
    const reader = await createFunnelReader(prisma, nullGetter, WORKSPACE_ID)
    expect(reader).toBeInstanceOf(FunnelService)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('CLICKHOUSE_URL is unset'),
    )
  })

  it('falls back to FunnelService when workspace row is not found', async () => {
    // findUnique returns null → plan lookup yields undefined backend → postgres
    const prisma = buildPrisma(undefined)
    const reader = await createFunnelReader(prisma, clientGetter, WORKSPACE_ID)
    expect(reader).toBeInstanceOf(FunnelService)
  })

  it('falls back to FunnelService when DB throws during plan lookup', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const prisma = buildPrisma(undefined, /* throws */ true)
    const reader = await createFunnelReader(prisma, clientGetter, WORKSPACE_ID)
    expect(reader).toBeInstanceOf(FunnelService)
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('plan lookup failed'),
      expect.any(Error),
    )
  })
})
