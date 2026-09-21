# Read RPC failover

The optional server-only `CPREDICT_RPC_FALLBACKS_JSON` is an ordered JSON array of
`{name,url,initialCooldownSeconds?}` entries (at most four). The primary identity
is `CPREDICT_RPC_PRIMARY_NAME` (default `alchemy`); supported bounded names are
`alchemy`, `alchemy-2`, `alchemy-3`, `ankr`, `drpc`. Array order defines fallback
priority. Independent credentials need independent names, never duplicate URLs.
`initialCooldownSeconds` (0..86400) keeps a known exhausted node out of startup
probes and business traffic, then requires normal three-probe recovery admission.
URLs must use HTTPS (loopback HTTP is allowed for tests).
Names are bounded; duplicate endpoints are rejected. Never put real values in
tracked files or browser configuration. Empty/unset retains single-provider mode.

`CPREDICT_RPC_PROBE_JSON` is required with backups. It contains a known canonical
`blockNumber`, `blockHash`, `transactionHash`, `receiptBlockNumber`,
`receiptBlockHash`, `logAddress`, `logIndex` (RPC hex quantities/hashes), and
`logBlockSpan` (default100; indexer uses its configured batch size). Log probes
cover the full batch span, not just one receipt block. Valid filters rejected by
a provider-specific range/result limit exclude that log capability; malformed
parameters and contract reverts never trigger fallback. Generate
and verify it with `scripts/rpc/preflight.mjs` after building offchain code. Pass
`CPREDICT_RPC_PREFLIGHT_PRIMARY_URL`, `CPREDICT_RPC_PREFLIGHT_LOG_URL`,
`CPREDICT_RPC_FALLBACKS_JSON`, and a private `CPREDICT_RPC_PREFLIGHT_OUTPUT`
directory via environment, never command-line URL arguments. The preflight only
reads a known Arbitrum Sepolia reference, checks every provider's capability, and
writes a credential-free probe and report. Deployment requires at least two
qualified providers for each capability; omissions remain excluded in that
capability and are recorded explicitly. It submits no transactions.

All non-quarantined providers are checked at startup; failure of a backup does not
prevent another qualified provider from serving traffic. Indexer logs retain the
official log endpoint first. Read, historical, receipt and log capability states
are independent; quota/chain failures isolate all capabilities on that endpoint.
A null receipt stays unknown and is never evidence of a failed transaction.
Canonical ingestion/receipt guards remain authoritative. Cross-provider block
hash disagreement with the process's recent block anchors is rejected. A backup
must not return a head lower than one already exposed by this process.

Timeouts/network/429/5xx/explicit quota errors can fail over. Business reverts and
invalid parameters cannot. Every request uses one total caller budget, split
between candidates, with at most one business attempt per provider. Normal
failures open the circuit after two failures for 60s. Rate limits open it
immediately, respecting Retry-After; repeated quota failures back off 15/30/60min.
Unsupported capabilities back off 5/10/20/40/60min. Workers only qualify
read/history/receipt; metadata only read/history. A recovered healthy backup stops
probing after its third success even when it is not currently selected.
Recovery uses one coalesced probe per node, three successes 30s apart, and at
least five minutes on backup before automatic failback. Probe timers are stopped
on shutdown. No parallel racing or automatic financial operation resend exists.

Application Viem reads and `/v1/rpc` share one pool. Public-site `/rpc` is routed
by Nginx to `/v1/rpc-compat`: single/batch IDs and notifications are retained;
64KiB/64 items, four concurrent items, eight seconds total. Only allowlisted
reads enter failover. Other RPC methods forward to the configured primary once,
without fallback or transport retry. The existing AA gateway, bundler, paymaster
and unknown-submission recovery policy are unchanged. The raw compatibility
route does not forward authorization/cookie headers to providers. Underlying
errors expose only numeric code and validated hex revert data, never messages
that may contain credentials.

Metrics `cpredict_rpc_requests_total`, `cpredict_rpc_duration_seconds`,
`cpredict_rpc_switches_total`, `cpredict_rpc_eligible`, `cpredict_rpc_active`
are exposed through each service's existing metrics endpoint (metadata adds
`/metrics`). Request/latency labels include service/provider/category and bounded RPC method
(`non_read` for other methods); request outcome and switch reason remain sanitized. Metrics do
not imply a configured external notification receiver.

Rollout: retain private config and exact image rollback copies, verify the real
provider preflight, build/test candidate images, test against disposable isolated
Postgres, deploy indexer first and validate checkpoint progression, then app,
metadata and web proxy. Observe at least 30min. Roll back images/config only;
never restore a stale business database or the exhausted old Alchemy key.

## Automatic-claims read budget

Discovery still checks index completeness, lag and canonical hash every 30s.
Only a fully scanned beneficiary with no currently eligible action may sleep
up to ten minutes. Any indexed business-fact count/block change or reorg epoch
wakes the entire historical candidate set, including owners affected by an
owner-less market resolution. Known final-resolution deadlines wake holders at
the deadline even without new events. Full rescan is the backstop. Explicit
preference opt-out remains authoritative; timeout revalidation bypasses sleep.
Identical contract reads share results only within the current scan at one pinned
head. No cross-block RPC response cache or empty-result synthesis is used.
Interrupted/failed scans and owners yielding actions never acquire an idle lease.

Indexer per-block canonical headers, fixed log spans, hash/parent validation,
receipt association and atomic projections remain unchanged. Lower HTTP counts
from batching alone are not a billed-request saving; compare RPC attempts by
method and use provider billing for actual CU accounting.
