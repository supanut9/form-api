-- CreateEnum
CREATE TYPE "form_type" AS ENUM ('main', 'dynamic');

-- CreateEnum
CREATE TYPE "submission_source" AS ENUM ('link', 'sdk', 'iframe', 'api');

-- CreateEnum
CREATE TYPE "submission_status" AS ENUM ('submitted', 'processing', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "api_token_type" AS ENUM ('admin', 'webhook_caller', 'public_read');

-- CreateEnum
CREATE TYPE "webhook_delivery_status" AS ENUM ('pending', 'delivered', 'failed');

-- CreateTable
CREATE TABLE "form_definitions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "type" "form_type" NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT,
    "current_version" INTEGER NOT NULL,
    "owner_account_id" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ,

    CONSTRAINT "form_definitions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "form_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "spec_json" JSONB NOT NULL,
    "schema_hash" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ,
    "published_by" TEXT,
    "is_current" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "form_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_submissions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "form_id" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "account_id" TEXT,
    "anonymous_token" TEXT,
    "payload_jsonb" JSONB NOT NULL,
    "submitted_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ip_hash" TEXT NOT NULL,
    "user_agent" TEXT NOT NULL,
    "source" "submission_source" NOT NULL,
    "status" "submission_status" NOT NULL DEFAULT 'submitted',

    CONSTRAINT "form_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "submission_id" UUID,
    "form_id" UUID,
    "account_id" TEXT,
    "storage_key" TEXT NOT NULL,
    "mime" TEXT NOT NULL,
    "size" BIGINT NOT NULL,
    "sha256" TEXT NOT NULL,

    CONSTRAINT "form_files_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "event_key" TEXT NOT NULL,
    "form_id" UUID NOT NULL,
    "current_version" INTEGER NOT NULL,
    "optional" BOOLEAN NOT NULL DEFAULT false,
    "description" TEXT NOT NULL,

    CONSTRAINT "form_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_event_fills" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "event_key" TEXT NOT NULL,
    "account_id" TEXT,
    "anonymous_token" TEXT,
    "submission_id" UUID NOT NULL,
    "filled_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_event_fills_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_webhooks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "form_id" UUID NOT NULL,
    "url" TEXT NOT NULL,
    "secret_hash" TEXT NOT NULL,
    "events" TEXT[],
    "active" BOOLEAN NOT NULL DEFAULT true,
    "last_delivery_at" TIMESTAMPTZ,

    CONSTRAINT "form_webhooks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_webhook_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "webhook_id" UUID NOT NULL,
    "submission_id" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "status" "webhook_delivery_status" NOT NULL DEFAULT 'pending',
    "response_code" INTEGER,
    "response_body_excerpt" VARCHAR(1024),
    "scheduled_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "form_webhook_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "is_system" BOOLEAN NOT NULL,

    CONSTRAINT "form_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_permission" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "role_id" UUID NOT NULL,
    "action" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "conditions_json" JSONB,

    CONSTRAINT "form_permission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_account_role" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "account_id" TEXT NOT NULL,
    "role_id" UUID NOT NULL,
    "scope_json" JSONB,
    "granted_by" TEXT NOT NULL,
    "granted_at" TIMESTAMPTZ NOT NULL,

    CONSTRAINT "form_account_role_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_session" (
    "id" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "account_id" TEXT NOT NULL,
    "issued_at" TIMESTAMPTZ NOT NULL,
    "expires_at" TIMESTAMPTZ NOT NULL,
    "revoked_at" TIMESTAMPTZ,
    "user_agent" TEXT NOT NULL,
    "ip_hash" TEXT NOT NULL,

    CONSTRAINT "form_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_api_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "type" "api_token_type" NOT NULL,
    "scopes_json" JSONB NOT NULL,
    "expires_at" TIMESTAMPTZ,
    "revoked_at" TIMESTAMPTZ,

    CONSTRAINT "form_api_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_audit_log" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "actor_account_id" TEXT,
    "action" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "diff_json" JSONB,
    "at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "form_rate_limit_state" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL,
    "key" TEXT NOT NULL,
    "window_started_at" TIMESTAMPTZ NOT NULL,
    "count" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "form_rate_limit_state_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "form_definitions_slug_key" ON "form_definitions"("slug");

-- CreateIndex
CREATE INDEX "form_definitions_slug_idx" ON "form_definitions"("slug");

-- CreateIndex
CREATE INDEX "form_definitions_owner_account_id_idx" ON "form_definitions"("owner_account_id");

-- CreateIndex
CREATE INDEX "form_definitions_archived_at_idx" ON "form_definitions"("archived_at");

-- CreateIndex
CREATE INDEX "form_versions_form_id_is_current_idx" ON "form_versions"("form_id", "is_current");

-- CreateIndex
CREATE INDEX "form_versions_form_id_version_idx" ON "form_versions"("form_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "form_versions_form_id_version_key" ON "form_versions"("form_id", "version");

-- CreateIndex
CREATE INDEX "form_submissions_form_id_status_submitted_at_idx" ON "form_submissions"("form_id", "status", "submitted_at");

-- CreateIndex
CREATE INDEX "form_submissions_account_id_idx" ON "form_submissions"("account_id");

-- CreateIndex
CREATE INDEX "form_submissions_anonymous_token_idx" ON "form_submissions"("anonymous_token");

-- CreateIndex
CREATE INDEX "form_submissions_form_id_version_idx" ON "form_submissions"("form_id", "version");

-- CreateIndex
CREATE UNIQUE INDEX "form_files_storage_key_key" ON "form_files"("storage_key");

-- CreateIndex
CREATE INDEX "form_files_submission_id_idx" ON "form_files"("submission_id");

-- CreateIndex
CREATE INDEX "form_files_form_id_idx" ON "form_files"("form_id");

-- CreateIndex
CREATE INDEX "form_files_sha256_idx" ON "form_files"("sha256");

-- CreateIndex
CREATE UNIQUE INDEX "form_events_event_key_key" ON "form_events"("event_key");

-- CreateIndex
CREATE INDEX "form_events_event_key_idx" ON "form_events"("event_key");

-- CreateIndex
CREATE INDEX "form_events_form_id_idx" ON "form_events"("form_id");

-- CreateIndex
CREATE INDEX "form_event_fills_event_key_account_id_idx" ON "form_event_fills"("event_key", "account_id");

-- CreateIndex
CREATE INDEX "form_event_fills_event_key_anonymous_token_idx" ON "form_event_fills"("event_key", "anonymous_token");

-- CreateIndex
CREATE UNIQUE INDEX "form_event_fills_event_key_account_id_key" ON "form_event_fills"("event_key", "account_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_event_fills_event_key_anonymous_token_key" ON "form_event_fills"("event_key", "anonymous_token");

-- CreateIndex
CREATE INDEX "form_webhooks_form_id_active_idx" ON "form_webhooks"("form_id", "active");

-- CreateIndex
CREATE INDEX "form_webhook_deliveries_webhook_id_status_idx" ON "form_webhook_deliveries"("webhook_id", "status");

-- CreateIndex
CREATE INDEX "form_webhook_deliveries_scheduled_at_idx" ON "form_webhook_deliveries"("scheduled_at");

-- CreateIndex
CREATE UNIQUE INDEX "form_role_name_key" ON "form_role"("name");

-- CreateIndex
CREATE INDEX "form_permission_role_id_idx" ON "form_permission"("role_id");

-- CreateIndex
CREATE INDEX "form_account_role_account_id_idx" ON "form_account_role"("account_id");

-- CreateIndex
CREATE INDEX "form_account_role_role_id_idx" ON "form_account_role"("role_id");

-- CreateIndex
CREATE UNIQUE INDEX "form_account_role_account_id_role_id_key" ON "form_account_role"("account_id", "role_id");

-- CreateIndex
CREATE INDEX "form_session_account_id_idx" ON "form_session"("account_id");

-- CreateIndex
CREATE INDEX "form_session_expires_at_idx" ON "form_session"("expires_at");

-- CreateIndex
CREATE INDEX "form_session_revoked_at_idx" ON "form_session"("revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "form_api_tokens_token_hash_key" ON "form_api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "form_api_tokens_token_hash_idx" ON "form_api_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "form_api_tokens_revoked_at_idx" ON "form_api_tokens"("revoked_at");

-- CreateIndex
CREATE INDEX "form_audit_log_actor_account_id_idx" ON "form_audit_log"("actor_account_id");

-- CreateIndex
CREATE INDEX "form_audit_log_subject_type_subject_id_idx" ON "form_audit_log"("subject_type", "subject_id");

-- CreateIndex
CREATE INDEX "form_audit_log_at_idx" ON "form_audit_log"("at");

-- CreateIndex
CREATE INDEX "form_rate_limit_state_key_idx" ON "form_rate_limit_state"("key");

-- CreateIndex
CREATE UNIQUE INDEX "form_rate_limit_state_key_window_started_at_key" ON "form_rate_limit_state"("key", "window_started_at");

-- AddForeignKey
ALTER TABLE "form_versions" ADD CONSTRAINT "form_versions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "form_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "form_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_files" ADD CONSTRAINT "form_files_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "form_submissions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_files" ADD CONSTRAINT "form_files_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "form_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_events" ADD CONSTRAINT "form_events_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "form_definitions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_event_fills" ADD CONSTRAINT "form_event_fills_event_key_fkey" FOREIGN KEY ("event_key") REFERENCES "form_events"("event_key") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_event_fills" ADD CONSTRAINT "form_event_fills_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "form_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_webhooks" ADD CONSTRAINT "form_webhooks_form_id_fkey" FOREIGN KEY ("form_id") REFERENCES "form_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_webhook_deliveries" ADD CONSTRAINT "form_webhook_deliveries_webhook_id_fkey" FOREIGN KEY ("webhook_id") REFERENCES "form_webhooks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_webhook_deliveries" ADD CONSTRAINT "form_webhook_deliveries_submission_id_fkey" FOREIGN KEY ("submission_id") REFERENCES "form_submissions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_permission" ADD CONSTRAINT "form_permission_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "form_role"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "form_account_role" ADD CONSTRAINT "form_account_role_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "form_role"("id") ON DELETE CASCADE ON UPDATE CASCADE;
