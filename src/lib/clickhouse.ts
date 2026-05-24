/**
 * ClickHouse lazy singleton.
 *
 * Returns null when CLICKHOUSE_URL is unset so the service boots without
 * ClickHouse in development / CI. Callers must guard the null case.
 */
import { createClient, type ClickHouseClient } from '@clickhouse/client'
import { env } from '../config/env.js'

let _client: ClickHouseClient | null | undefined // undefined = not yet initialised

export function getClickHouse(): ClickHouseClient | null {
  if (_client !== undefined) return _client

  if (!env.CLICKHOUSE_URL) {
    _client = null
    return null
  }

  _client = createClient({
    url: env.CLICKHOUSE_URL,
    username: env.CLICKHOUSE_USERNAME ?? 'default',
    password: env.CLICKHOUSE_PASSWORD ?? '',
    database: env.CLICKHOUSE_DATABASE ?? 'forms',
  })

  return _client
}

/** Reset the singleton — used in tests only. */
export function _resetClickHouseForTests(): void {
  _client = undefined
}
