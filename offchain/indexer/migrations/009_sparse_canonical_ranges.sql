-- Additive mixed-history support for sparse canonical anchors.
-- Existing canonical_blocks rows remain valid and are deliberately retained.
CREATE TABLE IF NOT EXISTS canonical_scan_ranges (
  chain_id BIGINT NOT NULL,
  from_block NUMERIC(78, 0) NOT NULL,
  to_block NUMERIC(78, 0) NOT NULL,
  predecessor_block_number NUMERIC(78, 0),
  predecessor_block_hash CHAR(66),
  end_block_hash CHAR(66) NOT NULL,
  confirmation_status TEXT NOT NULL
    CHECK (confirmation_status IN ('provisional', 'confirmed')),
  canonical_mode TEXT NOT NULL CHECK (canonical_mode IN ('dense', 'sparse')),
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (chain_id, to_block),
  UNIQUE (chain_id, from_block),
  CHECK (from_block <= to_block),
  CHECK (
    (predecessor_block_number IS NULL AND predecessor_block_hash IS NULL)
    OR
    (predecessor_block_number IS NOT NULL AND predecessor_block_hash IS NOT NULL
      AND predecessor_block_number + 1 = from_block)
  ),
  FOREIGN KEY (chain_id, to_block) REFERENCES canonical_blocks(chain_id, block_number)
    ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS canonical_scan_ranges_chain_from_idx
  ON canonical_scan_ranges (chain_id, from_block);

CREATE INDEX IF NOT EXISTS canonical_scan_ranges_chain_scanned_idx
  ON canonical_scan_ranges (chain_id, scanned_at DESC);
