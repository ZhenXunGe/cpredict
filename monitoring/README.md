# Observability boundary

Metrics and alerts are evidence consumers, not accounting authorities. The USDC balances and
contract storage are authoritative. Indexers must deduplicate by `(chainId, txHash, logIndex)`,
retain block hashes, roll back reorged rows, and label data provisional until the configured
confirmation depth.

Required dashboards: per-vault assets/liabilities/supply; terminal claims; exposure guard headroom;
bond and fee credits; listing lifecycle; sponsor reserve/spend/denial; RPC divergence; indexer lag;
and submitted/included/success/expected-revert transaction rates. Alert routing and Sentry DSNs are
deployment secrets/configuration and are intentionally absent from source.

The checked-in alert rules also require fail-closed signals for runtime-codehash drift, Timelock-role
drift, exit-path synthetic failure, Paymaster deposit floor, and stale Indexer backups. Run
`node scripts/deployment/validate-monitoring-config.mjs` before deployment. A syntactically valid
rule file is only static configuration evidence: alert delivery is runtime-verified only after the
`monitoring.alertDelivery` drill has a durable receipt in the validated operations evidence.
