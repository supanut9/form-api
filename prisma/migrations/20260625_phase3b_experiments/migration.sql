-- Phase 3B Wave 3 (L14): A/B experiment tables
-- Applies on top of: 20260620_phase3b_funnel_events

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------

CREATE TYPE "experiment_status" AS ENUM ('draft', 'running', 'stopped');
CREATE TYPE "experiment_metric" AS ENUM ('submit_rate', 'completion_rate', 'payment_conversion');

-- ---------------------------------------------------------------------------
-- form_experiments
-- ---------------------------------------------------------------------------

CREATE TABLE "form_experiments" (
    "id"                UUID             NOT NULL DEFAULT gen_random_uuid(),
    "created_at"        TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"        TIMESTAMPTZ      NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "form_id"           UUID             NOT NULL,
    "name"              TEXT             NOT NULL,
    "hypothesis"        TEXT,
    "status"            "experiment_status" NOT NULL DEFAULT 'draft',
    "primary_metric"    "experiment_metric" NOT NULL,
    "started_at"        TIMESTAMPTZ,
    "stopped_at"        TIMESTAMPTZ,
    "winner_variant_id" UUID,

    CONSTRAINT "form_experiments_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "form_experiments_form_id_status_idx"
    ON "form_experiments"("form_id", "status");

-- Partial unique index: only ONE running experiment per form at a time.
-- Prisma @@unique cannot express WHERE clauses, so this is added raw here.
-- On INSERT/UPDATE that would create a second running row for the same form_id,
-- Postgres raises unique_violation (P2002 in Prisma) — caught and re-thrown as
-- the domain error "another_experiment_running" in ExperimentService.startExperiment.
CREATE UNIQUE INDEX "form_experiments_one_running_per_form"
    ON "form_experiments"("form_id")
    WHERE "status" = 'running';

ALTER TABLE "form_experiments"
    ADD CONSTRAINT "form_experiments_form_id_fkey"
    FOREIGN KEY ("form_id")
    REFERENCES "form_definitions"("id")
    ON DELETE CASCADE;

-- ---------------------------------------------------------------------------
-- form_experiment_variants
-- ---------------------------------------------------------------------------

CREATE TABLE "form_experiment_variants" (
    "id"             UUID        NOT NULL DEFAULT gen_random_uuid(),
    "created_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"     TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "experiment_id"  UUID        NOT NULL,
    "label"          TEXT        NOT NULL,
    "version_id"     UUID        NOT NULL,
    "weight_bps"     INTEGER     NOT NULL,

    CONSTRAINT "form_experiment_variants_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "form_experiment_variants"
    ADD CONSTRAINT "form_experiment_variants_experiment_id_fkey"
    FOREIGN KEY ("experiment_id")
    REFERENCES "form_experiments"("id")
    ON DELETE CASCADE;

ALTER TABLE "form_experiment_variants"
    ADD CONSTRAINT "form_experiment_variants_version_id_fkey"
    FOREIGN KEY ("version_id")
    REFERENCES "form_versions"("id")
    ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------
-- form_experiment_exposures
-- ---------------------------------------------------------------------------

CREATE TABLE "form_experiment_exposures" (
    "id"              UUID        NOT NULL DEFAULT gen_random_uuid(),
    "created_at"      TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "experiment_id"   UUID        NOT NULL,
    "variant_id"      UUID        NOT NULL,
    "anonymous_token" TEXT        NOT NULL,
    "account_id"      TEXT,
    "exposed_at"      TIMESTAMPTZ NOT NULL,

    CONSTRAINT "form_experiment_exposures_pkey" PRIMARY KEY ("id")
);

-- Unique: one exposure per (experiment, anonymous visitor) — prevents re-assignment.
CREATE UNIQUE INDEX "form_experiment_exposures_experiment_id_anonymous_token_key"
    ON "form_experiment_exposures"("experiment_id", "anonymous_token");

CREATE INDEX "form_experiment_exposures_experiment_id_exposed_at_idx"
    ON "form_experiment_exposures"("experiment_id", "exposed_at");

ALTER TABLE "form_experiment_exposures"
    ADD CONSTRAINT "form_experiment_exposures_experiment_id_fkey"
    FOREIGN KEY ("experiment_id")
    REFERENCES "form_experiments"("id")
    ON DELETE CASCADE;

ALTER TABLE "form_experiment_exposures"
    ADD CONSTRAINT "form_experiment_exposures_variant_id_fkey"
    FOREIGN KEY ("variant_id")
    REFERENCES "form_experiment_variants"("id")
    ON DELETE RESTRICT;
