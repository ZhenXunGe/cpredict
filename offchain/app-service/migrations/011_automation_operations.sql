BEGIN;
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS recovery_checked_at timestamptz;
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS first_broadcast_at timestamptz;
ALTER TABLE automation_transactions ADD COLUMN IF NOT EXISTS recovery_manual_required boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS automation_attempts (
  id bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES automation_transactions(id),
  tx_hash text NOT NULL CHECK(tx_hash ~ '^0x[0-9a-f]{64}$'),
  phase text NOT NULL CHECK(phase IN ('validation','broadcast','recovery-check')),
  outcome text NOT NULL CHECK(outcome IN ('validated','rejected','started','accepted','unknown')),
  provider text NOT NULL CHECK(provider ~ '^[a-z][a-z0-9-]{0,31}$'),
  reason text CHECK(reason ~ '^[a-z][a-z0-9_]{0,63}$'),
  rpc_code integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_single_broadcast_attempt
  ON automation_attempts(transaction_id,tx_hash,phase) WHERE phase='broadcast';

CREATE TABLE IF NOT EXISTS automation_recoveries (
  id uuid PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES automation_transactions(id),
  original_hash text NOT NULL CHECK(original_hash ~ '^0x[0-9a-f]{64}$'),
  replacement_hash text NOT NULL CHECK(replacement_hash ~ '^0x[0-9a-f]{64}$'),
  nonce numeric(78,0) NOT NULL,
  original_raw text,
  replacement_raw text,
  reserved_wei numeric(78,0) NOT NULL CHECK(reserved_wei>0),
  mode text NOT NULL CHECK(mode IN ('automatic','manual')),
  authorization_ref text,
  state text NOT NULL CHECK(state IN ('prepared','broadcasting','unknown','confirmed','abandoned')),
  winning_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  broadcast_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(transaction_id,original_hash)
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_one_auto_recovery
  ON automation_recoveries(transaction_id) WHERE mode='automatic';

CREATE TABLE IF NOT EXISTS automation_alert_events (
  id bigserial PRIMARY KEY,
  transaction_id uuid NOT NULL REFERENCES automation_transactions(id),
  tx_hash text NOT NULL,
  chain_id bigint NOT NULL,
  deployment_id text NOT NULL,
  lane text NOT NULL CHECK(lane IN ('claims','matching')),
  signer text NOT NULL,
  nonce numeric(78,0) NOT NULL,
  event text NOT NULL CHECK(event IN ('firing','resolved')),
  started_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  sent_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  last_failure text CHECK(last_failure IN ('delivery_failed')),
  UNIQUE(transaction_id,tx_hash,event)
);
CREATE INDEX IF NOT EXISTS automation_alert_delivery_due
  ON automation_alert_events(next_attempt_at) WHERE sent_at IS NULL;
COMMIT;
