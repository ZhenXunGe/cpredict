BEGIN;
CREATE TABLE IF NOT EXISTS automation_discovery (
  chain_id bigint NOT NULL, deployment_id text NOT NULL,
  epoch bigint NOT NULL, cursor_block numeric(78,0) NOT NULL, cursor_hash text,
  backstop_owner text, backstop_due timestamptz NOT NULL DEFAULT now(),
  last_served_owner text, last_served_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(), reason text,
  PRIMARY KEY(chain_id,deployment_id)
);
CREATE TABLE IF NOT EXISTS automation_claim_scopes (
  chain_id bigint NOT NULL, deployment_id text NOT NULL, owner text NOT NULL,
  scope text NOT NULL, version bigint NOT NULL DEFAULT 1, epoch bigint NOT NULL,
  due_at timestamptz, priority integer NOT NULL DEFAULT 0,
  trigger_at timestamptz NOT NULL, indexed_at timestamptz NOT NULL,
  attempts integer NOT NULL DEFAULT 0, reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,deployment_id,owner,scope)
);
CREATE INDEX IF NOT EXISTS automation_claim_scopes_due
  ON automation_claim_scopes(chain_id,deployment_id,priority,due_at) WHERE due_at IS NOT NULL;
CREATE TABLE IF NOT EXISTS automation_claim_candidates (
  chain_id bigint NOT NULL, deployment_id text NOT NULL, job_key text NOT NULL,
  owner text NOT NULL, scope text NOT NULL, kind text NOT NULL, action jsonb NOT NULL,
  epoch bigint NOT NULL, priority integer NOT NULL,
  state text NOT NULL CHECK(state IN ('ready','deferred','inflight','done','discarded')),
  transaction_id uuid REFERENCES automation_transactions(id),
  trigger_at timestamptz NOT NULL, indexed_at timestamptz NOT NULL,
  queued_at timestamptz NOT NULL DEFAULT now(), next_attempt_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0, reason text, updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(chain_id,deployment_id,job_key)
);
CREATE INDEX IF NOT EXISTS automation_claim_candidates_due
  ON automation_claim_candidates(chain_id,deployment_id,priority,next_attempt_at)
  WHERE state IN ('ready','deferred');
COMMIT;
