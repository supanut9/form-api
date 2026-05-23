-- Add delivered_at timestamp to form_webhook_deliveries.
-- Populated by the BullMQ worker when a delivery succeeds (2xx response).
ALTER TABLE "form_webhook_deliveries"
  ADD COLUMN "delivered_at" TIMESTAMPTZ;
