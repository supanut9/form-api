-- Phase 3C L19: workspace billing events table for Stripe subscription idempotency

CREATE TABLE workspace_billing_events (
  id             UUID        NOT NULL DEFAULT gen_random_uuid(),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  workspace_id   UUID        NOT NULL,
  stripe_event_id TEXT       NOT NULL,
  event_type      TEXT       NOT NULL,
  payload_digest  TEXT       NOT NULL,

  CONSTRAINT workspace_billing_events_pkey PRIMARY KEY (id),
  CONSTRAINT workspace_billing_events_stripe_event_id_key UNIQUE (stripe_event_id),
  CONSTRAINT workspace_billing_events_workspace_id_fkey
    FOREIGN KEY (workspace_id) REFERENCES workspaces(id) ON DELETE CASCADE
);

CREATE INDEX workspace_billing_events_workspace_id_created_at_idx
  ON workspace_billing_events (workspace_id, created_at);
