BEGIN;
CREATE TABLE IF NOT EXISTS app_deposits (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  idempotency_key uuid NOT NULL,
  request_hash text NOT NULL,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  token text NOT NULL,
  source text NOT NULL,
  authorization_nonce text NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  state text NOT NULL CHECK(state IN ('awaiting-authorization','awaiting-signature','cancelled')),
  operation_id uuid UNIQUE REFERENCES app_operations(id),
  record jsonb NOT NULL,
  UNIQUE(subject, idempotency_key),
  UNIQUE(token, source, authorization_nonce)
);
CREATE INDEX IF NOT EXISTS app_deposits_account ON app_deposits(account_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS app_deposits_pending ON app_deposits(account_id, expires_at) WHERE state <> 'cancelled';
COMMIT;
