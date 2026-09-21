BEGIN;
ALTER TABLE automation_transactions
  ADD COLUMN IF NOT EXISTS canonical_status text NOT NULL DEFAULT 'unchecked'
    CHECK(canonical_status IN ('unchecked','canonical','orphaned'));
ALTER TABLE automation_transactions
  ADD COLUMN IF NOT EXISTS canonical_checked_at timestamptz;
CREATE INDEX IF NOT EXISTS automation_canonical_audit
  ON automation_transactions(chain_id,deployment_id,signer,canonical_checked_at)
  WHERE state='confirmed';
COMMIT;
