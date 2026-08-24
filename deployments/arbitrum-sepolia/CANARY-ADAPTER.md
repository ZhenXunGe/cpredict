# Canary executor boundary

`npm run canary:arbitrum-sepolia` never embeds a deployer key or silently selects a result. It loads
an absolute `file://` executor adapter supplied by the deployment operator. The adapter must export:

- `inspect({ manifest })`: read-only chain/account/deployment inspection;
- `start(...)` and `resumeStart(...)`: receipt-driven execution of the 21 pre-timeout steps;
- `finish(...)` and `resumeFinish(...)`: the deadline rejection and two timeout settlements.

`inspect` returns environment `ARBITRUM_SEPOLIA_RUNTIME`, `chainId`, current chain `chainTimestamp`,
exactly three distinct accounts with positive native/USDC balance records, a true canonical external-
dependency runtime check, the deployment identity, `paymasterReady`, and the SHA-256 of the reviewed adapter file. `start`
returns the exact pre-timeout step records plus the normal and zero-participant timeout seeds.
`finish` returns the final expected-revert record, reference block, and both complete timeout objects
accepted by `validate-canary-evidence.mjs`.

Every transaction must use the runner's `operationId` as an idempotency key. A resume function must
query receipts and contract state before sending anything; it must never blindly rebroadcast. The
runner writes `STARTING`/`FINISHING` before invoking an adapter, locks the manifest, source manifest,
adapter hash, accounts and deployment identity, and refuses an early finish using the RPC-derived
block timestamp. Local Anvil adapters must not claim `ARBITRUM_SEPOLIA_RUNTIME`.

This interface is intentionally external: the reviewed wallet/KMS implementation and access policy
belong to the deployment environment, not the public repository.
