-- Incremental upgrade of an existing deployment. Never reinterpret old state
-- numbers or invent event/outcome deadlines that the old contract did not have.
BEGIN;
DO $$
DECLARE legacy_schema boolean;
BEGIN
  SELECT NOT EXISTS (
    SELECT FROM information_schema.columns
    WHERE table_schema=current_schema() AND table_name='markets' AND column_name='created_at'
  ) INTO legacy_schema;
  ALTER TABLE markets ADD COLUMN IF NOT EXISTS protocol_version TEXT NOT NULL DEFAULT 'time-v2';
  ALTER TABLE markets ADD COLUMN IF NOT EXISTS created_at NUMERIC(20,0);
  ALTER TABLE markets ADD COLUMN IF NOT EXISTS event_starts_at NUMERIC(20,0);
  ALTER TABLE markets ADD COLUMN IF NOT EXISTS outcome_deadline_at NUMERIC(20,0);
  ALTER TABLE markets ADD COLUMN IF NOT EXISTS early_bird_start NUMERIC(78,0);
  ALTER TABLE markets ADD COLUMN IF NOT EXISTS void_reason SMALLINT NOT NULL DEFAULT 0;
  IF legacy_schema THEN
    UPDATE markets SET protocol_version='legacy-v1',
      void_reason=CASE state WHEN 2 THEN 1 WHEN 3 THEN 3 ELSE 0 END;
  END IF;
END $$;
ALTER TABLE markets DROP CONSTRAINT IF EXISTS markets_state_check;
ALTER TABLE markets DROP CONSTRAINT IF EXISTS markets_terminal_reason;
ALTER TABLE markets ADD CONSTRAINT markets_terminal_reason CHECK (
  (protocol_version='time-v2' AND (
    (state IN (0,1) AND void_reason=0) OR (state=2 AND void_reason BETWEEN 1 AND 3)
  )) OR (protocol_version='legacy-v1' AND (
    (state IN (0,1) AND void_reason=0) OR (state=2 AND void_reason=1) OR (state=3 AND void_reason=3)
  ))
);
COMMIT;
