ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_window NUMERIC(78, 0);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS rules_hash CHAR(66);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS metadata_uri TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_source_hash CHAR(66);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS resolution_source_uri TEXT;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS early_bird_start NUMERIC(78, 0);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS creator_treasury CHAR(42);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS feature_flags NUMERIC(78, 0);
ALTER TABLE markets ADD COLUMN IF NOT EXISTS primary_filled_units NUMERIC(78, 0) NOT NULL DEFAULT 0;
ALTER TABLE markets ADD COLUMN IF NOT EXISTS primary_payment NUMERIC(78, 0) NOT NULL DEFAULT 0;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'markets'::regclass
      AND conname = 'markets_rules_hash_format'
  ) THEN
    ALTER TABLE markets ADD CONSTRAINT markets_rules_hash_format
      CHECK (rules_hash IS NULL OR rules_hash ~ '^0x[0-9a-fA-F]{64}$');
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'markets'::regclass
      AND conname = 'markets_resolution_source_hash_format'
  ) THEN
    ALTER TABLE markets ADD CONSTRAINT markets_resolution_source_hash_format
      CHECK (
        resolution_source_hash IS NULL
        OR resolution_source_hash ~ '^0x[0-9a-fA-F]{64}$'
      );
  END IF;
END
$$;
