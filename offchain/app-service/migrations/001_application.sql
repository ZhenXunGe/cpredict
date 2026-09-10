BEGIN;
CREATE TABLE IF NOT EXISTS cpredict_environment_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),identity text NOT NULL);
CREATE TABLE IF NOT EXISTS app_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  identity text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_control_challenges (
  id uuid PRIMARY KEY, subject text NOT NULL, controller text NOT NULL,
  environment text NOT NULL, deployment_id text NOT NULL, message text NOT NULL,
  expires_at timestamptz NOT NULL, consumed boolean NOT NULL DEFAULT false
);
CREATE INDEX IF NOT EXISTS app_challenge_expiry ON app_control_challenges(expires_at);
CREATE TABLE IF NOT EXISTS app_accounts (
  id uuid PRIMARY KEY, environment text NOT NULL, deployment_id text NOT NULL,
  controller text NOT NULL, address text NOT NULL, record jsonb NOT NULL,
  UNIQUE(environment, deployment_id, controller), UNIQUE(environment, deployment_id, address)
);
CREATE TABLE IF NOT EXISTS app_account_subjects (
  account_id uuid REFERENCES app_accounts(id) NOT NULL, subject text NOT NULL,
  PRIMARY KEY(account_id, subject)
);
CREATE TABLE IF NOT EXISTS app_operations (
  id uuid PRIMARY KEY, subject text NOT NULL, idempotency_key uuid NOT NULL,
  request_hash text NOT NULL, account_id uuid REFERENCES app_accounts(id) NOT NULL,
  sender text NOT NULL, nonce numeric(78,0) NOT NULL, call_hash text NOT NULL,
  state text NOT NULL CHECK(state IN ('preparing','awaiting-signature','submitted','confirming','confirmed','reverted','cancelled','unknown')),
  kind text NOT NULL, lane text NOT NULL CHECK(lane IN ('exposure','exit')),
  created_at timestamptz NOT NULL, updated_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL, max_gas_cost numeric(78,0) NOT NULL CHECK(max_gas_cost > 0),
  record jsonb NOT NULL,
  UNIQUE(subject, idempotency_key)
);
CREATE INDEX IF NOT EXISTS app_operations_recovery ON app_operations(updated_at, id) WHERE state IN ('submitted','confirming','unknown');
CREATE INDEX IF NOT EXISTS app_operations_policy ON app_operations(sender, nonce, call_hash);
CREATE INDEX IF NOT EXISTS app_operations_account ON app_operations(account_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS app_operations_quota ON app_operations(created_at, lane, account_id, subject);
ALTER TABLE app_operations ADD COLUMN IF NOT EXISTS admission_sequence bigserial;
CREATE UNIQUE INDEX IF NOT EXISTS app_operations_sequence ON app_operations(admission_sequence);
CREATE TABLE IF NOT EXISTS app_operation_changes (
  sequence bigserial PRIMARY KEY, operation_id uuid REFERENCES app_operations(id) NOT NULL,
  at timestamptz NOT NULL DEFAULT now(), previous_state text NOT NULL, current_state text NOT NULL,
  reason text, user_operation_hash text, transaction_hash text, block_hash text
);
CREATE TABLE IF NOT EXISTS app_telemetry (
  id uuid PRIMARY KEY, event text NOT NULL CHECK(event IN ('visit','login','account-ready','feedback')),
  occurred_at timestamptz NOT NULL, subject text, account_id uuid REFERENCES app_accounts(id),
  session_id uuid NOT NULL
);
CREATE TABLE IF NOT EXISTS app_feedback (
  id uuid PRIMARY KEY, subject text NOT NULL, account_id uuid REFERENCES app_accounts(id),
  operation_id uuid REFERENCES app_operations(id), message text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS app_service_events (
  sequence bigserial PRIMARY KEY, occurred_at timestamptz NOT NULL DEFAULT now(), code text NOT NULL
);
CREATE INDEX IF NOT EXISTS app_service_events_time ON app_service_events(occurred_at);
CREATE TABLE IF NOT EXISTS app_provider_invoice_lines (
  reference text PRIMARY KEY, starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL,
  amount numeric(24,8) NOT NULL CHECK(amount>=0), currency text NOT NULL,
  CHECK(ends_at>starts_at)
);
COMMIT;
