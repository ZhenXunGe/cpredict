-- Additive read index only. The existing indexer writer and financial facts are unchanged.
BEGIN;
CREATE INDEX IF NOT EXISTS ledger_facts_discovery_blocks
  ON ledger_facts(chain_id,block_number,transaction_index,log_index,fact_index);
COMMIT;
