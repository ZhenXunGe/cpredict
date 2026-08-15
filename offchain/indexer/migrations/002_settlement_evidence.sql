ALTER TABLE markets ADD COLUMN IF NOT EXISTS evidence_hash CHAR(66);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'markets'::regclass
      AND conname = 'markets_evidence_hash_format'
  ) THEN
    ALTER TABLE markets ADD CONSTRAINT markets_evidence_hash_format
      CHECK (evidence_hash ~ '^0x[0-9a-fA-F]{64}$');
  END IF;
END
$$;
