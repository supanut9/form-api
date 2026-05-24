-- Phase 3B Wave 2 (L11): form_funnel_events table.
-- Applies on top of: 20260615_phase3b_payments_experiments_analytics

-- CreateEnum
CREATE TYPE "funnel_event_name" AS ENUM (
    'view',
    'page_enter',
    'page_exit',
    'field_focus',
    'submit_attempt',
    'submit_ok',
    'submit_error'
);

-- CreateTable
CREATE TABLE "form_funnel_events" (
    "id"              UUID         NOT NULL DEFAULT gen_random_uuid(),
    "created_at"      TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "form_id"         UUID         NOT NULL,
    "version"         INTEGER      NOT NULL,
    "submission_id"   UUID,
    "anonymous_token" TEXT         NOT NULL,
    "event_name"      "funnel_event_name" NOT NULL,
    "page_id"         TEXT,
    "field_id"        TEXT,
    "occurred_at"     TIMESTAMPTZ  NOT NULL,
    "ip_hash"         TEXT,
    "user_agent_hash" TEXT,

    CONSTRAINT "form_funnel_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: (form_id, occurred_at) for funnel window queries
CREATE INDEX "form_funnel_events_form_id_occurred_at_idx"
    ON "form_funnel_events"("form_id", "occurred_at");

-- CreateIndex: (form_id, event_name, occurred_at) for per-event aggregations
CREATE INDEX "form_funnel_events_form_id_event_name_occurred_at_idx"
    ON "form_funnel_events"("form_id", "event_name", "occurred_at");

-- CreateIndex: anonymous_token for visitor-level lookups
CREATE INDEX "form_funnel_events_anonymous_token_idx"
    ON "form_funnel_events"("anonymous_token");

-- AddForeignKey: form_id → form_definitions.id; RESTRICT prevents orphan events
ALTER TABLE "form_funnel_events"
    ADD CONSTRAINT "form_funnel_events_form_id_fkey"
    FOREIGN KEY ("form_id")
    REFERENCES "form_definitions"("id")
    ON DELETE RESTRICT;
