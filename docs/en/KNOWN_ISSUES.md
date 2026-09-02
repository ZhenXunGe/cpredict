# Known Issues and Accepted Risks

The single current-candidate status table is `docs/zh/00-delivery-status.md`. Historical execution
reports remain evidence for their own source snapshots but must not override that table.

## Release blockers

- Independent audits and remediation reviews have not occurred.
- Current production `src/**` coverage passes at 100% line, 100% function and 99.15% branch across
  24 suites / 137 tests. The production-context gas/size gate passes 10/10. These local PASS results
  remove the prior percentage/gas blockers but do not close the aggregate release gate.
- A fresh current-input FeeVault mutation run catches 133/135 mutants (98.52%) with raw rc 0,
  validator rc 0, lifecycle PASS and input-snapshot PASS. It is a bounded result, not a whole-protocol
  score. Retained Slither, Aderyn, Halmos, SMTChecker, Echidna and Medusa records are rejected for
  current-input drift. The x86_64/Rosetta diagnostic
  executes 1,032 calls and 4/4 properties after the same harness fix but hangs while saving coverage,
  so its million-call lifecycle remains open. The retained whole-protocol mutation run completed only
  2/12 contracts and has no release score; the current-source FeeVault result is reported separately in
  `reports/security/security-gates.md`.
- Commercial load is not accepted. The schema-v4 three-host SUT/load/chain runners, telemetry,
  source/runtime binding, host-distinctness checks and signed evidence collector are statically and
  fixture verified, but the formal distributed run is **NOT RUN**. The retained same-host schema-v3
  API result remains FAIL at 269,682 2xx responses, 319 dropped iterations, p95 332.99ms and p99
  751.55ms. Later diagnostics do not replace the missing 500/2,000 RPS, 10,000 simultaneously held
  WebSocket, 50 tx/s, reorg, lag and event-latency evidence.
- Commercial economics are **NOT_VERIFIED (7/7)**. The fail-closed BigInt evaluator and its negative
  evidence tests exist, but bond deterrence, micro-pool rake coverage, Full/Clone caps, early-bird
  Sybil concentration, C2C fee liquidity, LaunchGuard retirement and extreme-gas exits lack approved
  thresholds, source/deployment-bound Arbitrum receipts or independently verified business cohorts.
  Micro-pool funding must explicitly select gross rake, protocol fee or creator net after early-bird
  allocation and a committed funding share; it does not assume all rake is available. Evidence
  provenance must end no later than the assessment time and the deployment inventory must match the
  audit commit, addresses and runtime code hashes exactly. These tools do not change V1 Solidity or
  execute governance actions.
- Local ignored acceptance state records a chain-421614 sandbox deployment whose bootstrap is done and
  Factory is active; the orchestrator remains `FINALIZED_PENDING_EVIDENCE_VERIFICATION`. The 15-minute
  three-wallet run completed 47 operations (46 successful transactions and one expected revert),
  including its real-wait timeout path. Phase two completed C1 and F1 with 65 operations (30 receipt-backed
  transactions and 35 expected reverts). The control-plane run records 13 on-chain operations, including
  three expected on-chain reverts. This is complete DEBUG runtime coverage for those scenarios, not a
  `FINALIZED_VERIFIED` manifest, clean source/audit binding, dual-RPC canary or release approval.
- Production KMS/HSM, Bundler, external USDC Paymaster, RPC quorum, indexer HA and incident
  exercises are not integrated. A dedicated disposable PostgreSQL 17.10 lane passes 9/9 with zero
  skips, but it does not prove production TLS, HA, backup or restore behavior.
- Deterministic SPDX 2.3 SBOM/license/notices checks and release tooling pass 39/39 tests, covering
  216 packages. The fixed 22-gate release-audit runner, GitHub OIDC attestation and signed-tag external
  evidence verification path are statically implemented. Real OIDC/CI has not run and required gates
  still fail, so there is no attested release index, bundle, audit commit or tag.
- Legal, jurisdiction, age, sanctions and streaming-platform ToS review is outside engineering scope.
- Two independent audits, both fix-verification rounds, and a funded public bounty have not
  occurred. Procurement and bounty policy drafts are not external security evidence.

## Accepted protocol/product risks

- A creator may build reputation and then deliberately settle a large market dishonestly.
- Per-address caps do not prevent Sybil splitting.
- Post-close C2C trading permits informed or creator-associated traders to trade on private knowledge.
- USDC can pause/blocklist/upgrade; Arbitrum sequencing can halt or reorder within platform guarantees.
- Clone delegatecall/storage risk is higher than Full deployment risk.
- Dynamic remaining-pool recomputation can allocate earlier division remainders to multiple later
  claimants. Ordering, transfers and address splitting can change individual atomic-unit allocation,
  although the aggregate pool remains exactly conserved.
- Launch Guard creates a temporary cross-market primary-buy write hotspot; it is deliberately
  removable and is never consulted for exits.
- External Paymaster availability and policy can fail; it is not in the principal path.
- Only the protocol-registered Marketplace receives enforced terminal-return semantics. Third-party
  custody contracts must implement their own beneficiary accounting before invoking holder claims.

## Remediated internal findings

- High: terminal winner/refund claims could previously burn positions escrowed by the protocol
  Marketplace and strand the resulting USDC there. Vaults now reject the Marketplace as a direct
  claim owner and require permissionless return to the seller first; resolved and void paths have
  regression tests.
- Medium: a timeout bond bonus could recreate user liability after Guard exposure had fallen to
  zero. Bonus funding now synchronizes principal-plus-bonus exposure atomically, and reservations
  fail closed with a protocol error when reported exposure is above the cap.
- High: Paymaster daily budgeting previously omitted already-settled spend from later reservations.
  It now enforces settled plus reserved cost for the policy day.
- Medium (integration availability): the SDK subset previously named non-existent winner/refund
  functions. Names now match `claimWinningsFor` / `refundFor`, and a generated-ABI subset test blocks
  future drift.
- High: creator void previously remained available after the permissionless timeout boundary. It is
  now rejected at and after the deadline, where only `voidAfterDeadline` can establish terminal state.
- Medium: a zero-participant timeout could fund a bond-bonus pool with no claimant or denominator.
  It now emits a dedicated event and credits the creator instead.
- Permit2 now exposes and tests byte-for-byte canonical witness suffixes with independent reference
  vectors. Paymaster signatures now bind both packed paymaster gas limits as well as the account gas
  fields; mutating either header changes the digest.
- Factory market creation is fail-closed until irreversible activation validates dependency code,
  wiring and an independently supplied address/runtime-codehash fingerprint.
- The Indexer now persists every canonical block, finds arbitrary-depth common ancestors, rolls raw
  and derived state back atomically and dynamically discovers Factory markets. The local disposable
  PostgreSQL lane passes; production runtime remains unverified.

See `reports/internal-security-review.md` for impact, proof and residual boundaries. These fixes were
made before any commit, deployment or real-fund use and are not a substitute for external audit.

## Deliberate design decisions and accepted deviations

- The Full runtime is initialized atomically by the Factory after a Factory-only deployer creates
  blank bytecode in the same transaction, rather than by a parameterized constructor. This keeps the
  Factory under EIP-170 while preserving non-interleavable initialization.
- The product decision frozen on 2026-09-02 keeps listing-fill pause for contract-security incidents
  because fills create new buyer exposure. Cancellation, terminal return, direct transfer, claim and
  refund remain available, and the control must not be used for market intervention.
