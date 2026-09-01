CREATE TABLE IF NOT EXISTS metadata_challenges (
  challenge_id CHAR(66) PRIMARY KEY,
  chain_id BIGINT NOT NULL,
  factory CHAR(42) NOT NULL,
  creator CHAR(42) NOT NULL,
  rules_hash CHAR(66) NOT NULL,
  nonce CHAR(66) NOT NULL UNIQUE,
  expires_at BIGINT NOT NULL,
  consumed_at BIGINT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT metadata_challenge_hashes CHECK (
    challenge_id ~ '^0x[0-9a-fA-F]{64}$'
    AND rules_hash ~ '^0x[0-9a-fA-F]{64}$'
    AND nonce ~ '^0x[0-9a-fA-F]{64}$'
  )
);

CREATE INDEX IF NOT EXISTS metadata_challenges_expiry_idx
  ON metadata_challenges (expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS market_publications (
  rules_hash CHAR(66) PRIMARY KEY,
  chain_id BIGINT NOT NULL,
  factory CHAR(42) NOT NULL,
  creator CHAR(42) NOT NULL,
  canonical_json TEXT NOT NULL,
  metadata_uri TEXT NOT NULL,
  resolution_source_hash CHAR(66) NOT NULL,
  resolution_source_uri TEXT NOT NULL,
  signature TEXT NOT NULL,
  published_at BIGINT NOT NULL,
  CONSTRAINT market_publication_hashes CHECK (
    rules_hash ~ '^0x[0-9a-fA-F]{64}$'
    AND resolution_source_hash ~ '^0x[0-9a-fA-F]{64}$'
  ),
  CONSTRAINT market_publication_signature CHECK (
    signature ~ '^0x[0-9a-fA-F]{130}$'
  ),
  CONSTRAINT market_publication_canonical_json CHECK (
    octet_length(canonical_json) BETWEEN 2 AND 16384
  )
);

CREATE INDEX IF NOT EXISTS market_publications_creator_idx
  ON market_publications (chain_id, creator, published_at DESC);
