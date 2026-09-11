BEGIN;
-- Keep accounting extensions outside the legacy operation JSON so rollback
-- readers can still parse every operation written by the upgraded service.
ALTER TABLE app_operations ADD COLUMN IF NOT EXISTS billing jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE app_quota_carryover ADD COLUMN IF NOT EXISTS billing jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE OR REPLACE VIEW app_quota_operations AS
  SELECT id,subject,idempotency_key,request_hash,created_at,updated_at,state,lane,max_gas_cost,record,billing
  FROM app_operations
  UNION ALL
  SELECT id,subject,idempotency_key,request_hash,created_at,updated_at,state,lane,max_gas_cost,record,billing
  FROM app_quota_carryover;
COMMIT;
