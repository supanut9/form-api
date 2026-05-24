-- Phase 3C – L23: Flip workspace_id to NOT NULL on all owned tables.
-- Prerequisite: Run `tsx scripts/3c-backfill-workspaces.ts` first.

-- ---------------------------------------------------------------------------
-- form_definitions
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM form_definitions WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'workspace_id NULL rows remain in form_definitions; run scripts/3c-backfill-workspaces.ts before this migration';
  END IF;
END $$;

ALTER TABLE "form_definitions" ALTER COLUMN "workspace_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- form_templates
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM form_templates WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'workspace_id NULL rows remain in form_templates; run scripts/3c-backfill-workspaces.ts before this migration';
  END IF;
END $$;

ALTER TABLE "form_templates" ALTER COLUMN "workspace_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- form_webhooks
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM form_webhooks WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'workspace_id NULL rows remain in form_webhooks; run scripts/3c-backfill-workspaces.ts before this migration';
  END IF;
END $$;

ALTER TABLE "form_webhooks" ALTER COLUMN "workspace_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- form_api_tokens
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM form_api_tokens WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'workspace_id NULL rows remain in form_api_tokens; run scripts/3c-backfill-workspaces.ts before this migration';
  END IF;
END $$;

ALTER TABLE "form_api_tokens" ALTER COLUMN "workspace_id" SET NOT NULL;

-- ---------------------------------------------------------------------------
-- form_audit_log
-- ---------------------------------------------------------------------------

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM form_audit_log WHERE workspace_id IS NULL) THEN
    RAISE EXCEPTION 'workspace_id NULL rows remain in form_audit_log; run scripts/3c-backfill-workspaces.ts before this migration';
  END IF;
END $$;

ALTER TABLE "form_audit_log" ALTER COLUMN "workspace_id" SET NOT NULL;
