CREATE TABLE IF NOT EXISTS permit2_relay_intents (
  intent_id text PRIMARY KEY CHECK (intent_id ~ '^0x[0-9a-f]{64}$'),
  owner text NOT NULL CHECK (owner ~ '^0x[0-9a-f]{40}$'),
  vault text NOT NULL CHECK (vault ~ '^0x[0-9a-f]{40}$'),
  permit_nonce numeric(78, 0) NOT NULL CHECK (permit_nonce >= 0),
  expires_at numeric(78, 0) NOT NULL CHECK (expires_at > 0),
  state text NOT NULL CHECK (state IN ('pending', 'submitted')),
  transaction_hash text CHECK (
    transaction_hash IS NULL OR transaction_hash ~ '^0x[0-9a-f]{64}$'
  ),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  CHECK (
    (state = 'pending' AND transaction_hash IS NULL) OR
    (state = 'submitted' AND transaction_hash IS NOT NULL)
  ),
  UNIQUE (owner, permit_nonce)
);

CREATE INDEX IF NOT EXISTS permit2_relay_intents_owner_created_idx
  ON permit2_relay_intents (owner, created_at DESC);
