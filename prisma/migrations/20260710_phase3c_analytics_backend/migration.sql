-- Phase 3C L22: analytics backend gate + drain state tracking

-- ---------------------------------------------------------------------------
-- analytics_backend enum
-- ---------------------------------------------------------------------------

CREATE TYPE "analytics_backend" AS ENUM ('postgres', 'clickhouse');

-- ---------------------------------------------------------------------------
-- workspace_plans: add analytics_backend column (default postgres)
-- ---------------------------------------------------------------------------

ALTER TABLE "workspace_plans"
  ADD COLUMN "analytics_backend" "analytics_backend" NOT NULL DEFAULT 'postgres';

-- Business plan gets ClickHouse backend
UPDATE "workspace_plans"
  SET "analytics_backend" = 'clickhouse'
  WHERE "slug" = 'business';

-- ---------------------------------------------------------------------------
-- workspace_drain_states: per-workspace drain progress tracking
-- ---------------------------------------------------------------------------

CREATE TABLE "workspace_drain_states" (
  "workspace_id"      UUID        NOT NULL,
  "last_drained_at"   TIMESTAMPTZ,
  "total_rows_drained" BIGINT     NOT NULL DEFAULT 0,
  "last_error"        TEXT,
  "updated_at"        TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT "workspace_drain_states_pkey" PRIMARY KEY ("workspace_id"),
  CONSTRAINT "workspace_drain_states_workspace_id_fkey"
    FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE CASCADE
);
