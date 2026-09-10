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

The public test site's application process uses the same Prometheus tooling. Add the jobs in
`prometheus/public-site-scrape.example.yml` and rules in `prometheus/cpredict-public-site-alerts.yml`
to the existing host configuration, adjusting the loopback ports and environment labels.
Do not expose `/metrics` or `/readyz` through the public proxy. Wallet addresses, subject IDs,
operation IDs, tokens and signatures are excluded from metric labels. Query paths use registered
route templates. RPC business rejections remain distinct from endpoint availability.

Database sampling includes the full pending/unknown count, oldest pending age and Shanghai weekly
budget reservations, including prior-week pending operations. ETH metric values are approximate
floats for alerting; authenticated reports retain exact integer wei. Missing observations are not
zero balances. Dependency availability and last-success timestamps qualify retained samples.

At deployment, use `promtool check rules` for the application rules and test loss of database,
chain RPC and provider access, policy rejection and recovery delays. Restore each service and
record the observed recovery. These templates and local fault tests do not establish live alert
delivery or provider budget verification; those remain separate acceptance items.
