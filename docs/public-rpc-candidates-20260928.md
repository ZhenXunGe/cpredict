# Arbitrum Sepolia public RPC candidates — 2026-09-28

This is a **point-in-time, credential-free candidate inventory**, not the live
service configuration. The probes ran from the Singapore indexer host around
2026-09-28 01:50–02:10 UTC against chain 421614. They checked chain ID, a known
canonical historical block hash, nonempty historical contract code, a matching
transaction receipt, and a known event within a 100-block `eth_getLogs` range.
The second pass also checked historical storage and balance. A passing probe
does not establish sustained throughput, archive coverage at every height,
provider independence, or a service-level guarantee. The existing RPC pool
rechecks each capability at startup and during recovery.

| HTTPS endpoint                                              | Observed capabilities                                                                                                      | Operator disposition                                                                                                                                                                                                                                        |
| ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `https://arbitrum-sepolia.gateway.tenderly.co`              | Historical block, code, storage, balance; receipt; 100-block logs passed twice                                             | First candidate for read-only catch-up; monitor rate limits and lag. [Tenderly's documented node URL includes a key](https://tenderly.co/blog/changelog/tenderly-node-arbitrum-support/), so anonymous access must not be treated as a capacity commitment. |
| `https://421614.rpc.thirdweb.com`                           | Same full probe passed twice                                                                                               | Fallback candidate only. [thirdweb documents client-ID based RPC access](https://portal.thirdweb.com/typescript/v5/client); anonymous capacity is unverified.                                                                                               |
| `https://arbitrum-one-sepolia.gateway.tatum.io`             | Same full probe passed twice, but the indexer's startup 100-block log probe later returned HTTP 429 and isolated this node | Keep only as a conditional fallback; do not count it as sustained capacity. [Tatum documents anonymous limits](https://docs.tatum.io/docs/gateway-limits), including a 100-block maximum for `eth_getLogs`; the current batch is exactly 100 blocks.        |
| `https://api.zan.top/arb-sepolia`                           | Historical state and receipt passed; 100-block logs returned HTTP 429 twice                                                | Do not add to the indexer's full-capability fallback order while this limit persists. [ZAN's documented managed endpoint uses an API key](https://docs.zan.top/reference/api-instructions).                                                                 |
| `https://arbitrum-sepolia.drpc.org`                         | Historical block, receipt and 100-block logs passed; historical code failed                                                | Receipt/log candidate, not a history source. [dRPC public limits](https://drpc.org/docs/howitworks/ratelimiting) are variable.                                                                                                                              |
| `https://sepolia-rollup.arbitrum.io/rpc`                    | Historical block, receipt and 100-block logs passed; historical code failed                                                | Retain as existing preferred log source; not a history source. [Arbitrum chain information](https://docs.arbitrum.io/arbitrum-bridge/quickstart).                                                                                                           |
| `https://arbitrum-sepolia-rpc.publicnode.com`               | Historical block, receipt and 100-block logs passed; historical code failed                                                | Receipt/log candidate only; no archive claim. [PublicNode network page](https://arbitrum.publicnode.com/).                                                                                                                                                  |
| `https://arb-sepolia-testnet.api.pocket.network`            | Receipt passed; historical state failed; log probe alternated between HTTP 500 and success                                 | Exclude from catch-up pool until stable. [Pocket public portal](https://docs.pocket.network/developers/supported-chains/).                                                                                                                                  |
| `https://lb.routeme.sh/rpc/evm/421614`                      | Chain ID probe returned HTTP 429                                                                                           | Exclude until it passes qualification.                                                                                                                                                                                                                      |
| `https://arbitrum-sepolia-rpc.blockreq.com/v1/rpc/public`   | Chain ID and receipt passed; historical block/code and logs returned method-not-found                                      | Exclude from this pool. [BlockReq public endpoint list](https://blockreq.com/docs/build/public-endpoints/).                                                                                                                                                 |
| `https://arbitrum-sepolia.api.onfinality.io/public`         | Chain ID passed; all four capability probes returned HTTP 429 on two attempts                                              | Exclude while throttled. [OnFinality network page](https://www.onfinality.io/en/networks/arbitrum-sepolia).                                                                                                                                                 |
| `https://arbitrum-sepolia.therpc.io`                        | TLS/network connection failed before a JSON-RPC response                                                                   | Exclude.                                                                                                                                                                                                                                                    |
| `https://public.stackup.sh/api/v1/node/arbitrum-sepolia`    | DNS resolution failed from the Singapore host                                                                              | Exclude.                                                                                                                                                                                                                                                    |
| `https://endpoints.omniatech.io/v1/arbitrum/sepolia/public` | HTTP 521 and non-JSON response                                                                                             | Exclude despite its [published endpoint](https://docs.omniatech.io/public-rpc-endpoints).                                                                                                                                                                   |

The screenshot also lists `wss://arbitrum-sepolia.drpc.org` and
`wss://arbitrum-sepolia-rpc.publicnode.com`. Both WebSocket endpoints answered
chain ID, historical block, receipt and 100-block logs, but failed historical
code, matching their HTTPS counterparts. The separately supplied
`wss://arbitrum-sepolia.api.onfinality.io/public-ws` failed to connect. The
current pool accepts HTTPS JSON-RPC only, so WebSocket URLs are not
interchangeable with the entries above. The screenshot's check/cross icons are
site scores and privacy ratings, not results of these capability probes.

For a temporary catch-up, prefer one fully qualified node and separate
qualified fallbacks. Keep the official log endpoint first. Never automatically
resend a transaction because a read fails. Before any runtime change, retain
the prior image and private Compose, confirm the checkpoint, and run the same
capability probe from the deployment host. Afterward watch checkpoint advance,
lag, errors, receipt reconciliation and provider metrics; roll back the config
if the public pool cannot sustain the load. Do not store private RPC keys here.

## Temporary indexer routing observed on 2026-09-28

The indexer was changed alone to use a privately configured dRPC Sepolia URL
with Tenderly and thirdweb as public backups; the official endpoint remains
first for logs. The supplied dRPC URL's original network path did not work;
the Sepolia path passed the read-only capability probe. At indexer startup,
however, dRPC's historical-code probe failed. The pool therefore routed
ordinary contract reads and receipts to dRPC, explicit historical
`eth_getBlockByNumber` reads to Tenderly, and logs to the official endpoint.
This is an **observed capability split**, not a guaranteed per-method routing
policy: if dRPC's history qualification recovers, the existing priority rules
can move block reads back to dRPC. A durable block-header preference requires
its own qualified capability and tests before changing the live indexer.

The indexer-only split deployment adds
`CPREDICT_RPC_PRIMARY_DISABLED_CAPABILITIES_JSON=["history"]` to the indexer
only. This permanently excludes its metered primary from historical reads,
including the high-volume numbered `eth_getBlockByNumber` calls. The public
fallbacks must pass the entire history probe; a failure is surfaced rather
than charged to the primary. Ordinary reads and receipts remain eligible on
the metered primary and a second metered dRPC standby, whose `history`
capability is also disabled. Indexer logs remain official-first. The paid dRPC
historical-code probe failed four of five repeat checks, so it was not a
reliable candidate for this category even before the exclusion. This setting
does not imply that anonymous public throughput is guaranteed.

A second user-supplied, metered dRPC credential was checked without recording
its URL or key here. Its supplied `/arbitrum/` path returned HTTP 403; the
corresponding `/arbitrum-sepolia/` path returned chain ID 421614. On that path,
the known historical block, receipt and 100-block logs matched, while
historical `eth_getCode` returned JSON-RPC `-32000`. It is suitable as a
qualified ordinary-read/receipt standby, with `history` explicitly disabled;
the one-time probe does not establish sustained capacity or a quota balance.
