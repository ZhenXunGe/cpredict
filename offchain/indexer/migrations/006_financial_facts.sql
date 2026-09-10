-- Additive migration. Old readers remain valid; null fees mean not yet backfilled.
BEGIN;
CREATE TABLE IF NOT EXISTS cpredict_environment_identity(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),identity text NOT NULL);
ALTER TABLE fills ADD COLUMN IF NOT EXISTS seller_proceeds NUMERIC(78,0);
ALTER TABLE fills ADD COLUMN IF NOT EXISTS platform_fee NUMERIC(78,0);
ALTER TABLE fills ADD COLUMN IF NOT EXISTS creator_fee NUMERIC(78,0);
CREATE TABLE IF NOT EXISTS ledger_environment (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), identity text NOT NULL,
  projection_version integer NOT NULL DEFAULT 1, epoch bigint NOT NULL DEFAULT 1,
  deployment_block numeric(78,0) NOT NULL, indexed_block numeric(78,0), indexed_hash text,
  coverage_start numeric(78,0), coverage_complete boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'shadow' CHECK(status IN ('shadow','active'))
);
CREATE TABLE IF NOT EXISTS ledger_facts (
  chain_id bigint NOT NULL, block_number numeric(78,0) NOT NULL, transaction_hash char(66) NOT NULL,
  transaction_index integer NOT NULL, log_index integer NOT NULL, fact_index integer NOT NULL,
  occurred_at numeric(78,0) NOT NULL, kind text NOT NULL, market text, owner text, counterparty text,
  projection_version integer NOT NULL DEFAULT 1, fact jsonb NOT NULL,
  PRIMARY KEY(chain_id,transaction_hash,log_index,fact_index,projection_version),
  FOREIGN KEY(chain_id,block_number) REFERENCES canonical_blocks(chain_id,block_number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS ledger_facts_owner ON ledger_facts(owner,block_number,transaction_index,log_index,fact_index);
CREATE INDEX IF NOT EXISTS ledger_facts_counterparty ON ledger_facts(counterparty,block_number,transaction_index,log_index,fact_index);
CREATE INDEX IF NOT EXISTS ledger_facts_market ON ledger_facts(market,block_number,transaction_index,log_index,fact_index);
CREATE TABLE IF NOT EXISTS ledger_tracked_accounts (
  address text PRIMARY KEY, registered_at timestamptz NOT NULL DEFAULT now(),
  from_block numeric(78,0) NOT NULL, through_block numeric(78,0), through_hash text
);
CREATE TABLE IF NOT EXISTS ledger_corrections (
  id bigserial PRIMARY KEY, epoch bigint NOT NULL, from_block numeric(78,0),
  reason text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS leaderboard_periods (
  id text PRIMARY KEY, starts_at numeric(78,0) NOT NULL, ends_at numeric(78,0) NOT NULL,
  market_roster jsonb NOT NULL, published_at numeric(78,0) NOT NULL,
  CHECK(ends_at > starts_at), CHECK(published_at <= starts_at)
);
CREATE TABLE IF NOT EXISTS leaderboard_snapshots (
  id uuid PRIMARY KEY, period_id text REFERENCES leaderboard_periods(id) NOT NULL,
  version integer NOT NULL, block_number numeric(78,0) NOT NULL, block_hash text NOT NULL,
  epoch bigint NOT NULL, snapshot jsonb NOT NULL, input_digest text NOT NULL, corrected_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(period_id,version)
);
CREATE TABLE IF NOT EXISTS public_market_metadata (
  market text PRIMARY KEY, rules_hash text NOT NULL, question text, rules jsonb,
  verified boolean NOT NULL DEFAULT false, checked_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS public_query_snapshots (
  id text PRIMARY KEY, filter text NOT NULL, ledger_snapshot jsonb NOT NULL, items jsonb NOT NULL,
  metadata_pending integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS public_query_snapshot_expiry ON public_query_snapshots(created_at);
CREATE TABLE IF NOT EXISTS ledger_reconciliations (
  id uuid PRIMARY KEY, report jsonb NOT NULL, passed boolean NOT NULL,
  epoch bigint NOT NULL, block_number numeric(78,0) NOT NULL, block_hash text NOT NULL,
  code_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), activated_at timestamptz
);
COMMIT;
