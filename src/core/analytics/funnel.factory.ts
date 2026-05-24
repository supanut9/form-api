/**
 * FunnelReaderFactory — selects the analytics backend at runtime.
 *
 * Selection algorithm:
 *  1. Look up the workspace (via workspaceId).  If workspaceId is null/undefined
 *     (legacy non-workspace forms), fall back to Postgres.
 *  2. Load workspace.plan.analyticsBackend.
 *  3. If the plan says 'clickhouse', call getClickHouse():
 *     a. Client available → return FunnelReaderClickHouse.
 *     b. Client is null (CLICKHOUSE_URL unset) → log a warning, fall back to Postgres.
 *  4. Otherwise return the Postgres FunnelService.
 *
 * The factory never throws — analytics queries must never block core UX.
 */
import type { PrismaClient } from '@prisma/client'
import type { ClickHouseClient } from '@clickhouse/client'
import { FunnelService } from './funnel.service.js'
import { FunnelReaderClickHouse } from './funnel.clickhouse.js'

export type FunnelReader = FunnelService | FunnelReaderClickHouse

export async function createFunnelReader(
  prisma: PrismaClient,
  getClickHouse: () => ClickHouseClient | null,
  workspaceId: string | null | undefined,
): Promise<FunnelReader> {
  const pgReader = new FunnelService(prisma)

  // Step 1: no workspace → always Postgres
  if (!workspaceId) {
    return pgReader
  }

  // Step 2: load plan with analyticsBackend
  let backend: 'postgres' | 'clickhouse' = 'postgres'
  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { plan: { select: { analyticsBackend: true } } },
    })
    if (workspace?.plan.analyticsBackend === 'clickhouse') {
      backend = 'clickhouse'
    }
  } catch (err) {
    // DB error during plan lookup — fall back to Postgres safely
    console.warn('[funnel-factory] plan lookup failed, falling back to postgres:', err)
    return pgReader
  }

  // Step 3: try ClickHouse
  if (backend === 'clickhouse') {
    const ch = getClickHouse()
    if (ch) {
      return new FunnelReaderClickHouse(ch)
    }
    // Step 3b: env unset → warn and fall back
    console.warn(
      '[funnel-factory] workspace plan=clickhouse but CLICKHOUSE_URL is unset; ' +
        'falling back to postgres for workspaceId=' + workspaceId,
    )
  }

  return pgReader
}
