# Final local regression evidence — 2026-08-08

This report records the current local candidate. The single cross-domain status table is
`docs/zh/00-delivery-status.md`; this report must not be read as Base, external-audit, production or
release approval.

## Current executed lanes

| Lane | Result | Exact boundary |
|---|---|---|
| Solidity coverage | PASS | 20 suites, 121/121 tests; production `src/**`: line 100%, function 100%, branch 99.13%; unfiltered raw LCOV: line 80.29%, function 81.07%, branch 76.83% |
| Production gas/size | PASS | 10/10 production-context thresholds; local production-viaIR execution only |
| Off-chain unit/build | PASS with conditional boundary | 79 tests PASS; five PostgreSQL integration cases conditionally skip in the ordinary lane |
| Disposable PostgreSQL 17.10 | PASS | Paymaster 2/2, Indexer 3/3, readiness 4/4; total 9/9, zero skip |
| Requirements matrix | PASS as deterministic traceability artifact | 131 atomic IDs; 52 `implemented_static`, 19 `partial`; remaining statuses remain explicit in the matrix |
| Deployment readiness tooling | PASS (static) | 18/18 deployment-tool tests and 10 alert rules; no deployment or remote write |
| Release provenance tooling | PASS (static) / bundle BLOCKED | 39/39 release-tool tests; fixed 22-gate runner, `release-audit.yml`, GitHub OIDC predicate/attestation and signed-tag external-evidence verification are implemented; real GitHub run/OIDC NOT RUN and required gates still FAIL |
| Security aggregate | FAIL | Slither, Aderyn, Halmos, SMTChecker, Medusa and Echidna arm64 pass; x86_64 Echidna million-call lifecycle and external audits remain open |
| Mutation | ABORTED / PARTIAL / FAIL | Retained FeeVault score is 133/135 with raw rc 143; old full run completed 0/12. Runner lifecycle is hardened and 30/30 focused tests pass, but fresh campaigns are NOT RUN |
| Commercial API load | FAIL | 269,682 2xx, 319 drops, p95 332.99ms, p99 751.55ms |
| 10k WebSocket / current 50 tx/s chain lane | NOT COMPLETED | 20-session focused WS smoke passes; it is not commercial acceptance |
| Base Sepolia / 24-hour canary | BLOCKED / NOT RUN | No address, transaction, block, role or canary runtime evidence |
| External audit / mainnet | NOT RUN | No independent report, fix review, bounty launch, deployment or production approval |

## Security detail

- Slither: current reviewed source-bound gate PASS.
- Aderyn: current official-tool execution and inventory validator PASS.
- Medusa: 1,024,046 calls, 27/27 PASS.
- Halmos: 3/3 bounded arithmetic properties PASS.
- SMTChecker: CHC and BMC each prove 10 expected assertions.
- Echidna: arm64 passes 1,000,053 calls and 4/4 properties. x86_64 executes 1,032 diagnostic calls
  after the harness fix but hangs during coverage persistence, so it is not a full PASS.

## Evidence boundaries

The ordinary off-chain command and the independent PostgreSQL command intentionally report different
boundaries: five cases are conditional in the former, while the dedicated disposable-database lane
runs the Paymaster, Indexer and readiness inventories with zero skips. Likewise, production
`src/**` coverage is the configured release percentage gate; raw unfiltered LCOV retains scripts,
harnesses and helpers for transparency but is not substituted for that slice.

No real release bundle, audit commit, signed tag, Base deployment or production claim is represented
by this report. Release provenance/SBOM tooling passes 39/39 tests and the 22-gate release-audit/tag
attestation path is statically implemented, but real GitHub OIDC/CI has not run and mutation
and load gates do not pass. Bundle creation remains blocked.

## Superseded local evidence

Earlier working-tree runs with 18 suites/106 tests, 99.50% `src/**` line coverage, 44 off-chain tests,
PostgreSQL-only skip evidence, gas threshold failures, Medusa 1,008,355 calls or legacy load numbers
describe older candidates. They remain useful forensic history but are obsolete for current status.
