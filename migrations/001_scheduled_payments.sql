CREATE TABLE IF NOT EXISTS scheduled_payments (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient VARCHAR(42) NOT NULL,
  amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  label VARCHAR(80),
  interval_hours INTEGER NOT NULL CHECK (interval_hours BETWEEN 1 AND 8760),
  next_run_at TIMESTAMPTZ NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  last_run_at TIMESTAMPTZ,
  last_status VARCHAR(20),
  last_error TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  paused_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS scheduled_payments_due_idx
  ON scheduled_payments (next_run_at)
  WHERE enabled = TRUE AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS scheduled_payments_user_idx
  ON scheduled_payments (user_id, created_at DESC)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS scheduled_payment_runs (
  id UUID PRIMARY KEY,
  scheduled_payment_id UUID NOT NULL REFERENCES scheduled_payments(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient VARCHAR(42) NOT NULL,
  amount NUMERIC(20, 6) NOT NULL CHECK (amount > 0),
  label VARCHAR(80),
  scheduled_for TIMESTAMPTZ NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'complete', 'failed', 'cancelled')),
  attempts INTEGER NOT NULL DEFAULT 0,
  ledger_id UUID REFERENCES ledger(id) ON DELETE SET NULL,
  circle_transaction_id VARCHAR(100),
  tx_hash VARCHAR(66),
  error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  UNIQUE (scheduled_payment_id, scheduled_for)
);

CREATE INDEX IF NOT EXISTS scheduled_payment_runs_work_idx
  ON scheduled_payment_runs (status, created_at);

CREATE INDEX IF NOT EXISTS scheduled_payment_runs_circle_tx_idx
  ON scheduled_payment_runs (circle_transaction_id)
  WHERE circle_transaction_id IS NOT NULL;
