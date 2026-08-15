CREATE TABLE IF NOT EXISTS sponsor_budget_global_usage (
  policy_day BIGINT PRIMARY KEY,
  reserved_cost NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_cost >= 0),
  committed_cost NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (committed_cost >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS sponsor_budget_user_usage (
  policy_day BIGINT NOT NULL,
  subject VARCHAR(256) NOT NULL CHECK (length(subject) BETWEEN 1 AND 256),
  reserved_cost NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (reserved_cost >= 0),
  committed_cost NUMERIC(78, 0) NOT NULL DEFAULT 0 CHECK (committed_cost >= 0),
  reserved_create_listing INTEGER NOT NULL DEFAULT 0 CHECK (reserved_create_listing >= 0),
  committed_create_listing INTEGER NOT NULL DEFAULT 0 CHECK (committed_create_listing >= 0),
  reserved_cancel_listing INTEGER NOT NULL DEFAULT 0 CHECK (reserved_cancel_listing >= 0),
  committed_cancel_listing INTEGER NOT NULL DEFAULT 0 CHECK (committed_cancel_listing >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (policy_day, subject)
);

CREATE TABLE IF NOT EXISTS sponsor_budget_leases (
  lease_id UUID PRIMARY KEY,
  policy_day BIGINT NOT NULL,
  subject VARCHAR(256) NOT NULL CHECK (length(subject) BETWEEN 1 AND 256),
  sender CHAR(42) NOT NULL CHECK (sender ~ '^0x[0-9a-f]{40}$'),
  max_cost NUMERIC(78, 0) NOT NULL CHECK (max_cost > 0),
  create_listing_count INTEGER NOT NULL CHECK (create_listing_count >= 0),
  cancel_listing_count INTEGER NOT NULL CHECK (cancel_listing_count >= 0),
  valid_until BIGINT NOT NULL CHECK (valid_until > 0),
  state VARCHAR(16) NOT NULL CHECK (state IN ('reserved', 'committed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (policy_day, subject)
    REFERENCES sponsor_budget_user_usage(policy_day, subject)
);

CREATE INDEX IF NOT EXISTS sponsor_budget_leases_subject_day_idx
  ON sponsor_budget_leases(policy_day, subject, state);
