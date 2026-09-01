CREATE INDEX IF NOT EXISTS markets_chain_state_created_idx
  ON markets (chain_id, state, created_block DESC, market DESC);

CREATE TABLE IF NOT EXISTS activities (
  chain_id BIGINT NOT NULL,
  transaction_hash CHAR(66) NOT NULL,
  log_index INTEGER NOT NULL,
  activity_kind TEXT NOT NULL CHECK (activity_kind IN (
    'market-created',
    'primary-purchased',
    'listing-created',
    'listing-filled',
    'listing-cancelled',
    'terminal-listing-returned',
    'market-resolved',
    'market-voided-creator',
    'market-voided-timeout',
    'winner-claimed',
    'early-bird-claimed',
    'principal-refunded',
    'timeout-bonus-claimed'
  )),
  vault CHAR(42) NOT NULL,
  actor CHAR(42),
  counterparty CHAR(42),
  outcome_id NUMERIC(78, 0),
  listing_id CHAR(66),
  units NUMERIC(78, 0),
  amount NUMERIC(78, 0),
  block_number NUMERIC(78, 0) NOT NULL,
  confirmation_status TEXT NOT NULL CHECK (confirmation_status IN ('provisional', 'confirmed')),
  PRIMARY KEY (chain_id, transaction_hash, log_index)
);

CREATE INDEX IF NOT EXISTS activities_chain_block_idx
  ON activities (chain_id, block_number DESC, transaction_hash DESC, log_index DESC);

CREATE INDEX IF NOT EXISTS activities_chain_vault_block_idx
  ON activities (chain_id, vault, block_number DESC, transaction_hash DESC, log_index DESC);

CREATE TABLE IF NOT EXISTS activity_participants (
  chain_id BIGINT NOT NULL,
  transaction_hash CHAR(66) NOT NULL,
  log_index INTEGER NOT NULL,
  participant CHAR(42) NOT NULL,
  PRIMARY KEY (chain_id, transaction_hash, log_index, participant),
  FOREIGN KEY (chain_id, transaction_hash, log_index)
    REFERENCES activities(chain_id, transaction_hash, log_index)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS activity_participants_owner_idx
  ON activity_participants (chain_id, participant, transaction_hash, log_index);
