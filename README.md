# Cpredict Protocol V1

Cpredict is a non-upgradeable, USDC-denominated parimutuel prediction-market
protocol with per-market ERC-1155 positions and a fixed-price, sell-only C2C
marketplace.

The sole product authority is
`/Users/undef1ned/Downloads/product-framework.md` v0.21 (2026-08-04), locked as
31,449 bytes with SHA-256
`5a76a9e0d98691ccc20a1faa37b1607a1d4afd2ca5b17563641cad707ff9aca4` in
`manifests/requirements.lock`. The
repository under `ref/` is ignored and may be consulted only for final-document
presentation; it is not a product, architecture, or implementation source.

This repository is under active implementation and is **not production-ready,
externally audited, deployed, or safe for real funds** until every release gate
in `docs/zh/00-delivery-status.md` is satisfied.

## Local build

Prerequisites: Git, `curl`, macOS Apple Silicon or Linux x86-64, and Node.js 22
for off-chain packages. The bootstrap downloads the exact official Foundry
v1.7.1 release archive and verifies its pinned SHA-256 before extraction.

```bash
bash scripts/bootstrap-foundry.sh
bash scripts/bootstrap-deps.sh
bash scripts/test-all.sh
bash scripts/test-non-ir.sh
npm ci --ignore-scripts
npm run check:offchain
npm run test:offchain
npm run generate:artifacts
npm run check:artifacts
npm run audit:prod
```

The Foundry binary is isolated under `.tools/`; no shell PATH changes are required. The compiler
version/settings and security-tool checksums are recorded in `manifests/`. Foundry may still use
its platform compiler cache, so release evidence must verify the resolved `solc` binary hash in
addition to the version string.

## Deep verification

```bash
# Unfiltered production coverage; fails until 100% line / 100% function / 95% branch.
bash scripts/coverage-full.sh

# Uses the project-local Halmos 0.3.3 environment locked in manifests/halmos-wheels.lock.
bash scripts/security/run-halmos.sh

# Fast parser/schema regression tests; does not execute analyzers or overwrite retained evidence.
npm run test:gate-parsers

# Scans the current Git delivery inventory; findings print only file and pattern, never the value.
npm run scan:secrets

# Safe smoke only; the commercial profile requires the acknowledgement in load/README.md.
bash scripts/load/run-smoke.sh
```

The deep runners validate nonzero execution, exact property/test inventories, report schemas and
reviewed static-analysis baselines before returning success. Security tool artifacts are platform-
and SHA-256-pinned; unsupported platforms fail closed. The official Darwin arm64 Echidna lane now
passes 1,000,053 calls and 4/4 properties. The x86_64/Rosetta lane executes calls after the same
harness fix, but its million-call lifecycle is not closed because the diagnostic hangs while saving
coverage.
The local secret scan covers cached and non-ignored untracked delivery files,
but does not replace a release-time full-history scanner. `npm run check:artifacts` also rejects an
incomplete or stale source manifest; regenerate only after the candidate source has been intentionally frozen.

The single current-candidate status table and proof boundaries are recorded in
`docs/zh/00-delivery-status.md`; tool details remain in their linked reports. Current Solidity
coverage passes its production `src/**` gate (20 suites, 121/121 tests; 100% line, 100% function,
99.13% branch), and the production-context gas/size gate passes 10/10. The ordinary off-chain lane
has 73 passing tests and five PostgreSQL-conditional skips; the separate disposable PostgreSQL 17.10
lane passes 9/9 with zero skips. These are distinct local evidence lanes. The aggregate security gate
still fails because the required x86_64 corroboration and whole-protocol mutation are incomplete,
commercial load acceptance has not passed, and Base/external-audit/production evidence
does not exist. The schema-v4 three-host load/evidence system is statically and fixture verified, but
its formal 500/2,000 RPS, 10,000 simultaneous WebSocket and 50 tx/s run is **NOT RUN**. The commercial
economics evaluator is implemented and unit tested, but the current fail-closed report is
**NOT_VERIFIED (7/7)** because approved thresholds, real Base receipts and independent business data
are absent. See `reports/performance/distributed-commercial-load-system-2026-08-12.md` and
`reports/economics/commercial-economics-gate.md`. Neither workstream changes V1 Solidity behavior.
Do not infer release readiness from any individual PASS.

Release provenance is fail-closed: `.github/workflows/release-audit.yml` executes the fixed 22-gate
policy and only a GitHub-hosted job may attest the external gate index. A signed release tag must name
one successful same-commit audit run using `Release-Audit-Run: <id>`; the tag workflow downloads that
artifact, verifies GitHub OIDC provenance and the strict local predicate, then supplies the verified
external root to bundle build and recheck. This path is statically tested but has not run on GitHub.
The arm64 Echidna release gate now passes; mutation and commercial-load failures still prevent an
attestation.

## Scope

- immutable Full market vaults deployed with CREATE2;
- EIP-1167 Clone vaults with a fixed implementation and lower hard exposure;
- parimutuel primary issuance and deterministic terminal accounting;
- creator resolution, creator void, permissionless timeout void;
- current-holder refunds and original-bettor early-bird credits;
- fixed-price, escrowed, partially fillable C2C listings;
- segregated fee and creator-bond accounting;
- bounded governance, expiring emergency pauses, and launch exposure guard;
- one-time Factory activation with dependency codehash/wiring fingerprint verification;
- canonical Permit2 witness and ERC-4337 authorization surfaces, including both Paymaster gas limits;
- SDK, common-ancestor reorg indexer/read API, single-nonce-lane permissionless workers, runnable
  sponsored-transaction service, React call examples with exact ERC-20/ERC-1155 authorization steps,
  observability, deterministic ABI/selector/storage snapshots, and audit docs.

See `docs/zh/01-contract-design.md` and `docs/en/AUDIT_SCOPE.md` for the
normative design and review boundary.
