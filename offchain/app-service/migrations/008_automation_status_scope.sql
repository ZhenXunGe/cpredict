BEGIN;
CREATE TABLE IF NOT EXISTS automation_lane_status (
  chain_id bigint NOT NULL,
  deployment_id text NOT NULL,
  lane text NOT NULL CHECK(lane IN ('claims','matching')),
  owner text NOT NULL CHECK(owner ~ '^0x[0-9a-f]{40}$'),
  reason text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,deployment_id,lane,owner)
);
CREATE INDEX IF NOT EXISTS automation_lane_status_reason
  ON automation_lane_status(chain_id,deployment_id,lane,reason);
COMMIT;
