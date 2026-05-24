/**
 * ClickHouse schema for analytics funnel events.
 *
 * Partitioned by month (toYYYYMM(occurred_at)) so the query engine prunes
 * irrelevant month-parts automatically. Ordered by (workspace_id, form_id,
 * occurred_at) to colocate all events for a workspace/form on the same
 * ClickHouse shard and enable efficient range scans on the time axis.
 *
 * TTL: 730 days (2 years) matching the plan's analyticsRetentionDays ceiling.
 */

export const CREATE_TABLE_SQL = `
CREATE TABLE IF NOT EXISTS forms.funnel_events (
  event_id        UUID,
  form_id         UUID,
  version         UInt32,
  submission_id   Nullable(UUID),
  anonymous_token String,
  event_name      LowCardinality(String),
  page_id         Nullable(String),
  field_id        Nullable(String),
  occurred_at     DateTime64(3, 'UTC'),
  ip_hash         Nullable(String),
  user_agent_hash Nullable(String),
  workspace_id    UUID,
  drained_at      DateTime DEFAULT now()
) ENGINE = MergeTree
  PARTITION BY toYYYYMM(occurred_at)
  ORDER BY (workspace_id, form_id, occurred_at)
  TTL occurred_at + INTERVAL 730 DAY DELETE
`

export const CREATE_DATABASE_SQL = `CREATE DATABASE IF NOT EXISTS forms`

/**
 * Idempotently creates the database and table in ClickHouse.
 * Safe to call on every worker startup.
 */
export async function ensureSchema(
  client: import('@clickhouse/client').ClickHouseClient,
): Promise<void> {
  await client.command({ query: CREATE_DATABASE_SQL })
  await client.command({ query: CREATE_TABLE_SQL })
}
