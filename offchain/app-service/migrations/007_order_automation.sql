BEGIN;
CREATE TABLE IF NOT EXISTS automatic_claim_preferences (
  chain_id bigint NOT NULL, owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$'),
  enabled boolean NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,owner)
);
CREATE TABLE IF NOT EXISTS automation_transactions (
  id uuid PRIMARY KEY, chain_id bigint NOT NULL, deployment_id text NOT NULL,
  job_key text NOT NULL, owner text NOT NULL, kind text NOT NULL,
  target text NOT NULL, calldata text NOT NULL, signer text NOT NULL,
  requires_claim_preference boolean NOT NULL DEFAULT true,
  nonce numeric(78,0), tx_hash text, raw_transaction text,
  state text NOT NULL CHECK(state IN ('prepared','broadcasting','unknown','confirmed','reverted','cancelled')),
  reserved_wei numeric(78,0) NOT NULL CHECK(reserved_wei>=0),
  receipt_block numeric(78,0), receipt_hash text, broadcast_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(chain_id,signer,nonce)
);
CREATE UNIQUE INDEX IF NOT EXISTS automation_active_job ON automation_transactions(chain_id,deployment_id,job_key)
  WHERE state IN ('prepared','broadcasting','unknown');
CREATE INDEX IF NOT EXISTS automation_owner_history ON automation_transactions(chain_id,owner,created_at DESC);
CREATE TABLE IF NOT EXISTS automation_status (
  chain_id bigint NOT NULL, owner text NOT NULL, reason text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,owner)
);
COMMIT;
