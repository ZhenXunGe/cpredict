BEGIN;
CREATE TABLE IF NOT EXISTS orderbook_events (
 chain_id bigint NOT NULL, block_number numeric(78,0) NOT NULL, transaction_hash text NOT NULL,
 transaction_index integer NOT NULL, log_index integer NOT NULL, marketplace text NOT NULL,
 event_name text NOT NULL, order_id numeric(78,0), args jsonb NOT NULL,
 PRIMARY KEY(chain_id,transaction_hash,log_index),
 FOREIGN KEY(chain_id,block_number) REFERENCES canonical_blocks(chain_id,block_number) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS orderbook_event_order ON orderbook_events(chain_id,marketplace,order_id,block_number DESC,transaction_index DESC,log_index DESC);
COMMIT;
