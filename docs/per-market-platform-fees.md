# Per-market platform fees

New factories expose `supportsPerMarketPlatformFees()` and
`createMarketWithPlatformFees(params, userSalt, platformRakeShareBps, platformC2CFeeBps)`.
The existing `createMarket(params, userSalt)` ABI remains valid and uses protocol defaults.

The explicit rates are fixed in the market's existing economic snapshot:

- `platformRakeShareBps`: 0–5000 basis points of the creator's terminal rake.
- `platformC2CFeeBps`: 0–200 basis points of gross secondary sales, paid by the seller.

Both full and clone markets support the same bounds, including an explicit zero.
Changes to protocol defaults cannot modify existing markets. SDK and application
creation intents carry the optional `platformFees` object; signed calldata includes
both values. The creation page checks the deployed factory's capability before
offering these fields, and shows the chosen percentages before confirmation.

## Rollout boundary

Updating the website alone cannot add this entry point to an existing immutable
factory. Deploy and verify a new factory with its correctly bound dependencies using
the existing deployment workflow, then publish the matching environment manifest and
service configuration. Preserve access to old markets and their fee snapshots.
Do not advertise per-market editing as active while the selected factory lacks the
capability. This change does not broadcast a contract deployment or modify existing
markets.

## Sponsorship quota update, 2026-09-15

The enabled ctUSD environment's quotas were increased from their existing values by
20. Weekly total is now 2 ETH, with 1.6 ETH for exposure and 0.4 ETH reserved for exits.
Daily project/account/subject operation counts are 4000/600/1000 per lane, and the
per-method daily count is 400. Monetary quotas for each identity and lane were also
scaled by 20. The local per-operation reservation ceiling is 0.1 ETH.

The existing ZeroDev project's Arbitrum Sepolia policy was independently increased
from 0.1 to 2 ETH/week and from 0.001 to 0.02 ETH/transaction and verified after a page
reload. Provider and local per-operation limits remain distinct. Callback validation,
failure handling, and reset windows are unchanged. The application configuration was
applied using the existing application image; no database or contract deployment was
performed for this quota update. Runtime evidence is in the restricted
`runtime/public-site/quota-20x-deployment/` directory.
