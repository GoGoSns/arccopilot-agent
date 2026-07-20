ALTER TABLE ledger
  ADD COLUMN IF NOT EXISTS circle_transaction_id VARCHAR(100);

CREATE UNIQUE INDEX IF NOT EXISTS ledger_circle_transaction_id_idx
  ON ledger (circle_transaction_id)
  WHERE circle_transaction_id IS NOT NULL;

ALTER TABLE scheduled_payments
  ADD COLUMN IF NOT EXISTS consecutive_failures INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS paused_reason TEXT;

ALTER TABLE scheduled_payment_runs
  ADD COLUMN IF NOT EXISTS circle_transaction_id VARCHAR(100);

CREATE INDEX IF NOT EXISTS scheduled_payment_runs_circle_tx_idx
  ON scheduled_payment_runs (circle_transaction_id)
  WHERE circle_transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS circle_webhook_events (
  notification_id VARCHAR(120) PRIMARY KEY,
  notification_type VARCHAR(80),
  circle_transaction_id VARCHAR(100),
  state VARCHAR(40),
  tx_hash VARCHAR(100),
  payload JSONB NOT NULL,
  matched BOOLEAN NOT NULL DEFAULT FALSE,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS circle_webhook_events_transaction_idx
  ON circle_webhook_events (circle_transaction_id, received_at DESC)
  WHERE circle_transaction_id IS NOT NULL;
