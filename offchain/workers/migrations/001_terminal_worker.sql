CREATE TABLE IF NOT EXISTS terminal_worker_attempts (
  chain_id BIGINT NOT NULL CHECK (chain_id > 0),
  market CHAR(42) NOT NULL,
  last_attempt_block NUMERIC(78, 0) NOT NULL,
  results JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, market)
);
