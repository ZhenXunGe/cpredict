BEGIN;
ALTER TABLE automation_transactions
  ADD COLUMN IF NOT EXISTS cleanup_market text
    CHECK(cleanup_market IS NULL OR cleanup_market ~ '^0x[0-9a-f]{40}$');
ALTER TABLE automation_transactions
  ADD COLUMN IF NOT EXISTS cleanup_priority text
    CHECK(cleanup_priority IS NULL OR cleanup_priority IN ('terminal-blocking','routine'));
CREATE INDEX IF NOT EXISTS automation_cleanup_owner_24h
  ON automation_transactions(chain_id,deployment_id,owner,created_at DESC)
  WHERE cleanup_market IS NOT NULL AND state<>'cancelled';
CREATE INDEX IF NOT EXISTS automation_cleanup_market_24h
  ON automation_transactions(chain_id,deployment_id,cleanup_market,created_at DESC)
  WHERE cleanup_market IS NOT NULL AND state<>'cancelled';
COMMIT;
