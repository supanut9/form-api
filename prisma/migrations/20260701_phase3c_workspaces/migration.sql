-- Phase 3C – L17: Workspaces schema (nullable workspace_id only; NOT NULL flip deferred to 3C.3)
-- Two-step migration per §10 risk #6: nullable column first → backfill → NOT NULL in 3C.3.

-- ---------------------------------------------------------------------------
-- Workspace role enum
-- ---------------------------------------------------------------------------

CREATE TYPE "workspace_role" AS ENUM ('owner', 'admin', 'editor', 'viewer');

-- ---------------------------------------------------------------------------
-- workspace_plans — plan tier definitions (seeded below)
-- ---------------------------------------------------------------------------

CREATE TABLE "workspace_plans" (
  "id"                        UUID        NOT NULL DEFAULT gen_random_uuid(),
  "created_at"                TIMESTAMPTZ NOT NULL DEFAULT now(),
  "slug"                      TEXT        NOT NULL,
  "name"                      TEXT        NOT NULL,
  "monthly_submission_quota"  INT         NOT NULL,
  "max_forms"                 INT         NOT NULL,
  "max_file_size_mb"          INT         NOT NULL,
  "payments_enabled"          BOOLEAN     NOT NULL DEFAULT false,
  "experiments_enabled"       BOOLEAN     NOT NULL DEFAULT false,
  "analytics_retention_days"  INT         NOT NULL,
  "stripe_price_id"           TEXT,
  CONSTRAINT "workspace_plans_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "workspace_plans_slug_key" ON "workspace_plans"("slug");

-- ---------------------------------------------------------------------------
-- workspaces
-- ---------------------------------------------------------------------------

CREATE TABLE "workspaces" (
  "id"                    UUID        NOT NULL DEFAULT gen_random_uuid(),
  "created_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at"            TIMESTAMPTZ NOT NULL DEFAULT now(),
  "slug"                  TEXT        NOT NULL,
  "name"                  TEXT        NOT NULL,
  "plan_id"               UUID        NOT NULL,
  "stripe_customer_id"    TEXT,
  "created_by_account_id" TEXT        NOT NULL,
  "archived_at"           TIMESTAMPTZ,
  CONSTRAINT "workspaces_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspaces_plan_id_fkey" FOREIGN KEY ("plan_id")
    REFERENCES "workspace_plans"("id") ON DELETE RESTRICT
);

CREATE UNIQUE INDEX "workspaces_slug_key"             ON "workspaces"("slug");
CREATE UNIQUE INDEX "workspaces_stripe_customer_id_key" ON "workspaces"("stripe_customer_id");
CREATE INDEX       "workspaces_plan_id_idx"           ON "workspaces"("plan_id");
CREATE INDEX       "workspaces_created_by_account_id_idx" ON "workspaces"("created_by_account_id");

-- ---------------------------------------------------------------------------
-- workspace_members
-- ---------------------------------------------------------------------------

CREATE TABLE "workspace_members" (
  "workspace_id" UUID               NOT NULL,
  "account_id"   TEXT               NOT NULL,
  "role"         "workspace_role"   NOT NULL,
  "invited_at"   TIMESTAMPTZ        NOT NULL DEFAULT now(),
  "joined_at"    TIMESTAMPTZ,
  CONSTRAINT "workspace_members_pkey" PRIMARY KEY ("workspace_id", "account_id"),
  CONSTRAINT "workspace_members_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE CASCADE
);

CREATE INDEX "workspace_members_account_id_idx" ON "workspace_members"("account_id");

-- ---------------------------------------------------------------------------
-- workspace_invitations
-- ---------------------------------------------------------------------------

CREATE TABLE "workspace_invitations" (
  "id"           UUID             NOT NULL DEFAULT gen_random_uuid(),
  "created_at"   TIMESTAMPTZ      NOT NULL DEFAULT now(),
  "workspace_id" UUID             NOT NULL,
  "email"        TEXT             NOT NULL,
  "role"         "workspace_role" NOT NULL,
  "token_hash"   TEXT             NOT NULL,
  "expires_at"   TIMESTAMPTZ      NOT NULL,
  "accepted_at"  TIMESTAMPTZ,
  CONSTRAINT "workspace_invitations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "workspace_invitations_workspace_id_fkey" FOREIGN KEY ("workspace_id")
    REFERENCES "workspaces"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX "workspace_invitations_token_hash_key" ON "workspace_invitations"("token_hash");
CREATE INDEX       "workspace_invitations_workspace_id_idx" ON "workspace_invitations"("workspace_id");
CREATE INDEX       "workspace_invitations_email_idx"        ON "workspace_invitations"("email");

-- ---------------------------------------------------------------------------
-- Add nullable workspace_id FK to owned tables (NOT NULL flip deferred to 3C.3)
-- ---------------------------------------------------------------------------

ALTER TABLE "form_definitions"
  ADD COLUMN "workspace_id" UUID REFERENCES "workspaces"("id") ON DELETE RESTRICT;
CREATE INDEX "form_definitions_workspace_id_idx" ON "form_definitions"("workspace_id");

ALTER TABLE "form_templates"
  ADD COLUMN IF NOT EXISTS "workspace_id" UUID REFERENCES "workspaces"("id") ON DELETE RESTRICT;
CREATE INDEX IF NOT EXISTS "form_templates_workspace_id_idx" ON "form_templates"("workspace_id");

ALTER TABLE "form_webhooks"
  ADD COLUMN "workspace_id" UUID REFERENCES "workspaces"("id") ON DELETE RESTRICT;
CREATE INDEX "form_webhooks_workspace_id_idx" ON "form_webhooks"("workspace_id");

ALTER TABLE "form_api_tokens"
  ADD COLUMN "workspace_id" UUID REFERENCES "workspaces"("id") ON DELETE RESTRICT;
CREATE INDEX "form_api_tokens_workspace_id_idx" ON "form_api_tokens"("workspace_id");

ALTER TABLE "form_audit_log"
  ADD COLUMN "workspace_id" UUID REFERENCES "workspaces"("id") ON DELETE RESTRICT;
CREATE INDEX "form_audit_log_workspace_id_idx" ON "form_audit_log"("workspace_id");

-- ---------------------------------------------------------------------------
-- Seed default workspace plans
-- The 'business' unlimited tier uses 1_000_000 for max_forms and 100_000 for
-- monthly_submission_quota as practical upper bounds per §3 risk #10.
-- ---------------------------------------------------------------------------

INSERT INTO "workspace_plans"
  ("slug", "name", "monthly_submission_quota", "max_forms", "max_file_size_mb",
   "payments_enabled", "experiments_enabled", "analytics_retention_days", "stripe_price_id")
VALUES
  ('free',     'Free',     100,     10,      5,    false, false, 30,  NULL),
  ('starter',  'Starter',  1000,    50,      20,   true,  false, 90,  NULL),
  ('pro',      'Pro',      10000,   500,     100,  true,  true,  365, NULL),
  ('business', 'Business', 100000,  1000000, 1024, true,  true,  730, NULL)
ON CONFLICT ("slug") DO NOTHING;
