-- Public permission metadata only. Private keys and enable signatures stay in the browser.
CREATE TABLE IF NOT EXISTS app_trading_sessions (
  id uuid PRIMARY KEY,
  subject text NOT NULL,
  account_id uuid NOT NULL REFERENCES app_accounts(id),
  permission_id text NOT NULL,
  record jsonb NOT NULL,
  UNIQUE(account_id, permission_id)
);
CREATE INDEX IF NOT EXISTS app_trading_sessions_owner ON app_trading_sessions(subject, account_id);
CREATE INDEX IF NOT EXISTS app_operations_session ON app_operations((record->>'sessionId')) WHERE record ? 'sessionId';
