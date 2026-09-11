BEGIN;
-- Retired-deployment records affect admission quotas only. They are never a
-- source for market history, operation recovery, PnL or user activity pages.
CREATE TABLE IF NOT EXISTS app_quota_carryover (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('confirmed','reverted','cancelled')),
  lane text NOT NULL CHECK(lane IN ('exposure','exit')),
  max_gas_cost numeric(78,0) NOT NULL CHECK(max_gas_cost > 0),
  record jsonb NOT NULL
);
CREATE OR REPLACE VIEW app_quota_operations AS
  SELECT id,subject,idempotency_key,request_hash,created_at,updated_at,state,lane,max_gas_cost,record
  FROM app_operations
  UNION ALL
  SELECT id,subject,idempotency_key,request_hash,created_at,updated_at,state,lane,max_gas_cost,record
  FROM app_quota_carryover;
CREATE TABLE IF NOT EXISTS app_deployment_rollover (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  previous_identity text NOT NULL,
  current_identity text NOT NULL,
  archive_schema text NOT NULL,
  switched_at timestamptz NOT NULL DEFAULT now()
);
COMMIT;
