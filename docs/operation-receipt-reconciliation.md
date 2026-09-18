# Confirmed operation receipt reconciliation

The public indexer checks confirmed application operations independently of range `eth_getLogs` ingestion. Operation records are receipt lookup hints, never synthetic trade evidence. This supplements canonical lineage checks, which do not establish range-log completeness.

## Coverage

Every 15 seconds **after the preceding round finishes**, a separate non-overlapping worker checks up to five due operations. While initial unchecked operations remain, rounds resume after one second to drain the startup backlog; the five-operation limit and non-overlap remain unchanged. Supported kinds: primary buy, create market, create/fill/cancel/return listing, resolve, creator void, timeout void, winnings, early bird, principal refund, timeout bonus, settle bond, settle-and-claim bond, claim bond and fees. Unknown, pending, reverted, cancelled and other operation kinds are excluded. Transactions made outside the application's operation journal are not discovered by this worker.

Each operation must match environment/deployment, transaction/block hash, block number, successful EntryPoint UserOperation hash, sender and nonce. Events must match the requested business action. Only decoded events from this deployment's contracts and registered markets, payment transfers, and the exact UserOperation marker in its execution segment are selected. Creating a market can register that market from the trusted factory event. Stored canonical history and the current RPC block hash must agree.

All selected logs are checked, even when a primary business fact already exists. New verified logs trigger an atomic replay of stored projections **in canonical order**, followed by financial fact reprojection. This avoids reopening an already-cancelled listing or overwriting later cumulative values with an earlier event. Conflicting stored evidence fails closed. No checkpoint, application operation, sponsorship budget, signature or chain transaction is changed. Repeated identical receipts do not change projections or epoch.

Automatic replay is bounded to 20,000 raw events, a 5-second lock wait and a 30-second transaction timeout (PostgreSQL 17). A capacity, missing prerequisite, reorganization or projection failure rolls back the whole repair and records an error; use an explicitly planned shadow rebuild for larger history. Readers observe the old or new committed projection. Writers may briefly wait for the repair transaction.

## Evidence and retries

Migration `008_operation_receipts.sql` adds `ledger_operation_receipts`. It records a digest of the operation identity, intent and canonical receipt reference and selected receipt logs, latest result, inserted log count, sanitized error code, attempt count and next-check time. Verified receipts are checked again after ten minutes; changes to these receipt-binding fields become due immediately (routine updatedAt, finality and gas-accounting observations do not). Failures retry with backoff up to 15 minutes, so one bad operation cannot indefinitely starve other work. Initial verification is not a promise of recovery within 15 seconds: queue length, RPC availability and replay limits still apply.

The worker exports `cpredict_indexer_receipt_checks_total`, `cpredict_indexer_receipt_pending`, `cpredict_indexer_receipt_unresolved` and `cpredict_indexer_receipt_last_run_timestamp_seconds` on the existing internal metrics endpoint. Repairs and failures emit sanitized structured logs. Prometheus rule definitions are supplied in `monitoring/prometheus/cpredict-public-site-alerts.yml`; notifications require an existing Prometheus/Alertmanager deployment and are not enabled by merely shipping these definitions.

## Deployment and rollback

Back up the indexer database, apply the additive migration through the migration registry, grant the runtime role access, and then replace only the indexer image. Before accepting, verify receipt queue drainage and error count, advancing checkpoints, original holdings/market totals and unchanged application-operation records. Replay a real backup in an isolated database before using a new projection repair implementation.

Rollback the indexer image if acceptance fails. Leave the additive table in place for compatibility. A verified repair should not be undone by restoring a stale full database over newer user activity. Preserve backup, source manifest, image digest and receipt audit evidence.
