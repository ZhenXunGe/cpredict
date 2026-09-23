-- A constant-time wakeup watermark for the claims worker. Existing facts
-- remain valid and require no backfill.
BEGIN;
ALTER TABLE ledger_environment
  ADD COLUMN IF NOT EXISTS fact_revision bigint NOT NULL DEFAULT 0;
COMMIT;
