# Cpredict Protocol V1 — Audit Scope and Code Map

## Status

Pre-audit candidate as of 2026-08-08. The code has local build and focused test evidence. It has
not received an independent audit and has not been deployed to Base Sepolia or mainnet. It must
not hold real funds before every release gate in `docs/zh/00-delivery-status.md` is closed.

## In scope

- `src/core`: bounded configuration, emergency epochs, exposure guard, market factory, Full
  deployer, bond and fee escrow.
- `src/market`: shared accounting/state machine and the Full/Clone concrete runtimes.
- `src/marketplace`: escrowed fixed-price sell listings, partial fills and Permit2 witness flow.
- `src/paymaster`: ERC-4337 v0.8 stateful sponsorship Paymaster.
- `src/interfaces`, `src/libraries`, all Foundry tests and Base Sepolia scripts.
- Integration assumptions for canonical USDC, Permit2, EntryPoint, Safe and TimelockController.

The off-chain SDK, canonical-chain indexer/read API, workers, sponsor service and React call examples
are security-relevant integration scope, but are not asset custodians. The complete flagship UI,
reputation/labeling, fiat ramps, OBS and production infrastructure are outside this repository. The
ordinary off-chain lane conditionally skips five PostgreSQL cases, while a separate disposable
PostgreSQL 17.10 lane passes 9/9 with zero skips. That is local real-database evidence only; no
production database, Base, KMS, Bundler or provider runtime claim follows.

## Priority review areas

1. Vault solvency across resolve, creator void, timeout void and all claim orderings.
2. Dynamic remaining-pool rounding under ordering, split and transfer adversaries, including the fact
   that multiple later claimants—not only the final claimant—may receive accumulated atomic remainders.
3. Full/Clone behavioral equivalence, storage layout, fixed implementation and initialization.
4. Factory/deployer CREATE2 domain separation, atomic wiring/rollback, irreversible activation and
   independent verification of the dependency address/runtime-codehash fingerprint.
5. ERC-1155 receiver reentrancy and Marketplace escrow accounting.
6. Exact canonical Permit2 witness suffixes, independent hash vectors, replay and emergency disable.
7. Bond settlement decoupling from principal refunds, zero-participant timeout behavior and
   double-settlement resistance.
8. Fee credit backing and inability of governance to redirect historical credit.
9. Launch Guard conservatism, sync races, cap changes and irreversible retirement.
10. Paymaster typed data including both packed paymaster gas limits, reservation/spend budgets,
    stateful bundler behavior, service commit uncertainty and postOp safety.
11. Timelock/Safe bootstrap roles and removal of temporary deployer authority.
12. Indexer arbitrary-depth common-ancestor recovery, dynamic market discovery and atomic raw/derived
    PostgreSQL rollback; worker simulation/result observability and retry bounds.

## Build

Solidity 0.8.36, Cancun, optimizer 200, viaIR production profile, no CBOR metadata hash. Permit2 is
compiled separately at its upstream exact pragma 0.8.17. Exact revisions are in
`manifests/dependencies.lock`; source/runtime hashes must be regenerated and checked in
`manifests/source-manifest.json` after the remediation is frozen. A pre-remediation manifest is not
candidate evidence.

## Explicit exclusions/deferred features

API settlement, participant-consensus private markets, buyer offers, AMM/CLOB, arbitration,
upgradeability and administrator rescue of principal do not exist in V1. Reviewers should treat
any accidental surface implementing those capabilities as a finding.
