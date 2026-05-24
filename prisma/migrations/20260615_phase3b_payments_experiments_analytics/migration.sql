-- Phase 3B Wave 1 (L10): form_payments table only.
-- experiments + analytics tables will be added in later 3B waves.
-- Applies on top of: 20260601_phase3a_logic_and_templates

-- CreateEnum
CREATE TYPE "form_payment_status" AS ENUM ('pending', 'succeeded', 'failed', 'refunded');

-- CreateTable
CREATE TABLE "form_payments" (
    "id"                        UUID         NOT NULL DEFAULT gen_random_uuid(),
    "created_at"                TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at"                TIMESTAMPTZ  NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "submission_id"             UUID         NOT NULL,
    "stripe_payment_intent_id"  TEXT         NOT NULL,
    "amount_minor"              INTEGER      NOT NULL,
    "currency"                  TEXT         NOT NULL,
    "status"                    "form_payment_status" NOT NULL DEFAULT 'pending',
    "captured_at"               TIMESTAMPTZ,
    "stripe_event_id"           TEXT,
    "stripe_account_id"         TEXT,

    CONSTRAINT "form_payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex: unique on stripe_payment_intent_id
CREATE UNIQUE INDEX "form_payments_stripe_payment_intent_id_key"
    ON "form_payments"("stripe_payment_intent_id");

-- CreateIndex: unique on stripe_event_id (nullable; partial index skips NULLs)
CREATE UNIQUE INDEX "form_payments_stripe_event_id_key"
    ON "form_payments"("stripe_event_id")
    WHERE "stripe_event_id" IS NOT NULL;

-- CreateIndex: btree on submission_id for FK lookups
CREATE INDEX "form_payments_submission_id_idx"
    ON "form_payments"("submission_id");

-- CreateIndex: btree on status for admin list filter
CREATE INDEX "form_payments_status_idx"
    ON "form_payments"("status");

-- AddForeignKey
ALTER TABLE "form_payments"
    ADD CONSTRAINT "form_payments_submission_id_fkey"
    FOREIGN KEY ("submission_id")
    REFERENCES "form_submissions"("id")
    ON DELETE RESTRICT;
