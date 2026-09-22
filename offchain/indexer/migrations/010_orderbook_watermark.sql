BEGIN;
CREATE INDEX IF NOT EXISTS orderbook_event_watermark
  ON orderbook_events(chain_id, marketplace, block_number DESC, transaction_index DESC, log_index DESC);
COMMIT;
