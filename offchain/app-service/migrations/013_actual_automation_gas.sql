BEGIN;
-- Actual receipt charges, never the maximum reservation used by admission.
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS actual_gas_used numeric(78,0) CHECK(actual_gas_used>=0);
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS effective_gas_price numeric(78,0) CHECK(effective_gas_price>=0);
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS actual_gas_cost_wei numeric(78,0) CHECK(actual_gas_cost_wei>=0);
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS gas_checked_at timestamptz;
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS gas_anchor_epoch numeric(78,0);
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS gas_anchor_block numeric(78,0);
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS gas_anchor_hash text;
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS actual_gas_timestamp numeric(78,0);
CREATE INDEX IF NOT EXISTS automation_missing_actual_gas
  ON automation_transactions(chain_id,deployment_id,signer,gas_checked_at,created_at)
  WHERE state IN ('confirmed','reverted') AND actual_gas_cost_wei IS NULL;
CREATE INDEX IF NOT EXISTS automation_gas_environment ON automation_transactions(chain_id,deployment_id,receipt_block,owner)
  WHERE state IN ('confirmed','reverted');
COMMIT;
