-- Read-model indexes are a release gate: readiness fails closed until this migration is applied.
CREATE INDEX IF NOT EXISTS markets_chain_created_idx
  ON markets (chain_id, created_block DESC, market DESC);

CREATE INDEX IF NOT EXISTS listings_chain_active_updated_idx
  ON listings (chain_id, active, updated_block DESC, listing_id DESC);

CREATE INDEX IF NOT EXISTS fills_listing_block_idx
  ON fills (chain_id, listing_id, block_number DESC, log_index DESC);

CREATE INDEX IF NOT EXISTS positions_owner_updated_idx
  ON positions (chain_id, owner, updated_block DESC, vault, outcome_id)
  WHERE balance > 0;
