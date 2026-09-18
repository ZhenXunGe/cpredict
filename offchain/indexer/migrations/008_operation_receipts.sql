-- Additive evidence queue. Does not alter operations, budgets, or canonical checkpoints.
CREATE TABLE IF NOT EXISTS ledger_operation_receipts (
  operation_id uuid PRIMARY KEY,
  operation_digest text NOT NULL,
  transaction_hash text NOT NULL,
  block_hash text NOT NULL,
  checked_at timestamptz NOT NULL DEFAULT now(),
  next_check_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('verified','repaired','error')),
  receipt_digest text,
  inserted_logs integer NOT NULL DEFAULT 0,
  attempts integer NOT NULL DEFAULT 0,
  last_error text
);
CREATE INDEX IF NOT EXISTS ledger_operation_receipts_due ON ledger_operation_receipts(next_check_at);
