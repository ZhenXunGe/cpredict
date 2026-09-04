CREATE TABLE IF NOT EXISTS canonical_blocks (
  chain_id BIGINT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash CHAR(66) NOT NULL,
  parent_hash CHAR(66) NOT NULL,
  block_timestamp NUMERIC(78, 0) NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('provisional', 'confirmed')),
  PRIMARY KEY (chain_id, block_number)
);

CREATE UNIQUE INDEX IF NOT EXISTS canonical_blocks_hash_idx
  ON canonical_blocks (chain_id, block_hash);

CREATE TABLE IF NOT EXISTS chain_events (
  chain_id BIGINT NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash CHAR(66) NOT NULL,
  transaction_hash CHAR(66) NOT NULL,
  transaction_index INTEGER NOT NULL,
  log_index INTEGER NOT NULL,
  contract_address CHAR(42) NOT NULL,
  topics JSONB NOT NULL CONSTRAINT chain_events_topics_array CHECK (jsonb_typeof(topics) = 'array'),
  data TEXT NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('provisional', 'confirmed')),
  observed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, transaction_hash, log_index),
  FOREIGN KEY (chain_id, block_number) REFERENCES canonical_blocks(chain_id, block_number)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS chain_events_block_idx
  ON chain_events (chain_id, block_number, transaction_index, log_index);

CREATE TABLE IF NOT EXISTS chain_checkpoints (
  chain_id BIGINT PRIMARY KEY,
  block_number NUMERIC(78, 0) NOT NULL,
  block_hash CHAR(66) NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (chain_id, block_number) REFERENCES canonical_blocks(chain_id, block_number)
    ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS registered_markets (
  chain_id BIGINT NOT NULL,
  market CHAR(42) NOT NULL,
  registered_block NUMERIC(78, 0) NOT NULL,
  transaction_hash CHAR(66) NOT NULL,
  log_index INTEGER NOT NULL,
  PRIMARY KEY (chain_id, market)
);

CREATE TABLE IF NOT EXISTS markets (
  chain_id BIGINT NOT NULL,
  market CHAR(42) NOT NULL,
  creator CHAR(42) NOT NULL,
  deployment_mode SMALLINT NOT NULL,
  outcome_count SMALLINT,
  close_at NUMERIC(78, 0),
  created_at NUMERIC(20, 0),
  event_starts_at NUMERIC(20, 0),
  outcome_deadline_at NUMERIC(20, 0),
  market_primary_cap NUMERIC(78, 0),
  creator_bond NUMERIC(78, 0) NOT NULL,
  state SMALLINT NOT NULL DEFAULT 0 CHECK (state BETWEEN 0 AND 2),
  void_reason SMALLINT NOT NULL DEFAULT 0,
  winning_outcome NUMERIC(78, 0),
  evidence_hash CHAR(66) CONSTRAINT markets_evidence_hash_format
    CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$'),
  created_block NUMERIC(78, 0) NOT NULL,
  updated_block NUMERIC(78, 0) NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('provisional', 'confirmed')),
  PRIMARY KEY (chain_id, market),
  CONSTRAINT markets_terminal_reason CHECK (
    (state IN (0, 1) AND void_reason = 0)
    OR (state = 2 AND void_reason BETWEEN 1 AND 3)
  )
);

CREATE TABLE IF NOT EXISTS listings (
  chain_id BIGINT NOT NULL,
  listing_id CHAR(66) NOT NULL,
  vault CHAR(42) NOT NULL,
  seller CHAR(42) NOT NULL,
  outcome_id NUMERIC(78, 0) NOT NULL,
  remaining_units NUMERIC(78, 0) NOT NULL,
  unit_price NUMERIC(78, 0) NOT NULL,
  expires_at NUMERIC(78, 0) NOT NULL,
  active BOOLEAN NOT NULL,
  created_block NUMERIC(78, 0) NOT NULL,
  updated_block NUMERIC(78, 0) NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('provisional', 'confirmed')),
  PRIMARY KEY (chain_id, listing_id)
);

CREATE INDEX IF NOT EXISTS listings_vault_active_idx
  ON listings (chain_id, vault, active, updated_block DESC, listing_id DESC);

CREATE TABLE IF NOT EXISTS fills (
  chain_id BIGINT NOT NULL,
  transaction_hash CHAR(66) NOT NULL,
  log_index INTEGER NOT NULL,
  listing_id CHAR(66) NOT NULL,
  vault CHAR(42) NOT NULL,
  buyer CHAR(42) NOT NULL,
  seller CHAR(42) NOT NULL,
  filled_units NUMERIC(78, 0) NOT NULL,
  gross NUMERIC(78, 0) NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('provisional', 'confirmed')),
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS fills_vault_block_idx
  ON fills (chain_id, vault, block_number DESC, log_index DESC);

CREATE TABLE IF NOT EXISTS positions (
  chain_id BIGINT NOT NULL,
  vault CHAR(42) NOT NULL,
  owner CHAR(42) NOT NULL,
  outcome_id NUMERIC(78, 0) NOT NULL,
  balance NUMERIC(78, 0) NOT NULL CHECK (balance >= 0),
  updated_block NUMERIC(78, 0) NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('provisional', 'confirmed')),
  PRIMARY KEY (chain_id, vault, owner, outcome_id)
);

CREATE INDEX IF NOT EXISTS positions_owner_idx
  ON positions (chain_id, owner, vault, outcome_id);

CREATE TABLE IF NOT EXISTS claims (
  chain_id BIGINT NOT NULL,
  transaction_hash CHAR(66) NOT NULL,
  log_index INTEGER NOT NULL,
  vault CHAR(42) NOT NULL,
  owner CHAR(42) NOT NULL,
  caller CHAR(42) NOT NULL,
  claim_kind TEXT NOT NULL,
  units NUMERIC(78, 0) NOT NULL,
  amount NUMERIC(78, 0) NOT NULL,
  block_number NUMERIC(78, 0) NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('provisional', 'confirmed')),
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS claims_owner_idx
  ON claims (chain_id, owner, block_number DESC, log_index DESC);
